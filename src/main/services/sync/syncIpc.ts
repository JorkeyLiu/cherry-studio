import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import { ipcMain } from 'electron'

import { validateEndpointUrl } from './SyncClient'
import { syncService } from './SyncService'

const logger = loggerService.withContext('SyncIpc')

export function registerSyncIpc(): () => void {
  const handlers: string[] = []

  const register = (channel: string, handler: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => any) => {
    ipcMain.handle(channel, handler)
    handlers.push(channel)
  }

  register(IpcChannel.Sync_GetConfig, async () => {
    const cfg = syncService.getConfig()
    return cfg
  })

  register(
    IpcChannel.Sync_SetConfig,
    async (_e, config: { endpoint?: string; enabled?: boolean } & Record<string, unknown>) => {
      if (!config || typeof config !== 'object') throw new Error('invalid config')
      if ('token' in config) throw new Error('unknown config key: token is no longer supported')
      if (config.endpoint !== undefined) {
        if (typeof config.endpoint !== 'string') throw new Error('endpoint must be string')
        if (config.endpoint !== '') {
          const err = validateEndpointUrl(config.endpoint)
          if (err) throw new Error(err)
        }
      }
      if (config.enabled !== undefined && typeof config.enabled !== 'boolean')
        throw new Error('enabled must be boolean')
      const updated = syncService.setConfig(config)
      logger.info('[Sync_SetConfig] updated')
      try {
        const { syncAutoService } = await import('./syncAuto')
        syncAutoService.refresh()
      } catch {}
      return updated
    }
  )

  register(IpcChannel.Sync_GetStatus, async () => {
    return syncService.getStatus()
  })

  register(IpcChannel.Sync_Sync, async () => {
    const result = await syncService.sync()
    return result
  })

  register(IpcChannel.Sync_GetDeviceId, async () => {
    return { deviceId: syncService.getDeviceId() }
  })

  register(IpcChannel.Sync_Connect, async () => {
    const status = await syncService.connect()
    try {
      const { syncAutoService } = await import('./syncAuto')
      syncAutoService.refresh()
    } catch {}
    return status
  })

  register(IpcChannel.Sync_Disconnect, async () => {
    const status = await syncService.disconnect()
    try {
      const { syncAutoService } = await import('./syncAuto')
      syncAutoService.refresh()
    } catch {}
    return status
  })

  register(IpcChannel.Sync_GetServiceStatus, async () => {
    return syncService.getServiceStatus()
  })

  register(IpcChannel.Sync_GetDeviceCode, async () => {
    return { deviceCode: syncService.getDeviceCodeOrNull() }
  })

  register(IpcChannel.Sync_GetPairState, async () => {
    return await syncService.getPairState()
  })

  register(IpcChannel.Sync_RequestPairing, async (_e, args: { targetCode?: string }) => {
    if (!args || typeof args !== 'object') throw new Error('invalid pairing request')
    if (typeof args.targetCode !== 'string') throw new Error('target code must be string')
    return await syncService.requestPairing(args.targetCode)
  })

  register(IpcChannel.Sync_CancelPairing, async (_e, args?: { requestId?: string }) => {
    if (args !== undefined && (typeof args !== 'object' || args === null)) {
      throw new Error('invalid cancel request')
    }
    if (args?.requestId !== undefined && typeof args.requestId !== 'string') {
      throw new Error('request id must be string')
    }
    return await syncService.cancelPairing(args?.requestId)
  })

  register(IpcChannel.Sync_AcceptPairing, async (_e, args: { requestId?: string }) => {
    if (!args || typeof args.requestId !== 'string') throw new Error('request id must be string')
    return await syncService.acceptPairing(args.requestId)
  })

  register(IpcChannel.Sync_RejectPairing, async (_e, args: { requestId?: string }) => {
    if (!args || typeof args.requestId !== 'string') throw new Error('request id must be string')
    await syncService.rejectPairing(args.requestId)
    return { ok: true }
  })

  register(IpcChannel.Sync_Unpair, async () => {
    await syncService.unpair()
    return { ok: true }
  })

  // AssistantConfig bridge (production): canonical SQLite binding before any IPC
  // startup; barrier gate BEFORE Tx; mirror+outbox same Tx; remote merges bypass
  // the gate by design. Unavailable mirror retains pending (no memory fallback).
  try {
    syncService.initAssistantConfigMirrorBinding()
  } catch {}
  register(IpcChannel.SyncAssistantConfig_CommitDelta, async (_e, delta: unknown) => {
    const { validateAssistantConfigDelta } = await import('@shared/sync/assistantConfig')
    const err = validateAssistantConfigDelta(delta)
    if (err) throw new Error(`invalid assistant config delta: ${err}`)
    const d = delta as {
      kind: 'assistant' | 'defaults'
      id: string
      mutationId: string
      revision: number
      timestamp: number
      fields: Record<string, unknown>
      deleted?: boolean
    }
    const result = syncService.commitAssistantConfigDeltaProduction({
      kind: d.kind,
      id: d.id,
      mutationId: d.mutationId,
      revision: d.revision,
      timestamp: d.timestamp,
      fields: d.fields ?? {},
      ...(d.deleted !== undefined ? { deleted: d.deleted } : {})
    })
    // Post-commit broadcast (never before commit); loss covered by getProjection.
    try {
      syncService.broadcastAssistantProjection([result.key])
    } catch {}
    return result
  })

  register(IpcChannel.SyncAssistantConfig_GetProjection, async (_e, keys?: unknown) => {
    if (keys !== undefined && !Array.isArray(keys)) throw new Error('keys must be array')
    return syncService.readAssistantProjectionBatch(keys as string[] | undefined)
  })

  register(IpcChannel.SyncAssistantConfig_AckProjection, async (_e, key: unknown, revision: unknown) => {
    if (typeof key !== 'string') throw new Error('key must be string')
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) throw new Error('revision must be int')
    const batch = syncService.readAssistantProjectionBatch([key])
    const current = batch[0]?.projectionRevision ?? null
    if (current === null) return { cleared: false, current: null }
    if (revision !== current) return { cleared: false, current }
    return { cleared: true, current }
  })

  register(IpcChannel.SyncAssistantConfig_Snapshot, async () => {
    return syncService.readAssistantProjectionBatch().map((r) => r.payload)
  })

  logger.info(`Registered ${handlers.length} Sync IPC handlers`)

  return () => {
    for (const ch of handlers) ipcMain.removeHandler(ch)
    logger.info('Removed Sync IPC handlers')
  }
}
