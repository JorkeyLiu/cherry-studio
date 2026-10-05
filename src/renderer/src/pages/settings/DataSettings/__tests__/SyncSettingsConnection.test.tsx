/**
 * Sync Settings tokenless connection/pairing-waiting regression (zh-CN report
 * follow-up).
 *
 * - There is no shared service access token: no token input, no token state,
 *   no token autosave payload, no token help text, and no 401 access-token
 *   mapper. Connection is server address + device-code request/accept only;
 *   per-device secrets never pass through this component.
 * - Real zh-CN `settings.sync` values carry no `[to be translated]`
 *   placeholders; the pairing prerequisite explains connect -> own code ->
 *   partner code -> accept.
 * - Expected waiting (connected but unpaired/outgoing/incoming, or a durable
 *   narrow `pairing-required` 403) surfaces a localized 等待配对 badge plus a
 *   short next action with the pending count retained — never a sync failure.
 *   Genuine errors (capture errors, any non-pairing-required lastError such as
 *   unknown/invalid-credential) still surface truthfully even when unpaired.
 *   A stale pairing-required lastError observed while live paired is
 *   recovery, not failure.
 * - Unknown device 403 on request stays an error with no silent re-register.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import enUs from '../../../../i18n/locales/en-us.json'
import zhCn from '../../../../i18n/locales/zh-cn.json'
import zhTw from '../../../../i18n/locales/zh-tw.json'
import { isKnownUnpaired, isPairingRequired403, resolveSyncBadge } from '../SyncSettings'

type Dict = Record<string, any>
const dicts: Record<'zh-cn' | 'fallback', Dict | null> = { 'zh-cn': zhCn as Dict, fallback: null }
let activeDict: 'zh-cn' | 'fallback' = 'zh-cn'

function lookup(obj: any, key: string): unknown {
  return key.split('.').reduce((o, part) => (o == null ? o : o[part]), obj)
}

function mockT(key: string, fallback?: string, opts?: Record<string, unknown>): string {
  const dict = dicts[activeDict]
  let text = (dict ? (lookup(dict, key) as string | undefined) : undefined) ?? fallback ?? key
  if (opts) {
    for (const [name, value] of Object.entries(opts)) {
      text = text.replaceAll(`{{${name}}}`, String(value))
    }
  }
  return text
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'zh-CN' }
  })
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' })
}))

type ServiceState = 'unregistered' | 'connected' | 'disconnected'
type PairingState = 'unpaired' | 'outgoing' | 'incoming' | 'paired'

interface Harness {
  api: Record<string, ReturnType<typeof vi.fn>>
  toastError: ReturnType<typeof vi.fn>
  serviceState: { state: ServiceState; deviceCode: string | null; explicitDisconnect: boolean }
}

function healthyStatus(lastError: string | null = null, overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    endpoint: 'http://127.0.0.1:3030',
    lastSyncAt: null,
    lastError,
    lastCaptureError: null,
    pendingCount: 0,
    cursor: 0,
    syncing: false,
    conflictCount: 0,
    ...overrides
  }
}

function pairStateOf(state: PairingState) {
  return {
    deviceCode: 'ABCD2345',
    state,
    outgoing:
      state === 'outgoing' ? { id: 'req-1', targetCode: 'WXYZ5678', createdAt: new Date().toISOString() } : null,
    incoming:
      state === 'incoming' ? [{ id: 'req-9', requesterCode: 'QWER1234', createdAt: new Date().toISOString() }] : []
  }
}

function installHarness(opts?: {
  service?: Harness['serviceState']
  pairState?: unknown
  pairError?: unknown
  status?: ReturnType<typeof healthyStatus>
  connectImpl?: () => Promise<unknown>
}): Harness {
  const serviceState = opts?.service ?? { state: 'unregistered', deviceCode: null, explicitDisconnect: false }
  const api = {
    getConfig: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3030', enabled: true })),
    setConfig: vi.fn(async (cfg: unknown) => cfg),
    getStatus: vi.fn(async () => opts?.status ?? healthyStatus()),
    sync: vi.fn(async () => ({})),
    connect: vi.fn(opts?.connectImpl ?? (async () => serviceState)),
    disconnect: vi.fn(async () => ({ ...serviceState, state: 'disconnected', explicitDisconnect: true })),
    getServiceStatus: vi.fn(async () => serviceState),
    getDeviceCode: vi.fn(async () => ({ deviceCode: serviceState.deviceCode })),
    getPairState: vi.fn(async () => {
      if (opts?.pairError !== undefined) throw opts.pairError
      if (opts?.pairState !== undefined) return opts.pairState
      throw new Error('service disconnected (explicit disconnect; Connect to resume)')
    }),
    requestPairing: vi.fn(async () => ({ requestId: 'req-1', status: 'pending' })),
    cancelPairing: vi.fn(async () => ({ requestId: 'req-1' })),
    acceptPairing: vi.fn(async () => ({ channelId: 'ch-1' })),
    rejectPairing: vi.fn(async () => ({ ok: true })),
    unpair: vi.fn(async () => ({ ok: true }))
  }
  Object.defineProperty(window, 'api', { value: { sync: api }, configurable: true, writable: true })
  const toastError = vi.fn()
  Object.defineProperty(window, 'toast', {
    value: { success: vi.fn(), error: toastError },
    configurable: true,
    writable: true
  })
  return { api, toastError, serviceState }
}

const mounted: Array<{ unmount: () => void }> = []
let origApiDescriptor: PropertyDescriptor | undefined
let origToastDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  activeDict = 'zh-cn'
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
  vi.resetModules()
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
})

async function renderSettings(): Promise<void> {
  const { default: SyncSettings } = await import('../SyncSettings')
  const mountedResult = render(<SyncSettings />)
  mounted.push(mountedResult)
  await waitFor(() => {
    expect(screen.getByTestId('sync-service-status')).toBeInTheDocument()
  })
}

const syncOf = (doc: Dict): Dict => doc.settings.sync as Dict

describe('SyncSettings zh-CN locale values', () => {
  it('carries no placeholders on this page and keeps key completeness', () => {
    const zh = syncOf(zhCn as Dict)
    const en = syncOf(enUs as Dict)
    const tw = syncOf(zhTw as Dict)
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(Object.keys(en).sort()).toEqual(Object.keys(tw).sort())
    for (const [name, doc] of [
      ['zh-cn', zh],
      ['zh-tw', tw]
    ] as const) {
      for (const [key, value] of Object.entries(doc)) {
        expect(String(value), `${name} settings.sync.${key}`).not.toContain('[to be translated]')
      }
    }
    // Spot-check the reported placeholders now read as natural Chinese.
    expect(zh.connect).toBe('连接')
    expect(zh.service_title).toBe('同步服务器')
    expect(zh.endpoint).toBe('同步服务器地址')
    expect(enUs.settings.sync.endpoint).toBe('Sync server address')
    expect(zh.unregistered_state).toBe('未连接')
    expect(zh.unpaired_state).toBe('未配对')
    expect(zh.target_code_placeholder).toBe('对方设备码')
    // The enable-switch carries its own accessible label meaning 启用同步.
    expect(zh.enabled_switch_label).toBe('启用同步')
    expect(enUs.settings.sync.enabled_switch_label).toBe('Enable sync')
    // The HTTP warning key is gone: HTTP and HTTPS are accepted identically.
    expect('http_warning' in zh).toBe(false)
    expect('http_warning' in (enUs.settings as Dict)).toBe(false)
    expect('http_warning' in (zhTw as Dict).settings.sync).toBe(false)
  })

  it('has no token keys and no 401 access-token mapper text', () => {
    for (const [name, doc] of [
      ['en-us', enUs],
      ['zh-cn', zhCn],
      ['zh-tw', zhTw]
    ] as const) {
      const sync = syncOf(doc as Dict)
      expect('token' in sync, `${name} token`).toBe(false)
      expect('token_help' in sync, `${name} token_help`).toBe(false)
      expect('token_placeholder' in sync, `${name} token_placeholder`).toBe(false)
      expect('connect_auth_error' in sync, `${name} connect_auth_error`).toBe(false)
      expect(JSON.stringify(sync), `${name} access-token wording`).not.toMatch(/access token|访问令牌|存取權杖/i)
    }
    // Short next-action guidance stays visible; the detailed flow lives in
    // the pairing tooltip.
    const zh = syncOf(zhCn as Dict)
    const en = syncOf(enUs as Dict)
    expect(zh.pairing_disabled_hint).toBe('连接服务器后显示设备码，可继续配对。')
    expect(en.pairing_disabled_hint).toBe('Connect to the server to show the device code and continue pairing.')
    expect(zh.pairing_help).toMatch(/先连接中继服务获取本机设备码/)
  })

  it('adds genuinely translated waiting keys without new placeholders', () => {
    for (const [name, doc] of [
      ['en-us', enUs],
      ['zh-cn', zhCn],
      ['zh-tw', zhTw]
    ] as const) {
      for (const key of ['waiting_state', 'waiting_hint', 'pairing_required_hint', 'pairing_recovered_hint'] as const) {
        const value = String(syncOf(doc as Dict)[key] ?? '')
        expect(value.length, `${name} ${key}`).toBeGreaterThan(0)
        expect(value, `${name} ${key}`).not.toContain('[to be translated]')
      }
    }
    expect(String(syncOf(zhCn as Dict).waiting_state)).toBe('等待配对')
    expect(String(syncOf(zhTw as Dict).waiting_state)).toBe('等待配對')
    expect(String(syncOf(enUs as Dict).waiting_state)).toBe('Waiting for pairing')
    expect(String(syncOf(zhTw as Dict).waiting_state)).not.toBe(String(syncOf(enUs as Dict).waiting_state))
  })
})

describe('isPairingRequired403 presentation mapping', () => {
  it('matches the safe relay pairing-required signature wrapped and unwrapped', () => {
    expect(isPairingRequired403('sync request failed 403: {"error":"pairing-required"}')).toBe(true)
    expect(
      isPairingRequired403(
        'Error occurred in handler for \'Sync_Sync\': sync request failed 403: {"error":"pairing-required"}'
      )
    ).toBe(true)
    expect(isPairingRequired403('push failed 403: {"error":"pairing-required"}')).toBe(true)
  })

  it('never matches other 403 errors, 401s, or bare text', () => {
    expect(isPairingRequired403('sync request failed 403: {"error":"unknown-credential"}')).toBe(false)
    expect(isPairingRequired403('sync request failed 403: {"error":"invalid-credential"}')).toBe(false)
    expect(isPairingRequired403('sync request failed 403: {"error":"channel-mismatch"}')).toBe(false)
    expect(isPairingRequired403('sync request failed 403: {"error":"seed-grant-denied"}')).toBe(false)
    expect(isPairingRequired403('sync request failed 403: {"error":"digest-mismatch"}')).toBe(false)
    expect(isPairingRequired403('push failed: ENOSPC')).toBe(false)
    expect(isPairingRequired403('sync request failed 403: {"error":"pairing-required", "extra": 1}')).toBe(false)
    expect(isPairingRequired403('sync request failed 403')).toBe(false)
    expect(isPairingRequired403('sync request failed 401: {"error":"unauthorized"}')).toBe(false)
    expect(isPairingRequired403('pairing-required')).toBe(false)
    expect(isPairingRequired403('')).toBe(false)
  })
})

describe('resolveSyncBadge waiting classification', () => {
  const svc = (state: ServiceState) => ({
    state,
    deviceCode: state === 'connected' ? 'ABCD2345' : null,
    explicitDisconnect: false
  })
  const pair = (state: PairingState) => pairStateOf(state)

  it('shows waiting for connected unpaired/outgoing/incoming with pending retained', () => {
    for (const state of ['unpaired', 'outgoing', 'incoming'] as const) {
      const badge = resolveSyncBadge({
        status: healthyStatus(null, { pendingCount: 2 }),
        service: svc('connected'),
        pairing: pair(state)
      })
      expect(badge).toBe('waiting')
    }
  })

  it('shows waiting for a durable pairing-required lastError', () => {
    const badge = resolveSyncBadge({
      status: healthyStatus('sync request failed 403: {"error":"pairing-required"}', { pendingCount: 3 }),
      service: svc('connected'),
      pairing: pair('unpaired')
    })
    expect(badge).toBe('waiting')
  })

  it('keeps genuine errors as failed even when unpaired', () => {
    expect(
      resolveSyncBadge({
        status: healthyStatus(null, { lastCaptureError: 'capture boom' }),
        service: svc('connected'),
        pairing: pair('unpaired')
      })
    ).toBe('failed')
    expect(
      resolveSyncBadge({
        status: healthyStatus('sync request failed 403: {"error":"unknown-credential"}'),
        service: svc('connected'),
        pairing: pair('unpaired')
      })
    ).toBe('failed')
    expect(
      resolveSyncBadge({
        status: healthyStatus('sync request failed 403: {"error":"invalid-credential"}'),
        service: svc('connected'),
        pairing: pair('outgoing')
      })
    ).toBe('failed')
  })

  it('treats a stale pairing-required with live paired as recovery, not failure', () => {
    expect(
      resolveSyncBadge({
        status: healthyStatus('sync request failed 403: {"error":"pairing-required"}', { pendingCount: 1 }),
        service: svc('connected'),
        pairing: pair('paired')
      })
    ).toBe('pending')
    expect(
      resolveSyncBadge({
        status: healthyStatus('sync request failed 403: {"error":"pairing-required"}'),
        service: svc('connected'),
        pairing: pair('paired')
      })
    ).toBe('idle')
  })

  it('handles unknown/disconnected/off without fake pairing or completion', () => {
    // Null status: no badge at all.
    expect(resolveSyncBadge({ status: null, service: svc('connected'), pairing: pair('paired') })).toBeNull()
    // Unknown pairing is never fabricated as paired: without a durable
    // pairing-required error this is plain idle, never a waiting claim tied
    // to a fabricated state.
    expect(resolveSyncBadge({ status: healthyStatus(), service: svc('connected'), pairing: null })).toBe('idle')
    // Disabled never claims progress.
    expect(
      resolveSyncBadge({
        status: healthyStatus(null, { enabled: false }),
        service: svc('connected'),
        pairing: pair('paired')
      })
    ).toBe('disabled')
    // Paired + clean is idle (no convergence claim is asserted elsewhere).
    expect(resolveSyncBadge({ status: healthyStatus(), service: svc('connected'), pairing: pair('paired') })).toBe(
      'idle'
    )
  })

  it('exposes known-unpaired only for connected non-paired observations', () => {
    expect(isKnownUnpaired(svc('connected'), pair('unpaired'))).toBe(true)
    expect(isKnownUnpaired(svc('connected'), pair('outgoing'))).toBe(true)
    expect(isKnownUnpaired(svc('connected'), pair('paired'))).toBe(false)
    expect(isKnownUnpaired(svc('connected'), null)).toBe(false)
    expect(isKnownUnpaired(svc('disconnected'), pair('unpaired'))).toBe(false)
    expect(isKnownUnpaired(null, pair('unpaired'))).toBe(false)
  })
})

describe('SyncSettings tokenless connection (zh-CN)', () => {
  it('renders no token input and keeps prerequisite guidance with no partner actions before connect', async () => {
    installHarness()
    await renderSettings()
    expect(screen.queryByTestId('sync-token-input')).toBeNull()
    expect(document.body.innerHTML).not.toMatch(/sync-token-input/)
    expect(screen.getByTestId('sync-service-status').textContent).toMatch(/未连接/)
    // Pairing is null (never observed): no fabricated unpaired status, no
    // usable partner-code actions — only the short connect-first guidance
    // plus the detailed flow in the pairing tooltip.
    expect(screen.queryByTestId('sync-target-code-input')).toBeNull()
    expect(screen.queryByTestId('sync-request-pairing')).toBeNull()
    expect(screen.getByText('连接服务器后显示设备码，可继续配对。')).toBeInTheDocument()
    expect(screen.getByLabelText(/先连接中继服务获取本机设备码/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('[to be translated]')
  })

  it('keeps exactly one enable switch in the title bar with the sync-scoped label', async () => {
    installHarness()
    await renderSettings()
    const bar = screen.getByTestId('sync-title-bar')
    expect(bar.textContent).toMatch(/同步/)
    // Exactly one switch in the header, named 启用同步 (sync enablement —
    // not connect/register/pair).
    expect(within(bar).getAllByTestId('sync-enabled-switch')).toHaveLength(1)
    expect(screen.getByRole('switch', { name: '启用同步' })).toBeInTheDocument()
    // No duplicate enabled row remains in the service group.
    expect(screen.getByRole('group', { name: '同步服务器' })).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: '同步服务器' })).queryByTestId('sync-enabled-switch')).toBeNull()
    // Help is available by focus through the title tooltip trigger.
    const helpTrigger = screen.getByLabelText(/实验性功能/)
    expect(helpTrigger.getAttribute('tabindex')).toBe('0')
  })

  it('shows no HTTP warning for a LAN HTTP endpoint while editing still autosaves endpoint+enabled only', async () => {
    const harness = installHarness()
    harness.api.getConfig.mockResolvedValue({ endpoint: 'http://192.168.1.10:3030', enabled: true })
    harness.api.getStatus.mockResolvedValue(healthyStatus())
    await renderSettings()
    await waitFor(() => {
      expect(screen.getByTestId('sync-endpoint-input')).toHaveValue('http://192.168.1.10:3030')
    })
    expect(screen.queryByTestId('sync-http-warning')).toBeNull()
    expect(document.body.textContent).not.toMatch(/明文|unencrypted HTTP/i)
    fireEvent.change(screen.getByTestId('sync-endpoint-input'), { target: { value: 'http://192.168.1.11:3030' } })
    fireEvent.blur(screen.getByTestId('sync-endpoint-input'))
    await waitFor(() => {
      expect(harness.api.setConfig).toHaveBeenCalledWith({
        endpoint: 'http://192.168.1.11:3030',
        enabled: true
      })
    })
    const payload = harness.api.setConfig.mock.calls[0]?.[0] as Record<string, unknown>
    expect('token' in payload).toBe(false)
    expect(screen.queryByTestId('sync-http-warning')).toBeNull()
  })

  it('connect reveals the own device code plus the partner-code input and wires requests', async () => {
    const harness = installHarness()
    await renderSettings()
    harness.serviceState.state = 'connected'
    harness.serviceState.deviceCode = 'ABCD2345'
    harness.api.getPairState.mockResolvedValue(pairStateOf('unpaired'))
    fireEvent.click(screen.getByTestId('sync-connect'))
    await waitFor(() => {
      expect(harness.api.connect).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByTestId('sync-device-code').textContent).toContain('ABCD2345')
    })
    expect(screen.getByTestId('sync-target-code-input')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('sync-target-code-input'), { target: { value: 'wxyz5678' } })
    fireEvent.click(screen.getByTestId('sync-request-pairing'))
    await waitFor(() => {
      expect(harness.api.requestPairing).toHaveBeenCalledWith({ targetCode: 'wxyz5678' })
    })
  })

  it('keeps an unknown-device 403 visible with no silent re-register', async () => {
    const harness = installHarness({
      service: { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false },
      pairState: pairStateOf('unpaired')
    })
    harness.api.requestPairing.mockRejectedValue(new Error('sync request failed 403: {"error":"unknown-credential"}'))
    await renderSettings()
    await waitFor(() => {
      expect(screen.getByTestId('sync-request-pairing')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByTestId('sync-target-code-input'), { target: { value: 'ZZZZ9999' } })
    fireEvent.click(screen.getByTestId('sync-request-pairing'))
    await waitFor(() => {
      expect(screen.getByTestId('sync-pairing-error').textContent).toContain('unknown-credential')
    })
    // No silent re-register: no accept/retry path was taken.
    expect(harness.api.acceptPairing).not.toHaveBeenCalled()
    expect(screen.getByTestId('sync-pairing-pill').textContent).toMatch(/未配对/)
  })

  it('preserves connection failure details verbatim', async () => {
    const raw403 = 'sync request failed 403: {"error":"pairing-required"}'
    const { api } = installHarness({ connectImpl: () => Promise.reject(new Error(raw403)) })
    await renderSettings()
    fireEvent.click(screen.getByTestId('sync-connect'))
    await waitFor(() => {
      expect(api.connect).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByTestId('sync-pairing-error').textContent).toContain('pairing-required')
    })
    expect(screen.getByTestId('sync-pairing-error').textContent).not.toMatch(/认证失败/)
  })

  it('shows waiting (not failure) for connected unpaired with a durable pairing-required error', async () => {
    installHarness({
      service: { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false },
      pairState: pairStateOf('unpaired'),
      status: healthyStatus('sync request failed 403: {"error":"pairing-required"}', { pendingCount: 2 })
    })
    await renderSettings()
    await waitFor(() => {
      expect(screen.getByTestId('sync-status-badge').getAttribute('data-state')).toBe('waiting')
    })
    const badge = screen.getByTestId('sync-status-badge')
    expect(badge.textContent).toBe('等待配对')
    // Helpful awaiting-pairing guidance replaces the raw error stack.
    expect(screen.getByTestId('sync-pairing-required-hint').textContent).toMatch(/等待配对/)
    expect(screen.queryByTestId('sync-last-error')).toBeNull()
    // Pending intent is retained and visible.
    expect(screen.getByTestId('sync-pending-count').textContent).toBe('2')
    // Manual sync cannot succeed before pairing: disabled with explanation.
    expect(screen.getByTestId('sync-now-button')).toBeDisabled()
    expect(screen.getByTestId('sync-waiting-hint').textContent).toMatch(/等待配对/)
  })

  it('still displays a genuine capture error even when unpaired', async () => {
    installHarness({
      service: { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false },
      pairState: pairStateOf('unpaired'),
      status: healthyStatus('sync request failed 403: {"error":"pairing-required"}', {
        lastCaptureError: 'capture pipeline boom'
      })
    })
    await renderSettings()
    await waitFor(() => {
      expect(screen.getByTestId('sync-status-badge').getAttribute('data-state')).toBe('failed')
    })
    expect(screen.getByTestId('sync-status-badge').textContent).toBe('同步异常')
    expect(screen.getByTestId('sync-capture-error').textContent).toContain('capture pipeline boom')
    expect(screen.queryByTestId('sync-pairing-required-hint')).toBeNull()
  })

  it('still displays a genuine unrelated lastError even when unpaired', async () => {
    installHarness({
      service: { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false },
      pairState: pairStateOf('outgoing'),
      status: healthyStatus('sync request failed 403: {"error":"invalid-credential"}')
    })
    await renderSettings()
    await waitFor(() => {
      expect(screen.getByTestId('sync-last-error').textContent).toContain('invalid-credential')
    })
    expect(screen.getByTestId('sync-status-badge').getAttribute('data-state')).toBe('failed')
  })

  it('treats a stale pairing-required with live paired as recovery', async () => {
    installHarness({
      service: { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false },
      pairState: pairStateOf('paired'),
      status: healthyStatus('sync request failed 403: {"error":"pairing-required"}')
    })
    await renderSettings()
    await waitFor(() => {
      expect(screen.getByTestId('sync-recovery-hint')).toBeInTheDocument()
    })
    expect(screen.getByTestId('sync-status-badge').getAttribute('data-state')).toBe('idle')
    expect(screen.queryByTestId('sync-last-error')).toBeNull()
    expect(screen.getByTestId('sync-pairing-pill').textContent).toBe('已配对')
  })

  it('shows waiting for outgoing/incoming without claiming completion', async () => {
    for (const state of ['outgoing', 'incoming'] as const) {
      cleanup()
      installHarness({
        service: { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false },
        pairState: pairStateOf(state),
        status: healthyStatus(null, { pendingCount: 1 })
      })
      await renderSettings()
      await waitFor(() => {
        expect(screen.getByTestId('sync-status-badge').getAttribute('data-state')).toBe('waiting')
      })
      expect(screen.getByTestId('sync-status-badge').textContent).toBe('等待配对')
      expect(screen.getByTestId('sync-now-button')).toBeDisabled()
      expect(screen.queryByText(/同步完成/)).toBeNull()
      for (const m of mounted.splice(0)) {
        try {
          m.unmount()
        } catch {}
      }
      cleanup()
    }
  })
})

describe('SyncSettings status label/pill dedup and narrow-pane treatment (zh-CN)', () => {
  it('renders one service label plus a single pill without duplicating the value', async () => {
    installHarness({
      service: { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false },
      pairState: pairStateOf('unpaired')
    })
    await renderSettings()
    const container = screen.getByTestId('sync-service-status')
    expect(container.textContent).toMatch(/服务状态/)
    const pill = screen.getByTestId('sync-service-pill')
    expect(pill.textContent).toBe('已连接')
    // The connected value appears exactly once inside the container.
    expect(container.textContent?.match(/已连接/g)?.length).toBe(1)
  })

  it('renders one pairing label plus a single pill without duplicating the value', async () => {
    installHarness({
      service: { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false },
      pairState: pairStateOf('unpaired')
    })
    await renderSettings()
    const container = screen.getByTestId('sync-pairing-status')
    expect(container.textContent).toMatch(/配对状态/)
    const pill = screen.getByTestId('sync-pairing-pill')
    expect(pill.textContent).toBe('未配对')
    expect(container.textContent?.match(/未配对/g)?.length).toBe(1)
  })

  it('keeps the address label on one line with a usable bounded input', async () => {
    installHarness()
    await renderSettings()
    expect(screen.getByTestId('sync-endpoint-input')).toHaveStyle('max-width: 320px')
    // The label never wraps at narrow pane widths (checked via inline style).
    const label = screen.getByText('同步服务器地址')
    expect(label).toHaveStyle('white-space: nowrap')
  })

  it('keeps error text wrapped inline without hover-only truncation', async () => {
    installHarness({
      service: { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false },
      pairState: pairStateOf('unpaired'),
      status: healthyStatus('relay offline: connection refused')
    })
    await renderSettings()
    await waitFor(() => {
      expect(screen.getByTestId('sync-last-error').textContent).toContain('relay offline: connection refused')
    })
    expect(screen.getByTestId('sync-last-error')).toHaveStyle('overflow-wrap: break-word')
  })
})

describe('SyncSettings data-status badge accuracy (zh-CN)', () => {
  async function renderWithStatus(status: ReturnType<typeof healthyStatus>): Promise<void> {
    installHarness({ status })
    await renderSettings()
    await waitFor(() => {
      expect(screen.getByTestId('sync-status-badge')).toBeInTheDocument()
    })
  }

  it('shows 已关闭 when sync is disabled without claiming progress', async () => {
    await renderWithStatus({ ...healthyStatus(), enabled: false })
    const badge = screen.getByTestId('sync-status-badge')
    expect(badge.getAttribute('data-state')).toBe('disabled')
    expect(badge.textContent).toBe('已关闭')
  })

  it('shows 同步中 while a sync is running', async () => {
    await renderWithStatus({ ...healthyStatus(), syncing: true })
    const badge = screen.getByTestId('sync-status-badge')
    expect(badge.getAttribute('data-state')).toBe('syncing')
    expect(badge.textContent).toMatch(/同步中/)
    expect(screen.getByTestId('sync-syncing')).toBeInTheDocument()
  })

  it('shows 同步异常 for a durable error while keeping the raw detail inline', async () => {
    await renderWithStatus({ ...healthyStatus(), lastError: 'relay offline: connection refused' })
    const badge = screen.getByTestId('sync-status-badge')
    expect(badge.getAttribute('data-state')).toBe('failed')
    expect(badge.textContent).toBe('同步异常')
    expect(screen.getByTestId('sync-last-error').textContent).toContain('relay offline: connection refused')
  })

  it('shows 待同步 for pending work with the cursor tucked into details', async () => {
    installHarness({
      service: { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false },
      pairState: pairStateOf('paired'),
      status: healthyStatus(null, { pendingCount: 3, cursor: 42 })
    })
    await renderSettings()
    await waitFor(() => {
      expect(screen.getByTestId('sync-status-badge')).toBeInTheDocument()
    })
    const badge = screen.getByTestId('sync-status-badge')
    expect(badge.getAttribute('data-state')).toBe('pending')
    expect(badge.textContent).toBe('待同步')
    expect(screen.getByTestId('sync-pending-count').textContent).toBe('3')
    expect(screen.getByTestId('sync-cursor').textContent).toBe('42')
    // No prominent raw `待同步 0 | 游标 0` aggregate remains.
    expect(screen.queryByTestId('sync-pending-cursor')).toBeNull()
  })

  it('shows 空闲 for clean paired state without claiming convergence', async () => {
    installHarness({
      service: { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false },
      pairState: pairStateOf('paired'),
      status: healthyStatus()
    })
    await renderSettings()
    await waitFor(() => {
      expect(screen.getByTestId('sync-status-badge')).toBeInTheDocument()
    })
    const badge = screen.getByTestId('sync-status-badge')
    expect(badge.getAttribute('data-state')).toBe('idle')
    expect(badge.textContent).toBe('空闲')
    // No last-sync success is asserted from lastSyncAt alone.
    expect(screen.queryByText(/同步完成/)).toBeNull()
  })

  it('renders no badge and a neutral pairing pill when status is unknown', async () => {
    const harness = installHarness()
    harness.api.getStatus.mockResolvedValue(null)
    await renderSettings()
    await waitFor(() => {
      expect(screen.getByText('暂无状态')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('sync-status-badge')).toBeNull()
    // Unknown pairing is never fabricated: neutral pill, no partner actions.
    const pill = screen.getByTestId('sync-pairing-pill')
    expect(pill.getAttribute('data-state')).toBe('unknown')
    expect(pill.textContent).toBe('—')
    expect(screen.getByTestId('sync-pairing-status').textContent).toMatch(/配对状态/)
  })

  it('renders no badge and null-state text when status polling fails', async () => {
    const harness = installHarness()
    harness.api.getStatus.mockRejectedValue(new Error('status poll failed'))
    await renderSettings()
    await waitFor(() => {
      expect(screen.getByText('暂无状态')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('sync-status-badge')).toBeNull()
  })
})
