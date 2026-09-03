import { useTheme } from '@renderer/context/ThemeProvider'
import { loggerService } from '@renderer/services/LoggerService'
import { Button, Input, Switch, Tooltip } from 'antd'
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
    pendingCount: number
    cursor: number
    syncing: boolean
  } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [saving, setSaving] = useState(false)

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

  useEffect(() => {
    void load()
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
          'Synchronize chat topics, messages and blocks via a configured HTTP relay. Manual sync only.'
        )}
      </SettingHelpText>
      <SettingRow>
        <SettingHelpText>
          {t(
            'settings.sync.scope_note',
            'Synced: topic create, message append with blocks, single message/block edits, single/batch block adds, simple message/block deletes, message reorder, topic soft-delete/restore/hard-delete. No-op or foreign-target requests are not sent. Not synced: ownership transfer, assistant reset, purge/empty trash, segments, attachments, search index, UI state, or compound copy/paste/branch/clone/insert-after/resend/select flows.'
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
          {t('settings.sync.endpoint_help', 'Application stores and calls one URL; no cloud/self-hosted distinction.')}
        </SettingHelpText>
      </SettingRow>
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
