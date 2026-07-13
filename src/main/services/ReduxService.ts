import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import type { ReduxAction, ReduxSelector } from '@shared/ReduxIpc'
import { ipcMain } from 'electron'

import { CacheService } from './CacheService'
import { windowService } from './WindowService'

type StoreValue = any

const logger = loggerService.withContext('ReduxService')
const STORE_READY_TIMEOUT = 10000
const PROVIDERS_CACHE_KEY = 'api-server:providers'
const PROVIDER_CACHE_INVALIDATION_ACTIONS = new Set([
  'llm/updateProvider',
  'llm/updateProviders',
  'llm/addProvider',
  'llm/removeProvider',
  'llm/addModel',
  'llm/removeModel'
])

export const invalidateApiServerProvidersCacheForAction = (actionType: string): void => {
  if (PROVIDER_CACHE_INVALIDATION_ACTIONS.has(actionType)) {
    CacheService.remove(PROVIDERS_CACHE_KEY)
  }
}

export class ReduxService {
  private isReady = false
  private resolveReady!: () => void
  private readyPromise = new Promise<void>((r) => (this.resolveReady = r))

  constructor() {
    ipcMain.handle(IpcChannel.ReduxStoreReady, () => {
      this.isReady = true
      this.resolveReady()
    })
  }

  private async waitForStoreReady(): Promise<void> {
    if (this.isReady) return

    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timeout waiting for Redux store to be ready')), STORE_READY_TIMEOUT)
    })

    await Promise.race([this.readyPromise, timeout]).finally(() => clearTimeout(timer))
  }

  private async getWebContents(): Promise<Electron.WebContents> {
    await this.waitForStoreReady()

    const mainWindow = windowService.getMainWindow()

    if (!mainWindow) {
      throw new Error('Main window is not available')
    }

    return mainWindow.webContents
  }

  // Select state from renderer process using a type-safe selector enum
  async select<T = StoreValue>(selector: ReduxSelector): Promise<T> {
    try {
      const webContents = await this.getWebContents()
      // JSON.stringify produces a safe string literal — no code injection possible
      return await webContents.executeJavaScript(`window.__reduxSelectState(${JSON.stringify(selector)})`)
    } catch (error) {
      logger.error('Failed to select store value:', error as Error)
      throw error
    }
  }

  // Dispatch action using a type-safe action object
  async dispatch(action: ReduxAction): Promise<void> {
    try {
      const webContents = await this.getWebContents()
      // JSON.stringify produces a safe string literal — no code injection possible
      await webContents.executeJavaScript(`window.__reduxDispatch(${JSON.stringify(action)})`)
      if (action?.type && typeof action.type === 'string') {
        invalidateApiServerProvidersCacheForAction(action.type)
      }
    } catch (error) {
      logger.error('Failed to dispatch action:', error as Error)
      throw error
    }
  }

  // Get entire state tree
  async getState(): Promise<any> {
    try {
      const webContents = await this.getWebContents()
      return await webContents.executeJavaScript(`window.store.getState()`)
    } catch (error) {
      logger.error('Failed to get state:', error as Error)
      throw error
    }
  }

  // Batch dispatch actions
  async batch(actions: ReduxAction[]): Promise<void> {
    for (const action of actions) {
      await this.dispatch(action)
    }
  }
}

export const reduxService = new ReduxService()

/**
 * @example
 * async function example() {
 *   try {
 *     // Select state using typed enum
 *     const settings = await reduxService.select(ReduxSelector.Settings)
 *     logger.log('settings', settings)
 *
 *     // Dispatch typed action
 *     await reduxService.dispatch({
 *       type: 'settings/setApiServerApiKey',
 *       payload: 'new-api-key'
 *     })
 *
 *     // Batch dispatch typed actions
 *     await reduxService.batch([
 *       { type: 'llm/clearCherryInTokens' },
 *       { type: 'settings/setApiServerApiKey', payload: 'key' }
 *     ])
 *   } catch (error) {
 *     logger.error('Error:', error)
 *   }
 * }
 */
