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

  register(IpcChannel.Sync_CreateInvite, async () => {
    return await syncService.createPairingInvite()
  })

  register(IpcChannel.Sync_RequestPairing, async (_e, args: { code?: string; deviceName?: string }) => {
    if (!args || typeof args !== 'object') throw new Error('invalid pairing request')
    if (typeof args.code !== 'string') throw new Error('code must be string')
    if (args.deviceName !== undefined && typeof args.deviceName !== 'string') {
      throw new Error('device name must be string')
    }
    return await syncService.requestPairing(args.code, args.deviceName)
  })

  register(IpcChannel.Sync_ListPairingRequests, async () => {
    return { requests: await syncService.listPairingRequests() }
  })

  register(IpcChannel.Sync_AcceptPairing, async (_e, args: { requestId?: string }) => {
    if (!args || typeof args.requestId !== 'string') throw new Error('request id must be string')
    return { trusted: await syncService.acceptPairing(args.requestId) }
  })

  register(IpcChannel.Sync_RejectPairing, async (_e, args: { requestId?: string }) => {
    if (!args || typeof args.requestId !== 'string') throw new Error('request id must be string')
    await syncService.rejectPairing(args.requestId)
    return { ok: true }
  })

  register(IpcChannel.Sync_ListTrusted, async () => {
    return { devices: syncService.listTrustedDevices() }
  })

  register(IpcChannel.Sync_RefreshTrusted, async () => {
    return { devices: await syncService.refreshTrustedDevices() }
  })

  register(IpcChannel.Sync_GetPairingStatus, async () => {
    return await syncService.getPairingStatus()
  })

  register(IpcChannel.Sync_RevokeDevice, async (_e, args: { targetDeviceId?: string }) => {
    if (!args || typeof args.targetDeviceId !== 'string') throw new Error('device id must be string')
    await syncService.revokeTrustedDevice(args.targetDeviceId)
    return { ok: true }
  })

  logger.info(`Registered ${handlers.length} Sync IPC handlers`)

  return () => {
    for (const ch of handlers) ipcMain.removeHandler(ch)
    logger.info('Removed Sync IPC handlers')
  }
}
