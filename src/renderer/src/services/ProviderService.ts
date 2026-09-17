import { getStoreProviders } from '@renderer/hooks/useStore'
import type { Model, Provider } from '@renderer/types'
import { getFancyProviderName } from '@renderer/utils'

export function getProviderName(model?: Model) {
  const provider = getProviderByModel(model)

  if (!provider) {
    return ''
  }

  return getFancyProviderName(provider)
}

export function getProviderNameById(pid: string) {
  const provider = getStoreProviders().find((p) => p.id === pid)
  if (provider) {
    return getFancyProviderName(provider)
  } else {
    return 'Unknown Provider'
  }
}

//FIXME: 和 AssistantService.ts 中的同名函数冲突
export function getProviderByModel(model?: Model) {
  const id = model?.provider
  const provider = getStoreProviders().find((p) => p.id === id)

  return provider
}

// History-only brand OAuth/charge helpers were retired with the
// custom-connection product: every provider is an ordinary connection and
// Anthropic OAuth (authType === 'oauth') needs no brand id list. Kept as
// thin protocol checks so existing callers compile until removed.
export function isProviderSupportAuth(provider: Provider) {
  return provider.authType === 'oauth'
}

export function isProviderSupportCharge(_provider: Provider) {
  return false
}

export function getProviderById(id: string) {
  return getStoreProviders().find((p) => p.id === id)
}
