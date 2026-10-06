import { useTheme } from '@renderer/context/ThemeProvider'
import { loggerService } from '@renderer/services/LoggerService'
import { Button, Flex, Input, Switch, Tag, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { Copy, Info } from 'lucide-react'
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

// Presentation-only pairing-required detector (renderer-local, no protocol or
// IPC change). Matches only the actual safe relay signature: an HTTP 403
// status plus the exact `{"error":"pairing-required"}` body the Main sanitizer
// emits — including its `... failed 403:` prefix and Electron's
// `Error occurred in handler ...` wrapping. A bare `pairing-required`
// without the 403 status, or any other 403 error (unknown-credential,
// invalid-credential, channel-mismatch, grant/seed/digest failures, ENOSPC),
// never matches.
const PAIRING_REQUIRED_403_PATTERN = /failed\s+403\s*:\s*\{\s*"error"\s*:\s*"pairing-required"\s*\}/

export const isPairingRequired403 = (raw: string): boolean =>
  typeof raw === 'string' && PAIRING_REQUIRED_403_PATTERN.test(raw)

// Wrapped, keyboard-accessible error text: full content is rendered inline
// (never Tooltip-only) so long URLs remain readable without hover.
const errorTextStyle: CSSProperties = {
  color: 'var(--color-error)',
  fontSize: 12,
  overflowWrap: 'break-word',
  wordBreak: 'break-word'
}

const helpIconStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  marginLeft: 6,
  cursor: 'help',
  color: 'var(--color-text-2)'
}

// Compact keyboard-focusable help trigger: dense explanations live in the
// tooltip while only short next-action guidance stays visible inline. The
// tip doubles as the accessible label so tooltip content stays queryable
// without hovering.
const SyncHelpIcon: React.FC<{ tip: string; label: string }> = ({ tip, label }) => (
  <Tooltip title={tip}>
    <span tabIndex={0} role="img" aria-label={label} style={helpIconStyle}>
      <Info size={14} />
    </span>
  </Tooltip>
)

// Narrow-pane label treatment: the address label never wraps (it would
// squeeze the input at ~460px right-pane widths); the input keeps a usable
// minimum instead of collapsing to zero.
const nowrapLabelStyle: CSSProperties = {
  whiteSpace: 'nowrap',
  flexShrink: 0
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

// Configuration form (user intent: enabled/endpoint). Service state
// (attached/detached/device code) is a separate observation and is never
// mixed into this form: config edits persist via setConfig, service state
// changes only via connect/disconnect/live polling. There is no shared
// service access token: the server address plus the per-device code/secret
// request/accept flow is the only credential mechanism. Per-device secrets
// never pass through this component and are never displayed or logged.
interface SyncForm {
  endpoint: string
  enabled: boolean
}

const normalizeConfig = (form: SyncForm): SyncForm => ({
  endpoint: form.endpoint.trim(),
  enabled: form.enabled
})

const sameConfig = (a: SyncForm, b: SyncForm): boolean => a.endpoint === b.endpoint && a.enabled === b.enabled

// Data-status badge derived only from observed status/service/pairing fields:
// never claims convergence — idle means no pending work and no recorded
// error, not proof that every device converged. Waiting means the device is
// connected but not yet paired (or carries a durable pairing-required
// failure): sync cannot succeed until pairing completes, so this surfaces as
// awaiting pairing rather than a sync failure. Genuine errors (capture
// errors, or any non-pairing-required lastError) always stay failures, even
// when unpaired. A stale pairing-required lastError observed while live
// paired is treated as recovery (resolved on next sync), not failure.
export type SyncBadgeState = 'disabled' | 'syncing' | 'failed' | 'waiting' | 'pending' | 'idle'

export interface SyncBadgeInput {
  status: SyncDataStatus | null
  service: ServiceStatus | null
  pairing: PairState | null
}

export const resolveSyncBadge = ({ status, service, pairing }: SyncBadgeInput): SyncBadgeState | null => {
  if (!status || typeof status.enabled !== 'boolean') return null
  if (!status.enabled) return 'disabled'
  if (status.syncing) return 'syncing'
  const lastErrorPairingRequired = !!status.lastError && isPairingRequired403(status.lastError)
  const genuineError = !!status.lastCaptureError || (!!status.lastError && !lastErrorPairingRequired)
  if (genuineError) return 'failed'
  const serviceConnected = service?.state === 'connected'
  const knownUnpaired = !!(serviceConnected && pairing && pairing.state !== 'paired')
  const livePaired = !!(serviceConnected && pairing && pairing.state === 'paired')
  // Stale persisted pairing-required while live paired: recovery, not
  // failure and not waiting — fall through to pending/idle below.
  if (livePaired && lastErrorPairingRequired) {
    return status.pendingCount > 0 ? 'pending' : 'idle'
  }
  if (knownUnpaired || lastErrorPairingRequired) return 'waiting'
  if (status.pendingCount > 0) return 'pending'
  return 'idle'
}

/** True when manual sync cannot succeed because pairing is still pending. */
export const isKnownUnpaired = (service: ServiceStatus | null, pairing: PairState | null): boolean =>
  service?.state === 'connected' && !!pairing && pairing.state !== 'paired'

const SyncSettings: React.FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()

  const [endpoint, setEndpoint] = useState('')
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
  // has established the full persisted config. Until then the endpoint/
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
  const formRef = useRef<SyncForm>({ endpoint: '', enabled: false })
  // Last successfully persisted config: saves of unchanged values are no-ops.
  const persistedRef = useRef<SyncForm>({ endpoint: '', enabled: false })
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
      // A legacy persisted `token` field, if present, is ignored and never
      // re-persisted: only endpoint/enabled form this component's config.
      const cfgResult: { ok: true; cfg: { endpoint?: string; enabled?: boolean } } | { ok: false; error: unknown } =
        await window.api.sync.getConfig().then(
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
        enabled: !!cfg.enabled
      }
      setEndpoint(loaded.endpoint)
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
    // endpoint/enabled form, so active local edits are preserved.
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
    // cannot overwrite endpoint edits in progress.
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

  const onEndpointBlur = () => {
    const trimmed = formRef.current.endpoint.trim()
    if (trimmed !== formRef.current.endpoint) {
      formRef.current.endpoint = trimmed
      setEndpoint(trimmed)
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
      // Connection failures surface verbatim (safe Main-sanitized detail):
      // there is no shared access token anymore, so no credential guidance
      // applies here. Pairing-required and other membership errors stay
      // visible for the pairing section to classify.
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
  const knownUnpaired = isKnownUnpaired(service, pairing)
  const pairingStateLabel = !pairing
    ? '—'
    : pairing.state === 'paired'
      ? t('settings.sync.paired_state', 'Paired')
      : pairing.state === 'outgoing'
        ? t('settings.sync.outgoing_state', 'Request pending')
        : pairing.state === 'incoming'
          ? t('settings.sync.incoming_state', 'Approval needed')
          : t('settings.sync.unpaired_state', 'Not paired')
  const serviceStateLabel = !service
    ? '—'
    : service.state === 'connected'
      ? t('settings.sync.connected_state', 'Connected')
      : service.state === 'unregistered'
        ? t('settings.sync.unregistered_state', 'Not connected')
        : t('settings.sync.disconnected_state', 'Disconnected')

  const titleHelp = t(
    'settings.sync.help',
    'Automatic personal-device sync through your own relay is experimental with limited coverage and pending validation — not production-ready.'
  )
  const endpointTip = t(
    'settings.sync.endpoint_help',
    'Use http:// for direct LAN access or https:// when your deployment provides TLS.'
  )
  const pairingTip = t(
    'settings.sync.pairing_help',
    'Pairing joins your own devices into a private channel. To pair: connect the relay first to get this device code, then enter the other device code to request pairing; the other device accepts. Channels are private per device group. Device codes are public identifiers and cannot authorize anything by themselves.'
  )

  // Data-status badge derived only from observed status fields: never claims
  // convergence — idle means no pending work and no recorded error, not
  // proof that every device converged.
  const syncBadge = resolveSyncBadge({ status, service, pairing })
  const pairingRecoveredHint = t(
    'settings.sync.pairing_recovered_hint',
    'Pairing completed after a previous request: the pending sync will proceed on the next run.'
  )
  const syncBadgeMeta =
    syncBadge === 'disabled'
      ? { color: 'default' as const, text: t('settings.sync.status_disabled', 'Off') }
      : syncBadge === 'syncing'
        ? { color: 'processing' as const, text: t('settings.sync.syncing', 'Syncing...') }
        : syncBadge === 'failed'
          ? { color: 'error' as const, text: t('settings.sync.status_failed', 'Sync error') }
          : syncBadge === 'waiting'
            ? {
                color: 'warning' as const,
                text: t('settings.sync.waiting_state', 'Waiting for pairing')
              }
            : syncBadge === 'pending'
              ? { color: 'warning' as const, text: t('settings.sync.pending', 'Pending') }
              : syncBadge === 'idle'
                ? { color: 'default' as const, text: t('settings.sync.status_idle', 'Idle') }
                : null

  // Durable-error presentation: a pairing-required lastError is expected
  // waiting (waiting badge, raw stack hidden) unless a genuine unrelated
  // error or a capture error is also present — those always stay visible.
  // A stale pairing-required observed while live paired is recovery, not an
  // error at all.
  const lastErrorPairingRequired = !!status?.lastError && isPairingRequired403(status.lastError)
  const hasGenuineError = !!status?.lastCaptureError || (!!status?.lastError && !lastErrorPairingRequired)
  const livePaired = !!(serviceConnected && pairing?.state === 'paired')
  const stalePairingRecovery = !!(livePaired && lastErrorPairingRequired && !status?.lastCaptureError)
  // Manual sync cannot succeed while pairing is pending: the button stays
  // disabled. This is presentation only — the sync API itself is unchanged.
  const syncWaitingDisabled = enabled && knownUnpaired

  // The independent copy button copies the exact public code only, never
  // any secret (secrets never pass through this component). No code means
  // nothing copyable (the block is not rendered at all). The device-code
  // text itself is plain inherited-color text with no interaction.
  const handleCopyDeviceCode = useCallback(async () => {
    const code = service?.deviceCode
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      window.toast.success(t('message.copy.success', 'Copied!'))
    } catch {
      window.toast.error(t('message.copy.failed', 'Copy failed'))
    }
  }, [service?.deviceCode, t])

  return (
    <SettingGroup theme={theme}>
      <SettingTitle data-testid="sync-title-bar">
        <span style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
          <span>{t('settings.sync.title', 'Synchronization')}</span>
          <SyncHelpIcon tip={titleHelp} label={titleHelp} />
        </span>
        <Switch
          checked={enabled}
          onChange={onEnabledChange}
          disabled={!hydrated}
          data-testid="sync-enabled-switch"
          aria-label={t('settings.sync.enabled_switch_label', 'Enable sync')}
        />
      </SettingTitle>
      <SettingDivider />
      <div role="group" aria-labelledby="sync-section-relay">
        <SettingSubtitle id="sync-section-relay">{t('settings.sync.service_title', 'Sync server')}</SettingSubtitle>
        <SettingRow>
          <SettingRowTitle>
            <span style={nowrapLabelStyle}>{t('settings.sync.endpoint', 'Sync server address')}</span>
            <SyncHelpIcon tip={endpointTip} label={endpointTip} />
          </SettingRowTitle>
          <Input
            placeholder={t('settings.sync.endpoint_placeholder', 'http://127.0.0.1:3030')}
            value={endpoint}
            onChange={(e) => onEndpointChange(e.target.value)}
            onBlur={onEndpointBlur}
            disabled={!hydrated}
            style={{ flex: '1 1 200px', maxWidth: 320, minWidth: 120, marginLeft: 12 }}
            data-testid="sync-endpoint-input"
          />
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
          <Flex
            gap={8}
            align="center"
            wrap="wrap"
            data-testid="sync-service-status"
            data-state={service?.state ?? 'unknown'}>
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
            <span>{t('settings.sync.service_status', 'Service status')}</span>
            {service && (
              <Tag
                color={
                  service.state === 'connected' ? 'success' : service.state === 'unregistered' ? 'default' : 'error'
                }
                data-testid="sync-service-pill">
                {serviceStateLabel}
              </Tag>
            )}
          </Flex>
          {service?.deviceCode && (
            <Flex gap={8} align="center" wrap="wrap">
              <span data-testid="sync-device-code">
                {t('settings.sync.device_code_label', 'This device code')}: {service.deviceCode}
              </span>
              <Button
                type="text"
                size="small"
                data-testid="sync-device-code-copy"
                onClick={handleCopyDeviceCode}
                aria-label={t('common.copy', 'Copy')}
                icon={<Copy size={14} />}
              />
            </Flex>
          )}
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
          <span style={{ display: 'flex', alignItems: 'center' }}>
            <span>{t('settings.sync.pairing_title', 'Device pairing')}</span>
            <SyncHelpIcon tip={pairingTip} label={pairingTip} />
          </span>
        </SettingSubtitle>
        <div style={{ flex: 1, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Flex
            gap={8}
            align="center"
            wrap="wrap"
            data-testid="sync-pairing-status"
            data-state={pairing?.state ?? 'unknown'}>
            <span>{t('settings.sync.pairing_status', 'Pairing status')}</span>
            <Tag
              color={
                !pairing
                  ? 'default'
                  : pairing.state === 'paired'
                    ? 'success'
                    : pairing.state === 'outgoing'
                      ? 'processing'
                      : pairing.state === 'incoming'
                        ? 'warning'
                        : 'default'
              }
              data-testid="sync-pairing-pill"
              data-state={pairing?.state ?? 'unknown'}>
              {pairingStateLabel}
            </Tag>
          </Flex>
          {!serviceConnected && (
            <SettingHelpText>
              {t(
                'settings.sync.pairing_disabled_hint',
                'Connect to the server to show the device code and continue pairing.'
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
          {syncBadgeMeta && syncBadge && (
            <div>
              <Tag color={syncBadgeMeta.color} data-testid="sync-status-badge" data-state={syncBadge}>
                {syncBadgeMeta.text}
              </Tag>
            </div>
          )}
          <div style={{ flex: 1, fontSize: 12, color: 'var(--color-text-2)' }} data-testid="sync-status">
            {status ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span>
                  {t('settings.sync.pending', 'Pending')}:{' '}
                  <span data-testid="sync-pending-count">{status.pendingCount}</span>
                </span>
                <details style={{ fontSize: 12, color: 'var(--color-text-3)' }}>
                  <summary>{t('settings.sync.cursor', 'Cursor')}</summary>
                  <span data-testid="sync-cursor">{status.cursor}</span>
                </details>
                {status.lastSyncAt && (
                  <span>
                    {t('settings.sync.last_sync', 'Last sync')}:{' '}
                    {dayjs(status.lastSyncAt).format('YYYY-MM-DD HH:mm:ss')}
                  </span>
                )}
                {stalePairingRecovery && (
                  <span style={{ color: 'var(--color-text-2)' }} data-testid="sync-recovery-hint">
                    {pairingRecoveredHint}
                  </span>
                )}
                {status.lastError && !lastErrorPairingRequired && (
                  <span style={errorTextStyle} data-testid="sync-last-error">
                    {t('settings.sync.last_error', 'Last error')}: {status.lastError}
                  </span>
                )}
                {status.lastError && lastErrorPairingRequired && hasGenuineError && (
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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button
              type="primary"
              onClick={onSync}
              loading={syncing || !!status?.syncing}
              disabled={!enabled || !endpoint || syncWaitingDisabled}
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
