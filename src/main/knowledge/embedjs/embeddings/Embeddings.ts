import type { BaseEmbeddings } from '@cherrystudio/embedjs-interfaces'
import { TraceMethod } from '@mcp-trace/trace-core'
import {
  getHeaderValue,
  isOpenCodeGoEndpoint,
  OPENCODE_SESSION_HEADER
} from '@shared/aiCore/provider/utils/requestHeaders'
import type { ApiClient } from '@types'

import EmbeddingsFactory from './EmbeddingsFactory'

export default class Embeddings {
  private sdk?: BaseEmbeddings
  private readonly embedApiClient: ApiClient
  private readonly dimensions?: number
  private readonly generateId?: () => string

  constructor({
    embedApiClient,
    dimensions,
    generateId
  }: {
    embedApiClient: ApiClient
    dimensions?: number
    generateId?: () => string
  }) {
    this.embedApiClient = embedApiClient
    this.dimensions = dimensions
    this.generateId = generateId
    // Cache one SDK only when its identity is stable across logical
    // requests (non-Go endpoint, or a defined provider extra session that
    // wins over the automatic identity). The automatic Go identity is
    // request-local: the underlying SDKs only accept constructor
    // `defaultHeaders`/`headers` (no per-call request options), so each
    // top-level invocation builds one fresh SDK holding a single minted
    // identity for its batches/retries — a cached instance would reuse the
    // same session across logical embedding requests.
    if (!this.needsRequestLocalIdentity()) {
      this.sdk = this.createSdk()
    }
  }

  /**
   * True when the automatic Go identity applies: Go endpoint with no defined
   * provider extra session. An `undefined` provider session value is absence
   * (HTTP semantics), so the automatic identity still applies.
   */
  private needsRequestLocalIdentity(): boolean {
    if (!isOpenCodeGoEndpoint(this.embedApiClient.baseURL)) return false
    const providerExtra = this.embedApiClient.extra_headers as Record<string, string | undefined> | undefined
    return getHeaderValue(providerExtra, OPENCODE_SESSION_HEADER) === undefined
  }

  private createSdk(): BaseEmbeddings {
    return EmbeddingsFactory.create({
      embedApiClient: this.embedApiClient,
      ...(this.generateId ? { generateId: this.generateId } : {})
    })
  }

  private resolveSdk(): BaseEmbeddings {
    // Cached singleton for stable identities; one fresh instance per
    // invocation for request-local Go identity (batches/retries inside that
    // invocation share the instance, hence the identity).
    return this.sdk ?? this.createSdk()
  }

  public async init(): Promise<void> {
    return this.resolveSdk().init()
  }

  @TraceMethod({ spanName: 'dimensions', tag: 'Embeddings' })
  public async getDimensions(): Promise<number> {
    if (this.dimensions !== undefined) return this.dimensions
    return this.resolveSdk().getDimensions()
  }

  @TraceMethod({ spanName: 'embedDocuments', tag: 'Embeddings' })
  public async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.resolveSdk().embedDocuments(texts)
  }

  @TraceMethod({ spanName: 'embedQuery', tag: 'Embeddings' })
  public async embedQuery(text: string): Promise<number[]> {
    return this.resolveSdk().embedQuery(text)
  }
}
