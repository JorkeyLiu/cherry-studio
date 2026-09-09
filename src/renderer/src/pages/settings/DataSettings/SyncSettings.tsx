import { useTheme } from '@renderer/context/ThemeProvider'
import { loggerService } from '@renderer/services/LoggerService'
import { isNonLoopbackHttpEndpoint } from '@shared/sync'
import { Alert, Button, Input, Switch, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingDivider, SettingGroup, SettingHelpText, SettingRow, SettingRowTitle, SettingTitle } from '..'

const logger = loggerService.withContext('SyncSettings')

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
  const [saving, setSaving] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [targetCode, setTargetCode] = useState('')
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [pairingBusy, setPairingBusy] = useState(false)
  // Latest-only refresh generation: Connect/Disconnect bump the generation
  // so an older in-flight live/config/pair response can never overwrite the
  // newer attached/detached observation.
  const refreshGen = useRef(0)
  const bumpRefreshGen = useCallback(() => {
    refreshGen.current += 1
    return refreshGen.current
  }, [])

  const loadConfigAndStatus = useCallback(async () => {
    const gen = refreshGen.current
    try {
      const [cfg, st, svc] = await Promise.all([
        window.api.sync.getConfig(),
        window.api.sync.getStatus().catch(() => null),
        window.api.sync.getServiceStatus().catch(() => null)
      ])
      if (gen !== refreshGen.current) return
      setEndpoint(cfg.endpoint ?? '')
      setToken(cfg.token ?? '')
      setEnabled(!!cfg.enabled)
      if (st) setStatus(st)
      if (svc) setService(svc)
    } catch (e) {
      if (gen !== refreshGen.current) return
      logger.error('load sync config failed', e as Error)
    }
  }, [])

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
    if (svc) setService(svc)
    // Disconnected/offline retains the last known pairing observation: only
    // a successful (non-null) fetch replaces it, so membership semantics are
    // never reset to unknown by a failed poll.
    if (pair !== null) setPairing(pair)
  }, [])

  const loadPairing = useCallback(async () => {
    const gen = refreshGen.current
    try {
      setPairingError(null)
      const pair = await window.api.sync.getPairState()
      if (gen !== refreshGen.current) return
      setPairing(pair)
      const svc = await window.api.sync.getServiceStatus().catch(() => null)
      if (gen !== refreshGen.current) return
      if (svc) setService(svc)
    } catch (e) {
      if (gen !== refreshGen.current) return
      const msg = String((e as Error).message ?? e).slice(0, 500)
      setPairingError(msg)
      logger.error('load pairing failed', e as Error)
    }
  }, [])

  useEffect(() => {
    void loadConfigAndStatus()
    void loadPairing()
    // Poll live state only — never overwrite the dirty endpoint/token form
    // while the user is editing. Config is reloaded explicitly on save.
    const id = setInterval(() => {
      void loadLiveState()
    }, 5000)
    return () => clearInterval(id)
  }, [loadConfigAndStatus, loadLiveState, loadPairing])

  const onSave = async () => {
    setSaving(true)
    try {
      await window.api.sync.setConfig({ endpoint: endpoint.trim(), token: token.trim(), enabled })
      window.toast.success(t('settings.sync.save_success', 'Sync settings saved'))
      await loadConfigAndStatus()
    } catch (e) {
      window.toast.error(String((e as Error).message))
    } finally {
      setSaving(false)
    }
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
      setService(svc)
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
      setService(svc)
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
          'Synchronize chat topics, messages and blocks via a configured HTTP relay. Automatic personal multi-device sync; pending validation, not production-ready.'
        )}
      </SettingHelpText>
      <SettingRow>
        <SettingHelpText>
          {t(
            'settings.sync.scope_note',
            'Synced: topic create, message append with blocks, single message/block edits at stable checkpoints (success/error/paused only; streaming/pending/processing/searching states are not sent), single/batch block adds, simple message/block deletes, topic soft-delete/restore/hard-delete. No-op or foreign-target requests are not sent. Not synced: message reorder/ordering (unsupported), ownership transfer, assistant reset, purge/empty trash, segments, attachments, search index, UI state, or compound copy/paste/branch/clone/insert-after/resend/select flows.'
          )}
        </SettingHelpText>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.sync.enabled', 'Enabled')}</SettingRowTitle>
        <Switch checked={enabled} onChange={setEnabled} data-testid="sync-enabled-switch" />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.sync.endpoint', 'Relay Endpoint')}</SettingRowTitle>
        <Input
          placeholder={t('settings.sync.endpoint_placeholder', 'http://127.0.0.1:3030')}
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          style={{ width: 320 }}
          data-testid="sync-endpoint-input"
        />
      </SettingRow>
      <SettingRow>
        <SettingHelpText>
          {t(
            'settings.sync.endpoint_help',
            'Use http:// for direct LAN access or https:// when your deployment provides TLS. Plain HTTP is unencrypted.'
          )}
        </SettingHelpText>
      </SettingRow>
      {isNonLoopbackHttpEndpoint(endpoint) && (
        <SettingRow>
          <Alert
            type="warning"
            showIcon
            data-testid="sync-http-warning"
            message={t(
              'settings.sync.http_warning',
              'This endpoint uses unencrypted HTTP on a non-local host. Anyone on the network path can read or modify synced data. Use HTTPS when available.'
            )}
          />
        </SettingRow>
      )}
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.sync.token', 'Access Token')}</SettingRowTitle>
        <Input.Password
          placeholder={t('settings.sync.token_placeholder', 'Optional bearer token')}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ width: 320 }}
          data-testid="sync-token-input"
        />
      </SettingRow>
      <SettingRow>
        <SettingHelpText>
          {t('settings.sync.token_help', 'Token is never included in sync payload or logs.')}
        </SettingHelpText>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.sync.actions', 'Actions')}</SettingRowTitle>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="primary" onClick={onSave} loading={saving} data-testid="sync-save-button">
            {t('common.save', 'Save')}
          </Button>
          <Button
            onClick={onSync}
            loading={syncing || !!status?.syncing}
            disabled={!enabled || !endpoint}
            data-testid="sync-now-button">
            {t('settings.sync.sync_now', 'Sync Now')}
          </Button>
          <Button onClick={() => void loadConfigAndStatus()}>{t('common.refresh', 'Refresh')}</Button>
        </div>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.sync.service_title', 'Relay service')}</SettingRowTitle>
        <div style={{ flex: 1, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span
              data-testid="sync-service-indicator"
              data-state={service?.state ?? 'unknown'}
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                backgroundColor: serviceConnected ? 'var(--color-success, #52c41a)' : 'var(--color-error, #ff4d4f)'
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
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.sync.pairing_title', 'Device pairing')}</SettingRowTitle>
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
                style={{ width: 200 }}
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
            <span style={{ color: 'var(--color-error)' }} data-testid="sync-pairing-error">
              {pairingError.slice(0, 500)}
            </span>
          )}
        </div>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.sync.status', 'Status')}</SettingRowTitle>
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
                  {t('settings.sync.last_sync', 'Last sync')}: {dayjs(status.lastSyncAt).format('YYYY-MM-DD HH:mm:ss')}
                </span>
              )}
              {status.lastError && (
                <Tooltip title={status.lastError}>
                  <span style={{ color: 'var(--color-error)' }} data-testid="sync-last-error">
                    {t('settings.sync.last_error', 'Last error')}: {status.lastError.slice(0, 200)}
                  </span>
                </Tooltip>
              )}
              {status.lastCaptureError && (
                <Tooltip title={status.lastCaptureError}>
                  <span style={{ color: 'var(--color-error)' }} data-testid="sync-capture-error">
                    {t('settings.sync.capture_error', 'Capture error')}: {status.lastCaptureError.slice(0, 200)}
                  </span>
                </Tooltip>
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
      </SettingRow>
    </SettingGroup>
  )
}

export default SyncSettings
