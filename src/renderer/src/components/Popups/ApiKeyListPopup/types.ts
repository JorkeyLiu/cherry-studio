import type { Provider } from '@renderer/types'

/**
 * API key 格式有效性
 */
export type ApiKeyValidity =
  | {
      isValid: true
      error?: never
    }
  | {
      isValid: false
      error: string
    }

export type ApiProvider = Provider

export type UpdateProviderFunc = (p: Partial<Provider>) => void

export type UpdateApiProviderFunc = UpdateProviderFunc
