import { useTheme } from '@renderer/context/ThemeProvider'
import { loggerService } from '@renderer/services/LoggerService'
import { isNonLoopbackHttpEndpoint } from '@shared/sync'
import { Alert, Button, Input, Switch, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingDivider, SettingGroup, SettingHelpText, SettingRow, SettingRowTitle, SettingTitle } from '..'

const logger = loggerService.withContext('SyncSettings')

const SyncSettings: React.FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()

  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<{
    enabled: boolean
    endpoint: string
    lastSyncAt: string | null
    lastError: string | null
    lastCaptureError: string | null
    pendingCount: number
    cursor: number
    syncing: boolean
    conflictCount: number
  } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deviceId, setDeviceId] = useState('')
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [pairing, setPairing] = useState<{ trusted: boolean; pending: boolean } | null>(null)
  const [trusted, setTrusted] = useState<Array<{ deviceId: string; deviceName?: string }>>([])
  const [pending, setPending] = useState<
    Array<{ id: string; deviceId: string; deviceName?: string; expiresAt: string }>
  >([])
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [pairingBusy, setPairingBusy] = useState(false)

  const load = async () => {
    try {
      const cfg = await window.api.sync.getConfig()
      setEndpoint(cfg.endpoint ?? '')
      setToken(cfg.token ?? '')
      setEnabled(!!cfg.enabled)
      const st = await window.api.sync.getStatus()
      setStatus(st)
    } catch (e) {
      logger.error('load sync config failed', e as Error)
    }
  }

  const loadStatusOnly = async () => {
    try {
      const st = await window.api.sync.getStatus()
      setStatus(st)
    } catch (e) {
      logger.error('load sync status failed', e as Error)
    }
  }

  const loadPairing = async () => {
    try {
      setPairingError(null)
      const idRes = await window.api.sync.getDeviceId()
      setDeviceId(String(idRes?.deviceId ?? ''))
      const st = await window.api.sync.getPairingStatus()
      setPairing({ trusted: !!st?.trusted, pending: !!st?.pending })
      try {
        const list = await window.api.sync.listTrusted()
        setTrusted(Array.isArray(list?.devices) ? list.devices : [])
      } catch {
        setTrusted([])
      }
      try {
        const reqs = await window.api.sync.listPairingRequests()
        setPending(Array.isArray(reqs?.requests) ? reqs.requests : [])
      } catch {
        setPending([])
      }
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 500)
      setPairingError(msg)
      logger.error('load pairing failed', e as Error)
    }
  }

  useEffect(() => {
    void load()
    void loadPairing()
    // Poll status only — never overwrite the dirty endpoint/token form while
    // the user is editing. Config is reloaded explicitly on save/refresh.
    const id = setInterval(() => {
      void loadStatusOnly()
    }, 5000)
    return () => clearInterval(id)
  }, [])

  const onSave = async () => {
    setSaving(true)
    try {
      await window.api.sync.setConfig({ endpoint: endpoint.trim(), token: token.trim(), enabled })
      window.toast.success(t('settings.sync.save_success', 'Sync settings saved'))
      await load()
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
      await loadStatusOnly()
    } finally {
      setSyncing(false)
    }
  }

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
          <Button onClick={() => void load()}>{t('common.refresh', 'Refresh')}</Button>
        </div>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.sync.pairing_title', 'Device pairing')}</SettingRowTitle>
        <div style={{ flex: 1, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SettingHelpText>
            {t(
              'settings.sync.pairing_help',
              'Pairing is an explicit user action on both devices. The relay token alone never grants sync access; an untrusted device is rejected with device-not-trusted.'
            )}
          </SettingHelpText>
          <span data-testid="sync-device-id">
            {t('settings.sync.device_label', 'This device')}: {deviceId || '—'}
          </span>
          <span data-testid="sync-pairing-status">
            {t('settings.sync.pairing_status', 'Pairing status')}:{' '}
            {pairing
              ? pairing.trusted
                ? t('settings.sync.trusted_state', 'Trusted')
                : pairing.pending
                  ? t('settings.sync.pending_state', 'Pending')
                  : t('settings.sync.untrusted_state', 'Not trusted')
              : '—'}
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              onClick={async () => {
                setPairingBusy(true)
                setPairingError(null)
                try {
                  const res = await window.api.sync.createInvite()
                  setInvite(res)
                } catch (e) {
                  setPairingError(String((e as Error).message).slice(0, 500))
                } finally {
                  setPairingBusy(false)
                }
              }}
              loading={pairingBusy}
              data-testid="sync-create-invite">
              {t('settings.sync.create_invite', 'Create invite code')}
            </Button>
            <Button onClick={() => void loadPairing()} data-testid="sync-pairing-refresh">
              {t('settings.sync.refresh', 'Refresh')}
            </Button>
          </div>
          {invite && (
            <span data-testid="sync-invite-code">
              {t('settings.sync.invite_code', 'Invite code')}: {invite.code} |{' '}
              {t('settings.sync.invite_expires', 'Expires')}: {dayjs(invite.expiresAt).format('YYYY-MM-DD HH:mm:ss')}
            </span>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Input
              placeholder={t('settings.sync.join_code_placeholder', 'Enter 8-character code')}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              style={{ width: 200 }}
              data-testid="sync-join-code-input"
            />
            <Input
              placeholder={t('settings.sync.device_name_placeholder', 'e.g. work laptop')}
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              style={{ width: 200 }}
              data-testid="sync-device-name-input"
            />
            <Button
              onClick={async () => {
                setPairingBusy(true)
                setPairingError(null)
                try {
                  await window.api.sync.requestPairing({ code: joinCode, deviceName: deviceName || undefined })
                  setJoinCode('')
                  await loadPairing()
                } catch (e) {
                  setPairingError(String((e as Error).message).slice(0, 500))
                } finally {
                  setPairingBusy(false)
                }
              }}
              loading={pairingBusy}
              data-testid="sync-request-pairing">
              {t('settings.sync.request_pairing', 'Request pairing')}
            </Button>
          </div>
          <span>
            {t('settings.sync.pending_requests', 'Pending requests')}:{' '}
            <span data-testid="sync-pending-count-pairing">{pending.length}</span>
          </span>
          {pending.length === 0 ? (
            <span>{t('settings.sync.no_pending', 'No pending requests')}</span>
          ) : (
            pending.map((r) => (
              <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span data-testid={`sync-pending-${r.id}`}>
                  {r.deviceId}
                  {r.deviceName ? ` (${r.deviceName})` : ''}
                </span>
                <Button
                  size="small"
                  type="primary"
                  onClick={async () => {
                    setPairingBusy(true)
                    try {
                      await window.api.sync.acceptPairing(r.id)
                      await loadPairing()
                    } catch (e) {
                      setPairingError(String((e as Error).message).slice(0, 500))
                    } finally {
                      setPairingBusy(false)
                    }
                  }}
                  data-testid={`sync-accept-${r.id}`}>
                  {t('settings.sync.accept', 'Accept')}
                </Button>
                <Button
                  size="small"
                  onClick={async () => {
                    setPairingBusy(true)
                    try {
                      await window.api.sync.rejectPairing(r.id)
                      await loadPairing()
                    } catch (e) {
                      setPairingError(String((e as Error).message).slice(0, 500))
                    } finally {
                      setPairingBusy(false)
                    }
                  }}
                  data-testid={`sync-reject-${r.id}`}>
                  {t('settings.sync.reject', 'Reject')}
                </Button>
              </div>
            ))
          )}
          <span>
            {t('settings.sync.trusted_devices', 'Trusted devices')}:{' '}
            <span data-testid="sync-trusted-count">{trusted.length}</span>
          </span>
          {trusted.length === 0 ? (
            <span>{t('settings.sync.no_trusted', 'No trusted devices yet')}</span>
          ) : (
            trusted.map((d) => (
              <div key={d.deviceId} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span data-testid={`sync-trusted-${d.deviceId}`}>
                  {d.deviceId}
                  {d.deviceName ? ` (${d.deviceName})` : ''}
                  {d.deviceId === deviceId ? ' *' : ''}
                </span>
                {d.deviceId !== deviceId && (
                  <Button
                    size="small"
                    onClick={async () => {
                      setPairingBusy(true)
                      try {
                        await window.api.sync.revokeDevice(d.deviceId)
                        await loadPairing()
                      } catch (e) {
                        setPairingError(String((e as Error).message).slice(0, 500))
                      } finally {
                        setPairingBusy(false)
                      }
                    }}
                    data-testid={`sync-revoke-${d.deviceId}`}>
                    {t('settings.sync.revoke', 'Revoke')}
                  </Button>
                )}
              </div>
            ))
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
