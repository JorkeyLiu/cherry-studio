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

  useEffect(() => {
    void load()
    const id = setInterval(() => {
      void load()
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
      window.toast.success(t('settings.sync.sync_success', 'Sync completed'))
    } catch (e) {
      window.toast.error(String((e as Error).message))
      await load()
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
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.sync.enabled', 'Enabled')}</SettingRowTitle>
        <Switch checked={enabled} onChange={setEnabled} />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.sync.endpoint', 'Relay Endpoint')}</SettingRowTitle>
        <Input
          placeholder="http://localhost:3000"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          style={{ width: 320 }}
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
          <Button type="primary" onClick={onSave} loading={saving}>
            {t('common.save', 'Save')}
          </Button>
          <Button onClick={onSync} loading={syncing || !!status?.syncing} disabled={!enabled || !endpoint}>
            {t('settings.sync.sync_now', 'Sync Now')}
          </Button>
          <Button onClick={() => void load()}>{t('common.refresh', 'Refresh')}</Button>
        </div>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.sync.status', 'Status')}</SettingRowTitle>
        <div style={{ flex: 1, fontSize: 12, color: 'var(--color-text-2)' }}>
          {status ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>
                {t('settings.sync.pending', 'Pending')}: {status.pendingCount} | {t('settings.sync.cursor', 'Cursor')}:{' '}
                {status.cursor}
              </span>
              {status.lastSyncAt && (
                <span>
                  {t('settings.sync.last_sync', 'Last sync')}: {dayjs(status.lastSyncAt).format('YYYY-MM-DD HH:mm:ss')}
                </span>
              )}
              {status.lastError && (
                <Tooltip title={status.lastError}>
                  <span style={{ color: 'var(--color-error)' }}>
                    {t('settings.sync.last_error', 'Last error')}: {status.lastError.slice(0, 200)}
                  </span>
                </Tooltip>
              )}
              {status.syncing && <span>{t('settings.sync.syncing', 'Syncing...')}</span>}
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
