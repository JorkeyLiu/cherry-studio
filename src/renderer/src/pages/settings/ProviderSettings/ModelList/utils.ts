import type { Provider } from '@renderer/types'

// Check if the model exists in the provider's model list
export const isModelInProvider = (provider: Provider, modelId: string): boolean => {
  return provider.models.some((m) => m.id === modelId)
}
