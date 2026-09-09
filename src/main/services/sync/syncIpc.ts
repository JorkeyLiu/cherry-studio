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
    // never leak token in logs; mask in response? Keep token for renderer to edit, but UI will mask
    return cfg
  })

  register(IpcChannel.Sync_SetConfig, async (_e, config: { endpoint?: string; token?: string; enabled?: boolean }) => {
    if (!config || typeof config !== 'object') throw new Error('invalid config')
    if (config.endpoint !== undefined) {
      if (typeof config.endpoint !== 'string') throw new Error('endpoint must be string')
      if (config.endpoint !== '') {
        const err = validateEndpointUrl(config.endpoint)
        if (err) throw new Error(err)
      }
    }
    if (config.token !== undefined && typeof config.token !== 'string') throw new Error('token must be string')
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new Error('enabled must be boolean')
    const updated = syncService.setConfig(config)
    logger.info('[Sync_SetConfig] updated')
    try {
      const { syncAutoService } = await import('./syncAuto')
      syncAutoService.refresh()
    } catch {}
    return updated
  })

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

  logger.info(`Registered ${handlers.length} Sync IPC handlers`)

  return () => {
    for (const ch of handlers) ipcMain.removeHandler(ch)
    logger.info('Removed Sync IPC handlers')
  }
}
