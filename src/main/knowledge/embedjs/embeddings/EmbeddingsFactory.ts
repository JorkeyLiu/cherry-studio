import type { BaseEmbeddings } from '@cherrystudio/embedjs-interfaces'
import { OllamaEmbeddings } from '@cherrystudio/embedjs-ollama'
import { OpenAiEmbeddings } from '@cherrystudio/embedjs-openai'
import { resolveOutboundRequestHeaders } from '@shared/aiCore/provider/utils/requestHeaders'
import type { ApiClient } from '@types'
import { net } from 'electron'

import { VoyageEmbeddings } from './VoyageEmbeddings'

/**
 * Merge provider custom headers with the shared automatic session identity.
 * Precedence (case-insensitive) is owned by `resolveOutboundRequestHeaders`:
 * provider extra session wins over the automatic identity (no per-request
 * injection then). The merged result carries both the forwarded custom
 * headers and, on the Go endpoint only, the one request-local opaque identity
 * (topicless here: embeddings carry no topic). Auth (apiKey) flows via the
 * SDK's own credential fields, never via this map.
 */
function resolveEmbeddingClientHeaders(
  embedApiClient: ApiClient,
  generateId?: () => string
): Record<string, string> | undefined {
  const providerExtra = embedApiClient.extra_headers as Record<string, string | undefined> | undefined
  const resolved = resolveOutboundRequestHeaders({
    apiHost: embedApiClient.baseURL,
    providerExtraHeaders: providerExtra,
    ...(generateId ? { generateId } : {})
  })
  const merged: Record<string, string> = {}
  if (providerExtra) {
    for (const [key, value] of Object.entries(providerExtra)) {
      if (value !== undefined) {
        merged[key] = value
      }
    }
  }
  if (resolved) {
    for (const [key, value] of Object.entries(resolved)) {
      if (value !== undefined) {
        merged[key] = value
      }
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

export default class EmbeddingsFactory {
  /**
   * Create an embeddings SDK for the given client. The automatic Go session
   * identity (if any) is minted once here and then held constant by the
   * returned instance for its batches/retries — so callers needing
   * request-local semantics must create one SDK per top-level invocation
   * (see `Embeddings`). The optional `generateId` only controls that one
   * minted value (tests/determinism); provider/model/baseURL/dimensions
   * selection is unchanged.
   */
  static create({
    embedApiClient,
    generateId
  }: {
    embedApiClient: ApiClient
    generateId?: () => string
  }): BaseEmbeddings {
    const batchSize = 10
    const { model, provider, apiKey, baseURL } = embedApiClient
    const clientHeaders = resolveEmbeddingClientHeaders(embedApiClient, generateId)
    if (provider === 'voyageai') {
      return new VoyageEmbeddings({
        modelName: model,
        apiKey,
        batchSize: 8,
        ...(clientHeaders ? { headers: clientHeaders } : {})
      })
    }
    if (provider === 'ollama') {
      return new OllamaEmbeddings({
        model,
        baseUrl: baseURL.replace(/\/api$/, ''),
        ...(clientHeaders ? { headers: clientHeaders } : {})
      })
    }
    // NOTE: Azure OpenAI 也走 OpenAIEmbeddings, baseURL是https://xxxx.openai.azure.com/openai/v1
    return new OpenAiEmbeddings({
      model,
      apiKey,
      batchSize,
      configuration: {
        baseURL,
        fetch: net.fetch as typeof fetch,
        ...(clientHeaders ? { defaultHeaders: clientHeaders } : {})
      }
    })
  }
}
