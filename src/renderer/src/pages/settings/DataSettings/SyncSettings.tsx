import { useTheme } from '@renderer/context/ThemeProvider'
import { loggerService } from '@renderer/services/LoggerService'
import { isNonLoopbackHttpEndpoint } from '@shared/sync'
import { Alert, Button, Input, Switch } from 'antd'
import dayjs from 'dayjs'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  SettingDivider,
  SettingGroup,
  SettingHelpText,
  SettingRow,
  SettingRowTitle,
  SettingSubtitle,
  SettingTitle
} from '..'

const logger = loggerService.withContext('SyncSettings')

// Wrapped, keyboard-accessible error text: full content is rendered inline
// (never Tooltip-only) so long URLs/tokens remain readable without hover.
const errorTextStyle: CSSProperties = {
  color: 'var(--color-error)',
  fontSize: 12,
  overflowWrap: 'break-word',
  wordBreak: 'break-word'
}

interface SyncDataStatus {
  enabled: boolean
  endpoint: string
  lastSyncAt: string | null
  lastError: string | null
  lastCaptureError: string | null
  pendingCount: number
  cursor: number
  syncing: boolean
  conflictCount: number
}

interface ServiceStatus {
  state: 'unregistered' | 'connected' | 'disconnected'
  deviceCode: string | null
  explicitDisconnect: boolean
}

interface PairState {
  deviceCode: string
  state: 'unpaired' | 'outgoing' | 'incoming' | 'paired'
  outgoing: { id: string; targetCode: string; createdAt: string } | null
  incoming: Array<{ id: string; requesterCode: string; createdAt: string }>
}

// Configuration form (user intent: enabled/endpoint/token). Service state
// (attached/detached/device code) is a separate observation and is never
// mixed into this form: config edits persist via setConfig, service state
// changes only via connect/disconnect/live polling.
interface SyncForm {
  endpoint: string
  token: string
  enabled: boolean
}

const normalizeConfig = (form: SyncForm): SyncForm => ({
  endpoint: form.endpoint.trim(),
  token: form.token.trim(),
  enabled: form.enabled
})

const sameConfig = (a: SyncForm, b: SyncForm): boolean =>
  a.endpoint === b.endpoint && a.token === b.token && a.enabled === b.enabled

const SyncSettings: React.FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()

  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<SyncDataStatus | null>(null)
  const [service, setService] = useState<ServiceStatus | null>(null)
  const [pairing, setPairing] = useState<PairState | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [targetCode, setTargetCode] = useState('')
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [pairingBusy, setPairingBusy] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  // Raw mount-time config load failure, if any. Rendered through i18n at
  // render time so the load callback stays independent of the t identity.
  // Mutually exclusive with save errors: without hydration no save can run.
  const [configLoadError, setConfigLoadError] = useState<string | null>(null)
  // Hydration gate: no setConfig may be sent before a valid getConfig result
  // has established the full persisted config. Until then the endpoint/token/
  // Enabled controls stay disabled so defaults can never be persisted as if
  // they were authoritative. Service/pairing/status observation is unaffected.
  const [hydrated, setHydrated] = useState(false)
  const hydratedRef = useRef(false)
  // Latest-only refresh generation: Connect/Disconnect bump the generation
  // so an older in-flight live/config/pair response can never overwrite the
  // newer attached/detached observation.
  const refreshGen = useRef(0)
  const bumpRefreshGen = useCallback(() => {
    refreshGen.current += 1
    return refreshGen.current
  }, [])

  // Live form mirror: blur/toggle handlers persist the full normalized config
  // atomically, so a partial-field save never overwrites another current form
  // value with a stale closure.
  const formRef = useRef<SyncForm>({ endpoint: '', token: '', enabled: false })
  // Last successfully persisted config: saves of unchanged values are no-ops.
  const persistedRef = useRef<SyncForm>({ endpoint: '', token: '', enabled: false })
  // Single-flight save guard: overlapping saves coalesce to the latest form
  // instead of running concurrently, and completion only records the exact
  // payload it sent, so stale completion can never revert newer edits.
  const savingRef = useRef(false)
  const queuedRef = useRef(false)
  // Form authority generation: every local config interaction (edit, blur trim,
  // toggle) and every successful save bumps it. The mount-time config response
  // may hydrate the form only if nothing made it stale since that request
  // began, so a deferred getConfig can never overwrite newer edits or reset a
  // newer persisted/autosave snapshot.
  const formGen = useRef(0)
  const updateService = useCallback((svc: ServiceStatus | null) => {
    if (svc) setService(svc)
  }, [])

  const persistConfig = useCallback(async () => {
    // An in-flight save always coalesces a concurrent trigger: the loop below
    // re-reads the latest form on completion, so a newer edit can never be
    // reverted by stale completion even when it momentarily matches the old
    // persisted snapshot.
    // Persistence requires hydration: never send defaults for config fields
    // that have not yet been established by a valid getConfig result.
    if (!hydratedRef.current) return
    if (savingRef.current) {
      queuedRef.current = true
      return
    }
    const desired = normalizeConfig(formRef.current)
    if (sameConfig(desired, persistedRef.current)) return
    savingRef.current = true
    try {
      let next = desired
      // Bounded attempts: each pass sends the latest known form; a pass that
      // fails surfaces the error and retries once with the newest edits only
      // when edits arrived mid-save. The form itself is never rewritten here,
      // so a failure always preserves current local edits.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await window.api.sync.setConfig(next)
        } catch (e) {
          const msg = String((e as Error)?.message ?? e)
          setConfigError(msg.slice(0, 500))
          window.toast.error(msg)
          logger.error('save sync config failed', e as Error)
          const latest = normalizeConfig(formRef.current)
          if (queuedRef.current && !sameConfig(latest, persistedRef.current)) {
            queuedRef.current = false
            next = latest
            continue
          }
          return
        }
        persistedRef.current = next
        // A save completion is form authority: a stale mount-time config that
        // resolves afterwards must not replace this newer persisted snapshot.
        formGen.current += 1
        setConfigError(null)
        if (queuedRef.current) {
          queuedRef.current = false
          const latest = normalizeConfig(formRef.current)
          if (sameConfig(latest, persistedRef.current)) return
          next = latest
          continue
        }
        return
      }
    } finally {
      savingRef.current = false
      if (queuedRef.current) {
        queuedRef.current = false
        void persistConfig()
      }
    }
  }, [])

  const loadConfigAndStatus = useCallback(async () => {
    const gen = refreshGen.current
    const cfgGen = formGen.current
    try {
      // getConfig is isolated from the live observations: its failure must
      // neither block status/service updates nor mark defaults authoritative.
      const cfgResult:
        | { ok: true; cfg: { endpoint?: string; token?: string; enabled?: boolean } }
        | { ok: false; error: unknown } = await window.api.sync.getConfig().then(
        (cfg) => ({ ok: true as const, cfg }),
        (error: unknown) => ({ ok: false as const, error })
      )
      const [st, svc] = await Promise.all([
        window.api.sync.getStatus().catch(() => null),
        window.api.sync.getServiceStatus().catch(() => null)
      ])
      if (gen !== refreshGen.current) return
      // Status/service observations are independent of form authority and may
      // still update even when the config payload itself is stale or failed.
      if (st) setStatus(st)
      updateService(svc)
      if (!cfgResult.ok) {
        setConfigLoadError(String((cfgResult.error as Error)?.message ?? cfgResult.error).slice(0, 500))
        logger.error('load sync config failed', cfgResult.error as Error)
        return
      }
      // Hydrate the form only if no local interaction or save made this
      // response stale since the request began.
      if (cfgGen !== formGen.current) return
      const cfg = cfgResult.cfg
      const loaded: SyncForm = {
        endpoint: cfg.endpoint ?? '',
        token: cfg.token ?? '',
        enabled: !!cfg.enabled
      }
      setEndpoint(loaded.endpoint)
      setToken(loaded.token)
      setEnabled(loaded.enabled)
      formRef.current = loaded
      persistedRef.current = normalizeConfig(loaded)
      hydratedRef.current = true
      setHydrated(true)
    } catch (e) {
      if (gen !== refreshGen.current) return
      logger.error('load sync config failed', e as Error)
    }
  }, [updateService])

  const loadLiveState = useCallback(async () => {
    const gen = refreshGen.current
    const [st, svc, pair] = await Promise.all([
      window.api.sync.getStatus().catch(() => null),
      window.api.sync.getServiceStatus().catch(() => null),
      // Pairing state requires an attached service; while disconnected or
      // unregistered there is nothing to show (not an error).
      window.api.sync
        .getPairState()
        .catch(() => null)
    ])
    if (gen !== refreshGen.current) return
    if (st) setStatus(st)
    updateService(svc)
    // Disconnected/offline retains the last known pairing observation: only
    // a successful (non-null) fetch replaces it, so membership semantics are
    // never reset to unknown by a failed poll. Live polling never touches the
    // endpoint/token/enabled form, so active local edits are preserved.
    if (pair !== null) setPairing(pair)
  }, [updateService])

  const loadPairing = useCallback(async () => {
    const gen = refreshGen.current
    try {
      // Coordinated refresh: observe the service first so a pairing failure is
      // classified against the current attachment observation from this same
      // refresh — never against a stale or not-yet-loaded service mirror.
      const svc = await window.api.sync.getServiceStatus().catch(() => null)
      if (gen !== refreshGen.current) return
      updateService(svc)
      let pair: PairState
      try {
        pair = await window.api.sync.getPairState()
      } catch (e) {
        if (gen !== refreshGen.current) return
        logger.error('load pairing failed', e as Error)
        // Expected inability while the service is not attached (disconnected /
        // unregistered, including the initial load) is not an error: the last
        // known pairing observation is retained silently. A failure observed
        // while connected surfaces truthfully, still retaining last-known
        // pairing state (it is only ever replaced by a successful fetch).
        if (svc?.state === 'connected') {
          setPairingError(String((e as Error).message ?? e).slice(0, 500))
        }
        return
      }
      if (gen !== refreshGen.current) return
      setPairing(pair)
      setPairingError(null)
    } catch (e) {
      if (gen !== refreshGen.current) return
      logger.error('load pairing failed', e as Error)
    }
  }, [updateService])

  useEffect(() => {
    void loadConfigAndStatus()
    void loadPairing()
    // Poll live state only — never the config form, so the five-second poll
    // cannot overwrite endpoint/token edits in progress.
    const id = setInterval(() => {
      void loadLiveState()
    }, 5000)
    return () => clearInterval(id)
  }, [loadConfigAndStatus, loadLiveState, loadPairing])

  const onEndpointChange = (value: string) => {
    setEndpoint(value)
    formRef.current.endpoint = value
    formGen.current += 1
  }

  const onTokenChange = (value: string) => {
    setToken(value)
    formRef.current.token = value
    formGen.current += 1
  }

  const onEndpointBlur = () => {
    const trimmed = formRef.current.endpoint.trim()
    if (trimmed !== formRef.current.endpoint) {
      formRef.current.endpoint = trimmed
      setEndpoint(trimmed)
      formGen.current += 1
    }
    void persistConfig()
  }

  const onTokenBlur = () => {
    const trimmed = formRef.current.token.trim()
    if (trimmed !== formRef.current.token) {
      formRef.current.token = trimmed
      setToken(trimmed)
      formGen.current += 1
    }
    void persistConfig()
  }

  const onEnabledChange = (value: boolean) => {
    setEnabled(value)
    formRef.current.enabled = value
    formGen.current += 1
    void persistConfig()
  }

  const onSync = async () => {
    setSyncing(true)
    try {
      const res = await window.api.sync.sync()
      setStatus(res)
      // Sync F2: a durable failure is persisted as lastError; never report
      // success when the status carries it. Status remains inspectable.
      if (res.lastError) {
        window.toast.error(res.lastError)
      } else {
        window.toast.success(t('settings.sync.sync_success', 'Sync completed'))
      }
    } catch (e) {
      window.toast.error(String((e as Error).message))
      await loadLiveState()
    } finally {
      setSyncing(false)
    }
  }

  const onConnect = async () => {
    const gen = bumpRefreshGen()
    setConnecting(true)
    try {
      setPairingError(null)
      const svc = await window.api.sync.connect()
      if (gen !== refreshGen.current) return
      updateService(svc)
      await loadPairing()
      window.toast.success(t('settings.sync.connect_success', 'Connected to relay'))
    } catch (e) {
      if (gen !== refreshGen.current) return
      const msg = String((e as Error).message)
      setPairingError(msg.slice(0, 500))
      window.toast.error(msg)
      await loadLiveState()
    } finally {
      if (gen === refreshGen.current) setConnecting(false)
    }
  }

  const onDisconnect = async () => {
    const gen = bumpRefreshGen()
    setConnecting(true)
    try {
      const svc = await window.api.sync.disconnect()
      if (gen !== refreshGen.current) return
      updateService(svc)
      // Retain the last known pairing observation across Disconnect/offline:
      // online-only actions stay disabled via pairingActionsDisabled, but the
      // membership state is never reset to unknown.
    } catch (e) {
      if (gen !== refreshGen.current) return
      window.toast.error(String((e as Error).message))
    } finally {
      if (gen === refreshGen.current) setConnecting(false)
    }
  }

  const runPairingAction = async (action: () => Promise<unknown>, after?: () => void) => {
    setPairingBusy(true)
    setPairingError(null)
    try {
      await action()
      after?.()
      await loadPairing()
    } catch (e) {
      setPairingError(String((e as Error).message).slice(0, 500))
    } finally {
      setPairingBusy(false)
    }
  }

  const serviceConnected = service?.state === 'connected'
  // Network-disconnected (registered, not an explicit Disconnect) offers
  // both Connect (resume) and Disconnect (explicitly stop); an explicit
  // Disconnect or unregistered state offers Connect only.
  const showDisconnect =
    serviceConnected || (service?.state === 'disconnected' && !service?.explicitDisconnect && !!service?.deviceCode)
  const showConnect = !serviceConnected
  const pairingActionsDisabled = !serviceConnected || pairingBusy
  const pairingStateLabel = !pairing
    ? '—'
    : pairing.state === 'paired'
      ? t('settings.sync.paired_state', 'Paired')
      : pairing.state === 'outgoing'
        ? t('settings.sync.outgoing_state', 'Request pending')
        : pairing.state === 'incoming'
          ? t('settings.sync.incoming_state', 'Approval needed')
          : t('settings.sync.unpaired_state', 'Not paired')

  return (
    <SettingGroup theme={theme}>
      <SettingTitle>{t('settings.sync.title', 'Synchronization')}</SettingTitle>
      <SettingHelpText>
        {t(
          'settings.sync.help',
          'Automatic personal-device sync through your own relay is experimental with limited coverage and pending validation — not production-ready.'
        )}
      </SettingHelpText>
      <SettingDivider />
      <div role="group" aria-labelledby="sync-section-relay">
        <SettingSubtitle id="sync-section-relay">{t('settings.sync.service_title', 'Relay service')}</SettingSubtitle>
        <SettingRow>
          <SettingRowTitle>{t('settings.sync.enabled', 'Enabled')}</SettingRowTitle>
          <Switch checked={enabled} onChange={onEnabledChange} disabled={!hydrated} data-testid="sync-enabled-switch" />
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>{t('settings.sync.endpoint', 'Relay Endpoint')}</SettingRowTitle>
          <Input
            placeholder={t('settings.sync.endpoint_placeholder', 'http://127.0.0.1:3030')}
            value={endpoint}
            onChange={(e) => onEndpointChange(e.target.value)}
            onBlur={onEndpointBlur}
            disabled={!hydrated}
            style={{ flex: '1 1 auto', maxWidth: 320, minWidth: 0, marginLeft: 12 }}
            data-testid="sync-endpoint-input"
          />
        </SettingRow>
        <SettingRow>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SettingHelpText>
              {t(
                'settings.sync.endpoint_help',
                'Use http:// for direct LAN access or https:// when your deployment provides TLS. Plain HTTP is unencrypted.'
              )}
            </SettingHelpText>
            {isNonLoopbackHttpEndpoint(endpoint) && (
              <Alert
                type="warning"
                showIcon
                data-testid="sync-http-warning"
                message={t(
                  'settings.sync.http_warning',
                  'This endpoint uses unencrypted HTTP on a non-local host. Anyone on the network path can read or modify synced data. Use HTTPS when available.'
                )}
              />
            )}
          </div>
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>{t('settings.sync.token', 'Access Token')}</SettingRowTitle>
          <Input.Password
            placeholder={t('settings.sync.token_placeholder', 'Optional bearer token')}
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            onBlur={onTokenBlur}
            disabled={!hydrated}
            style={{ flex: '1 1 auto', maxWidth: 320, minWidth: 0, marginLeft: 12 }}
            data-testid="sync-token-input"
          />
        </SettingRow>
        <SettingRow>
          <SettingHelpText>
            {t('settings.sync.token_help', 'Token is never included in sync payload or logs.')}
          </SettingHelpText>
        </SettingRow>
        {(configLoadError || configError) && (
          <SettingRow>
            <span style={errorTextStyle} data-testid="sync-config-error">
              {configLoadError
                ? t('settings.sync.config_load_error', 'Failed to load sync configuration: {{message}}', {
                    message: configLoadError
                  }).slice(0, 500)
                : (configError ?? '').slice(0, 500)}
            </span>
          </SettingRow>
        )}
        <div style={{ flex: 1, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span
              data-testid="sync-service-indicator"
              data-state={service?.state ?? 'unknown'}
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                backgroundColor: !service
                  ? 'var(--color-text-3, #8c8c8c)'
                  : serviceConnected
                    ? 'var(--color-success, #52c41a)'
                    : 'var(--color-error, #ff4d4f)'
              }}
            />
            <span data-testid="sync-service-status">
              {t('settings.sync.service_status', 'Service')}:{' '}
              {!service
                ? '—'
                : service.state === 'connected'
                  ? t('settings.sync.connected_state', 'Connected')
                  : service.state === 'unregistered'
                    ? t('settings.sync.unregistered_state', 'Not connected')
                    : t('settings.sync.disconnected_state', 'Disconnected')}
            </span>
          </div>
          {service?.deviceCode && (
            <span data-testid="sync-device-code">
              {t('settings.sync.device_code_label', 'This device code')}: {service.deviceCode}
            </span>
          )}
          <SettingHelpText>
            {t(
              'settings.sync.device_code_hint',
              'The device code is public: read it aloud to pair another of your devices. It cannot authorize anything by itself.'
            )}
          </SettingHelpText>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {showConnect && (
              <Button type="primary" onClick={onConnect} loading={connecting} data-testid="sync-connect">
                {t('settings.sync.connect', 'Connect')}
              </Button>
            )}
            {showDisconnect && (
              <Button onClick={onDisconnect} loading={connecting} data-testid="sync-disconnect">
                {t('settings.sync.disconnect', 'Disconnect')}
              </Button>
            )}
          </div>
        </div>
      </div>
      <SettingDivider />
      <div role="group" aria-labelledby="sync-section-pairing">
        <SettingSubtitle id="sync-section-pairing">
          {t('settings.sync.pairing_title', 'Device pairing')}
        </SettingSubtitle>
        <div style={{ flex: 1, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SettingHelpText>
            {t(
              'settings.sync.pairing_help',
              'Pairing joins your own devices into a private channel. Enter the other device code to request pairing; the other device accepts. Channels are private per device group.'
            )}
          </SettingHelpText>
          <span data-testid="sync-pairing-status">
            {t('settings.sync.pairing_status', 'Pairing status')}: {pairingStateLabel}
          </span>
          {!serviceConnected && (
            <SettingHelpText>
              {t(
                'settings.sync.pairing_disabled_hint',
                'Connect the relay service first; pairing actions are unavailable while disconnected.'
              )}
            </SettingHelpText>
          )}
          {pairing?.state === 'unpaired' && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Input
                placeholder={t('settings.sync.target_code_placeholder', 'Other device code')}
                value={targetCode}
                onChange={(e) => setTargetCode(e.target.value)}
                style={{ flex: '1 1 auto', maxWidth: 200, minWidth: 0 }}
                data-testid="sync-target-code-input"
              />
              <Button
                onClick={() =>
                  void runPairingAction(
                    () => window.api.sync.requestPairing({ targetCode }),
                    () => setTargetCode('')
                  )
                }
                loading={pairingBusy}
                disabled={pairingActionsDisabled}
                data-testid="sync-request-pairing">
                {t('settings.sync.request_pairing', 'Request pairing')}
              </Button>
            </div>
          )}
          {pairing?.state === 'outgoing' && pairing.outgoing && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span data-testid="sync-outgoing-request">
                {t('settings.sync.outgoing_request', 'Requested')}: {pairing.outgoing.targetCode}
              </span>
              <Button
                size="small"
                onClick={() => void runPairingAction(() => window.api.sync.cancelPairing())}
                loading={pairingBusy}
                disabled={pairingActionsDisabled}
                data-testid="sync-cancel-request">
                {t('settings.sync.cancel', 'Cancel')}
              </Button>
            </div>
          )}
          {pairing && pairing.incoming.length > 0
            ? pairing.incoming.map((r) => (
                <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span data-testid={`sync-incoming-${r.id}`}>{r.requesterCode}</span>
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => void runPairingAction(() => window.api.sync.acceptPairing(r.id))}
                    loading={pairingBusy}
                    disabled={pairingActionsDisabled}
                    data-testid={`sync-accept-${r.id}`}>
                    {t('settings.sync.accept', 'Accept')}
                  </Button>
                  <Button
                    size="small"
                    onClick={() => void runPairingAction(() => window.api.sync.rejectPairing(r.id))}
                    loading={pairingBusy}
                    disabled={pairingActionsDisabled}
                    data-testid={`sync-reject-${r.id}`}>
                    {t('settings.sync.reject', 'Reject')}
                  </Button>
                </div>
              ))
            : pairing?.state === 'incoming' && <span>{t('settings.sync.no_pending', 'No pending requests')}</span>}
          {pairing?.state === 'paired' && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button
                onClick={() => void runPairingAction(() => window.api.sync.unpair())}
                loading={pairingBusy}
                disabled={pairingActionsDisabled}
                data-testid="sync-unpair">
                {t('settings.sync.unpair', 'Unpair')}
              </Button>
            </div>
          )}
          {pairing?.state === 'paired' && pairing.outgoing && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span data-testid="sync-paired-stale-outgoing">
                {t('settings.sync.outgoing_request', 'Requested')}: {pairing.outgoing.targetCode}
              </span>
              <Button
                size="small"
                onClick={() => void runPairingAction(() => window.api.sync.cancelPairing())}
                loading={pairingBusy}
                disabled={pairingActionsDisabled}
                data-testid="sync-cancel-stale-request">
                {t('settings.sync.cancel', 'Cancel')}
              </Button>
            </div>
          )}
          {pairingError && (
            <span style={errorTextStyle} data-testid="sync-pairing-error">
              {pairingError.slice(0, 500)}
            </span>
          )}
        </div>
      </div>
      <SettingDivider />
      <div role="group" aria-labelledby="sync-section-data">
        <SettingSubtitle id="sync-section-data">{t('settings.sync.status', 'Status')}</SettingSubtitle>
        <div style={{ flex: 1, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ flex: 1, fontSize: 12, color: 'var(--color-text-2)' }} data-testid="sync-status">
            {status ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span data-testid="sync-pending-cursor">
                  {t('settings.sync.pending', 'Pending')}:{' '}
                  <span data-testid="sync-pending-count">{status.pendingCount}</span> |{' '}
                  {t('settings.sync.cursor', 'Cursor')}: <span data-testid="sync-cursor">{status.cursor}</span>
                </span>
                {status.lastSyncAt && (
                  <span>
                    {t('settings.sync.last_sync', 'Last sync')}:{' '}
                    {dayjs(status.lastSyncAt).format('YYYY-MM-DD HH:mm:ss')}
                  </span>
                )}
                {status.lastError && (
                  <span style={errorTextStyle} data-testid="sync-last-error">
                    {t('settings.sync.last_error', 'Last error')}: {status.lastError}
                  </span>
                )}
                {status.lastCaptureError && (
                  <span style={errorTextStyle} data-testid="sync-capture-error">
                    {t('settings.sync.capture_error', 'Capture error')}: {status.lastCaptureError}
                  </span>
                )}
                {(status.conflictCount ?? 0) > 0 && (
                  <span style={{ color: 'var(--color-warning)' }} data-testid="sync-conflict-count">
                    {t(
                      'settings.sync.conflicts_pending',
                      'Conflicting edits: {{count}} field(s) kept the newest value; the overwritten value is stored for a future restore (automatic restore not available yet).',
                      { count: status.conflictCount }
                    )}
                  </span>
                )}
                {status.syncing && <span data-testid="sync-syncing">{t('settings.sync.syncing', 'Syncing...')}</span>}
              </div>
            ) : (
              <span>{t('settings.sync.no_status', 'No status yet')}</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              type="primary"
              onClick={onSync}
              loading={syncing || !!status?.syncing}
              disabled={!enabled || !endpoint}
              data-testid="sync-now-button">
              {t('settings.sync.sync_now', 'Sync Now')}
            </Button>
          </div>
        </div>
      </div>
    </SettingGroup>
  )
}

export default SyncSettings
