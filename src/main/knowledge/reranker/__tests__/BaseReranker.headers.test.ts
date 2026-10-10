import type { KnowledgeBaseParams } from '@types'
import { net } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import GeneralReranker from '../GeneralReranker'

const makeBase = (overrides: Partial<KnowledgeBaseParams['rerankApiClient']> = {}): KnowledgeBaseParams => ({
  id: 'b1',
  embedApiClient: {
    model: 'embed-1',
    provider: 'openai',
    apiKey: 'emb-fake-key',
    baseURL: 'https://api.example.com'
  },
  rerankApiClient: {
    model: 'rerank-1',
    provider: 'openai',
    apiKey: 'rk-fake-key',
    baseURL: 'https://api.example.com',
    ...overrides
  }
})

const searchResults = [
  { pageContent: 'doc-a', score: 0.1, metadata: {} },
  { pageContent: 'doc-b', score: 0.2, metadata: {} }
]

describe('GeneralReranker shared header policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps auth/content headers without a session on non-Go endpoints', () => {
    const reranker = new GeneralReranker(makeBase())
    expect(reranker.defaultHeaders()).toMatchObject({
      Authorization: 'Bearer rk-fake-key',
      'Content-Type': 'application/json'
    })
    expect(reranker.defaultHeaders()['x-opencode-session']).toBeUndefined()
  })

  it('forwards provider custom headers without overriding auth/content', () => {
    const reranker = new GeneralReranker(
      makeBase({
        extra_headers: { 'X-Custom': 'keep', Authorization: 'Bearer injected', 'Content-Type': 'text/plain' }
      })
    )
    const headers = reranker.defaultHeaders()
    expect(headers['X-Custom']).toBe('keep')
    expect(headers.Authorization).toBe('Bearer rk-fake-key')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('mints a topicless opaque Go session without user/model content', () => {
    const reranker = new GeneralReranker(makeBase({ baseURL: 'https://opencode.ai/zen/go/v1' }))
    const value = reranker.defaultHeaders()['x-opencode-session'] ?? ''
    expect(value).toBeTruthy()
    expect(value).not.toContain('rerank-1')
  })

  it('lets a provider extra session win over the automatic Go identity', () => {
    const reranker = new GeneralReranker(
      makeBase({
        baseURL: 'https://opencode.ai/zen/go/v1',
        extra_headers: { 'x-opencode-session': 'provider-extra' }
      })
    )
    expect(reranker.defaultHeaders()['x-opencode-session']).toBe('provider-extra')
  })

  it('sends the resolved headers on the actual fetch wire with the protocol body intact', async () => {
    const fetchMock = vi.mocked(net.fetch)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [{ index: 0, relevance_score: 0.9 }] })
    } as Response)

    const reranker = new GeneralReranker(
      makeBase({
        baseURL: 'https://opencode.ai/zen/go/v1',
        extra_headers: { 'X-Custom': 'wire-keep' }
      })
    )
    const ranked = await reranker.rerank('query', searchResults)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(init.method).toBe('POST')
    expect(init.headers['X-Custom']).toBe('wire-keep')
    expect(init.headers['x-opencode-session']).toBeTruthy()
    expect(init.headers.Authorization).toBe('Bearer rk-fake-key')
    // Protocol body untouched: model/query/documents/top_n still encoded.
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ model: 'rerank-1', query: 'query', top_n: expect.any(Number) })
    expect(body.documents).toEqual(['doc-a', 'doc-b'])
    expect(ranked).toHaveLength(1)
    expect(ranked[0].pageContent).toBe('doc-a')
  })
})
