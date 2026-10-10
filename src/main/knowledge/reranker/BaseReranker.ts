import { DEFAULT_DOCUMENT_COUNT, DEFAULT_RELEVANT_SCORE } from '@main/utils/knowledge'
import { resolveOutboundRequestHeaders } from '@shared/aiCore/provider/utils/requestHeaders'
import type { KnowledgeBaseParams, KnowledgeSearchResult } from '@types'

import type { MultiModalDocument, RerankStrategy } from './strategies/RerankStrategy'
import { StrategyFactory } from './strategies/StrategyFactory'

export default abstract class BaseReranker {
  protected base: KnowledgeBaseParams
  protected strategy: RerankStrategy

  constructor(base: KnowledgeBaseParams) {
    if (!base.rerankApiClient) {
      throw new Error('Rerank model is required')
    }
    this.base = base
    this.strategy = StrategyFactory.createStrategy(base.rerankApiClient.provider)
  }
  abstract rerank(query: string, searchResults: KnowledgeSearchResult[]): Promise<KnowledgeSearchResult[]>
  protected getRerankUrl(): string {
    return this.strategy.buildUrl(this.base.rerankApiClient?.baseURL)
  }
  protected getRerankRequestBody(query: string, searchResults: KnowledgeSearchResult[]) {
    const documents = this.buildDocuments(searchResults)
    const topN = this.base.documentCount ?? DEFAULT_DOCUMENT_COUNT
    const model = this.base.rerankApiClient?.model
    return this.strategy.buildRequestBody(query, documents, topN, model)
  }
  private buildDocuments(searchResults: KnowledgeSearchResult[]): MultiModalDocument[] {
    return searchResults.map((doc) => {
      const document: MultiModalDocument = {}

      // 检查是否是图片类型，添加图片内容
      if (doc.metadata?.type === 'image') {
        document.image = doc.pageContent
      } else {
        document.text = doc.pageContent
      }

      return document
    })
  }
  protected extractRerankResult(data: any) {
    return this.strategy.extractResults(data)
  }

  /**
   * Get Rerank Result
   * @param searchResults
   * @param rerankResults
   * @protected
   */
  protected getRerankResult(
    searchResults: KnowledgeSearchResult[],
    rerankResults: Array<{ index: number; relevance_score: number }>
  ) {
    const resultMap = new Map(
      rerankResults.map((result) => [result.index, result.relevance_score || DEFAULT_RELEVANT_SCORE])
    )

    const returenResults = searchResults
      .map((doc: KnowledgeSearchResult, index: number) => {
        const score = resultMap.get(index)
        if (score === undefined) return undefined
        return { ...doc, score }
      })
      .filter((doc): doc is KnowledgeSearchResult => doc !== undefined)
      .sort((a, b) => b.score - a.score)

    return returenResults
  }
  public defaultHeaders(): Record<string, string> {
    const rerankClient = this.base.rerankApiClient
    // Shared cross-runtime policy (topicless here: rerank carries no topic):
    // provider extra session wins over the automatic identity; the automatic
    // identity is one request-local opaque value on the Go endpoint only.
    // `defaultHeaders()` runs per rerank invocation, so the opaque value is
    // per logical invocation/retry, never a persisted session.
    const providerExtra = rerankClient?.extra_headers as Record<string, string | undefined> | undefined
    const resolved = resolveOutboundRequestHeaders({
      apiHost: rerankClient?.baseURL,
      providerExtraHeaders: providerExtra
    })
    const headers: Record<string, string> = {
      Authorization: `Bearer ${rerankClient?.apiKey}`,
      'Content-Type': 'application/json'
    }
    if (providerExtra) {
      for (const [key, value] of Object.entries(providerExtra)) {
        if (value === undefined) continue
        // Auth/content are owned by this client (key rotation/Bearer +
        // JSON body); custom headers never override them.
        if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'content-type') continue
        headers[key] = value
      }
    }
    if (resolved) {
      for (const [key, value] of Object.entries(resolved)) {
        if (value !== undefined) {
          headers[key] = value
        }
      }
    }
    return headers
  }
  protected formatErrorMessage(url: string, error: any, requestBody: any) {
    const errorDetails = {
      url: url,
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseBody: error.response?.body, // Include the actual API error response
      requestBody: requestBody
    }
    return JSON.stringify(errorDetails, null, 2)
  }
}
