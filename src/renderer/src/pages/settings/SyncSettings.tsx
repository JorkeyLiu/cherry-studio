/**
 * Phase 6 — Cross-device Sync Settings UI
 *
 * Provides transport selection, connection configuration, and
 * live sync status indicators.
 */

import { loggerService } from '@logger'
import { useTheme } from '@renderer/context/ThemeProvider'
import type { RootState } from '@renderer/store'
import { useAppDispatch } from '@renderer/store'
import { setSyncSettings } from '@renderer/store/settings'
import type { SyncEngine, SyncState } from '@renderer/sync'
import {
  destroyGlobalSyncEngine,
  getChangeQueue,
  getDeviceId,
  getGlobalSyncEngine,
  getLastSyncTimestamp,
  initSyncEngine,
  peekDeviceId
} from '@renderer/sync'
import { Button, Input, Radio, Tag, Typography } from 'antd'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'

import { SettingContainer, SettingDivider, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from './index'

const logger = loggerService.withContext('SyncSettings')

const { Text } = Typography

type SyncTransportMode = 'disabled' | 'couchdb' | 'rest'

const TRANSPORT_OPTIONS: { value: SyncTransportMode; labelKey: string }[] = [
  { value: 'disabled', labelKey: 'sync.transport.disabled' },
  { value: 'couchdb', labelKey: 'sync.transport.couchdb' },
  { value: 'rest', labelKey: 'sync.transport.rest' }
]

const SyncSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const dispatch = useAppDispatch()
  const syncConfig = useSelector((state: RootState) => state.settings.sync)

  // Local form state
  const [transport, setTransport] = useState<SyncTransportMode>(syncConfig.transport)
  const [url, setUrl] = useState(syncConfig.url)
  const [username, setUsername] = useState(syncConfig.username)
  const [password, setPassword] = useState(syncConfig.password)
  const [apiKey, setApiKey] = useState(syncConfig.apiKey)

  // Sync status state
  const [deviceId, setDeviceId] = useState<string>('')
  const [lastSyncTime, setLastSyncTime] = useState<number>(0)
  const [pendingCount, setPendingCount] = useState<number>(0)
  const [syncStatus, setSyncStatus] = useState<SyncState>('idle')

  // Load device info & status on mount
  useEffect(() => {
    const loadInfo = async () => {
      const devId = (await peekDeviceId()) || (await getDeviceId())
      setDeviceId(devId)
      const ts = await getLastSyncTimestamp()
      setLastSyncTime(ts)
      try {
        const queue = getChangeQueue()
        const count = await queue.getPendingCount()
        setPendingCount(count)
      } catch {
        // ChangeCollector not initialized yet
      }
    }
    void loadInfo()

    // Refresh pending count every 5 s
    const interval = setInterval(async () => {
      try {
        const queue = getChangeQueue()
        const count = await queue.getPendingCount()
        setPendingCount(count)
      } catch {
        // ignore
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  /**
   * Wire events on the current global SyncEngine (or no-op if null).
   * Shared between auto-start and manual "Sync Now" paths.
   */
  const wireEngineEvents = (engine: SyncEngine) => {
    engine.on('onStateChange', (state) => setSyncStatus(state))
    engine.on('onSyncComplete', async () => {
      const ts = await getLastSyncTimestamp()
      setLastSyncTime(ts)
      try {
        const queue = getChangeQueue()
        setPendingCount(await queue.getPendingCount())
      } catch {
        /* ignore */
      }
    })
    engine.on('onError', (err) => logger.error('SyncEngine error', err))
  }

  // Auto-start SyncEngine when configuration is valid.
  // Uses a 1s debounce to avoid rapid restart during URL typing.
  useEffect(() => {
    if (transport === 'disabled' || !url) {
      // Config no longer valid — destroy the engine
      destroyGlobalSyncEngine().catch(() => {})
      return
    }

    let cancelled = false

    const startEngine = async () => {
      try {
        const engine = await initSyncEngine({
          transport,
          url,
          username,
          password,
          apiKey
        })
        if (cancelled || !engine) return

        wireEngineEvents(engine)
        await engine.start()
      } catch (err) {
        if (!cancelled) {
          logger.error('Failed to auto-start SyncEngine', err as Error)
          setSyncStatus('error')
        }
      }
    }

    // Debounce 1s to avoid rapid restart while the user is typing
    const timer = setTimeout(startEngine, 1000)

    return () => {
      cancelled = true
      clearTimeout(timer)
      // Do NOT stop the engine — it is a global singleton that should
      // keep running even when this component unmounts.
    }
  }, [transport, url, username, password, apiKey])

  // Persist changes to Redux
  const persistConfig = (cfg: typeof syncConfig) => {
    dispatch(setSyncSettings(cfg))
  }

  const onTransportChange = (value: SyncTransportMode) => {
    setTransport(value)
    persistConfig({ ...syncConfig, transport: value })
  }

  const onUrlChange = (value: string) => {
    setUrl(value)
    persistConfig({ ...syncConfig, url: value })
  }

  const onUsernameChange = (value: string) => {
    setUsername(value)
    persistConfig({ ...syncConfig, username: value })
  }

  const onPasswordChange = (value: string) => {
    setPassword(value)
    persistConfig({ ...syncConfig, password: value })
  }

  const onApiKeyChange = (value: string) => {
    setApiKey(value)
    persistConfig({ ...syncConfig, apiKey: value })
  }

  const onSyncNow = async () => {
    let engine = getGlobalSyncEngine()
    if (!engine) {
      // Engine not initialized — try to initialize and start
      try {
        engine = await initSyncEngine({
          transport,
          url,
          username,
          password,
          apiKey
        })
        if (engine) {
          wireEngineEvents(engine)
          await engine.start()
        }
      } catch (err) {
        logger.error('Failed to start sync engine', err as Error)
        setSyncStatus('error')
        return
      }
    }

    if (!engine) {
      logger.warn('Sync engine not available — check your configuration')
      return
    }

    try {
      await engine.sync()
    } catch (err) {
      logger.error('Sync failed', err as Error)
      // state is already set to 'error' by the engine
    }
  }

  // ── Status tag colour ──────────────────────────────────────

  const statusColor: Record<string, string> = {
    idle: 'default',
    connecting: 'processing',
    syncing: 'processing',
    error: 'error',
    disconnected: 'warning'
  }

  const formatLastSync = (ts: number): string => {
    if (!ts) return t('sync.never')
    const diff = Date.now() - ts
    if (diff < 10_000) return t('sync.justNow')
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 60) return t('sync.minutesAgo', { count: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('sync.hoursAgo', { count: hours })
    return new Date(ts).toLocaleString()
  }

  const showAuth = transport === 'couchdb'
  const showApiKey = transport === 'rest'

  return (
    <SettingContainer theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('sync.title')}</SettingTitle>
        <SettingDivider />
        <Text type="secondary" style={{ fontSize: 12, marginBottom: 12, display: 'block' }}>
          {t('sync.description')}
        </Text>

        {/* Transport selection */}
        <SettingRow>
          <SettingRowTitle>{t('sync.transport.title')}</SettingRowTitle>
          <Radio.Group value={transport} onChange={(e) => onTransportChange(e.target.value)}>
            {TRANSPORT_OPTIONS.map((opt) => (
              <Radio key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </Radio>
            ))}
          </Radio.Group>
        </SettingRow>

        {transport !== 'disabled' && (
          <>
            <SettingDivider />

            {/* Server URL */}
            <SettingRow>
              <SettingRowTitle>{t('sync.url')}</SettingRowTitle>
              <Input
                spellCheck={false}
                placeholder={
                  transport === 'couchdb' ? 'http://localhost:5984/cherry-studio' : 'https://sync.example.com/api'
                }
                value={url}
                onChange={(e) => onUrlChange(e.target.value)}
                style={{ width: 280 }}
              />
            </SettingRow>

            {showAuth && (
              <>
                <SettingDivider />
                <SettingRow>
                  <SettingRowTitle>{t('sync.username')}</SettingRowTitle>
                  <Input
                    spellCheck={false}
                    value={username}
                    onChange={(e) => onUsernameChange(e.target.value)}
                    style={{ width: 220 }}
                  />
                </SettingRow>
                <SettingDivider />
                <SettingRow>
                  <SettingRowTitle>{t('sync.password')}</SettingRowTitle>
                  <Input.Password
                    value={password}
                    onChange={(e) => onPasswordChange(e.target.value)}
                    style={{ width: 220 }}
                  />
                </SettingRow>
              </>
            )}

            {showApiKey && (
              <>
                <SettingDivider />
                <SettingRow>
                  <SettingRowTitle>{t('sync.apiKey')}</SettingRowTitle>
                  <Input.Password
                    value={apiKey}
                    onChange={(e) => onApiKeyChange(e.target.value)}
                    style={{ width: 280 }}
                  />
                </SettingRow>
              </>
            )}

            <SettingDivider />

            {/* Status */}
            <SettingRow>
              <SettingRowTitle>{t('sync.status.title')}</SettingRowTitle>
              <Tag color={statusColor[syncStatus]}>{t(`sync.status.${syncStatus}`)}</Tag>
            </SettingRow>

            <SettingDivider />

            {/* Last sync time */}
            <SettingRow>
              <SettingRowTitle>{t('sync.lastSync')}</SettingRowTitle>
              <Text style={{ fontSize: 13 }}>{formatLastSync(lastSyncTime)}</Text>
            </SettingRow>

            <SettingDivider />

            {/* Pending changes */}
            <SettingRow>
              <SettingRowTitle>{t('sync.pendingChanges')}</SettingRowTitle>
              <Tag>{pendingCount}</Tag>
            </SettingRow>

            <SettingDivider />

            {/* Device ID */}
            <SettingRow>
              <SettingRowTitle>{t('sync.deviceId')}</SettingRowTitle>
              <Text code style={{ fontSize: 12, maxWidth: 260 }} ellipsis={{ tooltip: deviceId }}>
                {deviceId}
              </Text>
            </SettingRow>

            <SettingDivider />

            {/* Manual sync button */}
            <SettingRow>
              <div />
              <Button type="primary" loading={syncStatus === 'syncing'} onClick={onSyncNow}>
                {t('sync.syncNow')}
              </Button>
            </SettingRow>
          </>
        )}
      </SettingGroup>
    </SettingContainer>
  )
}

export default SyncSettings
