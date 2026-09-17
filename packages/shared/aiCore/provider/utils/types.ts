import type { Provider } from '@types'

export function isAnthropicProvider(provider: Provider): boolean {
  return provider.type === 'anthropic'
}

export function isGeminiProvider(provider: Provider): boolean {
  return provider.type === 'gemini'
}

// History-only legacy protocol checks (retired in slice 3). Active request
// config must not use these; they exist only so old persisted backups and
// migration history remain importable without making retired values active.
export function isOllamaProvider(provider: Provider): boolean {
  return (provider as unknown as { type: string }).type === 'ollama'
}

export function isAzureOpenAIProvider(provider: Provider): boolean {
  return (provider as unknown as { type: string }).type === 'azure-openai'
}

// FIXME: #13194
export function isVertexProvider(provider: Provider): boolean {
  return (provider as unknown as { type: string }).type === 'vertexai'
}

export function isPerplexityProvider(provider: Provider): boolean {
  return provider.id === 'perplexity'
}
