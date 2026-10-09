/**
 * Generic Anthropic thinking-format wire tests.
 *
 * Proves the negotiation against the ACTUAL installed `@ai-sdk/anthropic`
 * SDK: only the network boundary (fetch) is mocked. Model ids, hosts, and
 * connection ids are opaque and arbitrary — nothing here depends on a model
 * name. Coverage: first-400 + success learns (2 calls), later requests send
 * the learned shape directly (1 call), final wire shapes and max_tokens are
 * pinned, the serving model id is unchanged, and default/disabled shapes
 * never negotiate.
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import type { Assistant, Model, Provider } from '@renderer/types'
import { generateText, streamText, wrapLanguageModel } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    })
  }
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  getStoreSetting: vi.fn(() => undefined)
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: vi.fn((assistant) => ({
    maxTokens: assistant?.settings?.maxTokens,
    reasoning_effort: assistant?.settings?.reasoning_effort
  })),
  getProviderByModel: vi.fn((model) => ({
    id: model.provider,
    name: 'Opaque Provider'
  })),
  getDefaultAssistant: vi.fn(() => ({
    id: 'default',
    name: 'Default Assistant',
    settings: {}
  }))
}))

vi.mock('@renderer/hooks/useStore', () => ({
  getStoreProviders: vi.fn(() => [])
}))

vi.mock('@renderer/store', () => ({
  __esModule: true,
  default: {
    getState: () => ({
      llm: { providers: [] },
      settings: {}
    })
  },
  useAppDispatch: vi.fn(),
  useAppSelector: vi.fn()
}))

import { createAnthropicThinkingFormatPlugin } from '../../plugins/anthropicThinkingFormatPlugin'
import { buildThinkingScopeKey, THINKING_DIALECT_STORAGE_KEY, writeLearnedDialect } from '../anthropicThinkingDialect'
import { getAnthropicReasoningParams } from '../reasoning'

const ENABLED_REJECTED_MESSAGE =
  "thinking.type 'enabled' is not supported for this model. Use thinking.type 'adaptive' with output_config.effort instead."
const ADAPTIVE_REJECTED_MESSAGE =
  "adaptive thinking is not supported for model 'router-opaque-9f3'. Use thinking.type 'enabled' with budget_tokens instead."

function makeProvider(): Provider {
  return {
    id: 'conn-opaque-9',
    name: 'Opaque',
    type: 'anthropic',
    apiKey: 'sk-secret-9',
    apiHost: 'https://api.example.com',
    models: []
  } as Provider
}

function makeModel(id: string): Model {
  return { id, name: id, provider: 'conn-opaque-9' } as Model
}

function makeAssistant(reasoningEffort: unknown = 'high'): Assistant {
  return { id: 'a', name: 'A', settings: { reasoning_effort: reasoningEffort } } as unknown as Assistant
}

function errorResponse(message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' }
  })
}

function messageResponse(modelId: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_wire',
      type: 'message',
      role: 'assistant',
      model: modelId,
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 }
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

function streamResponse(modelId: string): Response {
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: modelId, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
  ].join('')
  return new Response(events, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

describe('Anthropic thinking-format wire (real SDK, mocked fetch)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    localStorage.removeItem(THINKING_DIALECT_STORAGE_KEY)
  })

  async function wrappedModelId(modelId: string, effort: unknown = 'high') {
    const provider = makeProvider()
    const model = makeModel(modelId)
    const plugin = createAnthropicThinkingFormatPlugin({ provider, model, assistant: makeAssistant(effort) })
    const context: { middlewares: never[] } = { middlewares: [] }
    plugin.configureContext!(context as never)
    const anthropic = createAnthropic({
      apiKey: 'sk-secret-9',
      baseURL: 'https://api.example.com/anthropic',
      fetch: fetchMock as never
    })
    return wrapLanguageModel({ model: anthropic(modelId), middleware: context.middlewares })
  }

  function wireBody(callIndex: number): Record<string, any> {
    return JSON.parse((fetchMock.mock.calls[callIndex][1]?.body as string) ?? '{}')
  }

  it('sends the modern adaptive default from the actual builder in one call (no hand-constructed shape)', async () => {
    fetchMock.mockResolvedValueOnce(messageResponse('router-opaque-9f3'))
    const built = getAnthropicReasoningParams(makeAssistant('high'))
    expect(built).toEqual({ thinking: { type: 'adaptive' }, effort: 'high' })

    const model = await wrappedModelId('router-opaque-9f3', 'high')
    const { text } = await generateText({
      model,
      providerOptions: { anthropic: built },
      prompt: 'hi',
      maxOutputTokens: 4096,
      maxRetries: 0
    })
    expect(text).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = wireBody(0)
    expect(body.model).toBe('router-opaque-9f3')
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.max_tokens).toBe(4096)
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
  })

  it('bounds a small 4096 total to budget 4095 with the wire total preserved', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(ADAPTIVE_REJECTED_MESSAGE))
      .mockResolvedValueOnce(messageResponse('router-opaque-9f3'))

    const model = await wrappedModelId('router-opaque-9f3', 'high')
    const { text } = await generateText({
      model,
      providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } },
      prompt: 'hi',
      maxOutputTokens: 4096,
      maxRetries: 0
    })
    expect(text).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(wireBody(0).thinking).toEqual({ type: 'adaptive' })
    expect(wireBody(0).max_tokens).toBe(4096)
    expect(wireBody(1).thinking).toEqual({ type: 'enabled', budget_tokens: 4095 })
    expect(wireBody(1).max_tokens).toBe(4096)
  })

  it('preserves the original error for an impossible 1024 total with no fallback', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(ADAPTIVE_REJECTED_MESSAGE))

    const model = await wrappedModelId('router-opaque-9f3', 'high')
    await expect(
      generateText({
        model,
        providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } },
        prompt: 'hi',
        maxOutputTokens: 1024,
        maxRetries: 0
      })
    ).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
  })

  it('learns adaptive on generate: 2 calls, then 1 call with identical wire totals and model', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(ENABLED_REJECTED_MESSAGE))
      .mockResolvedValueOnce(messageResponse('router-opaque-9f3'))

    const first = await wrappedModelId('router-opaque-9f3', 'high')
    const { text } = await generateText({
      model: first,
      providerOptions: {
        anthropic: { thinking: { type: 'enabled', budgetTokens: 2000 }, sendReasoning: true }
      },
      prompt: 'hi',
      maxOutputTokens: 2096,
      maxRetries: 0
    })
    expect(text).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const firstBody = wireBody(0)
    expect(firstBody.model).toBe('router-opaque-9f3')
    expect(firstBody.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 })
    // SDK add-back: prepared 2096 + 2000 budget = 4096 wire total.
    expect(firstBody.max_tokens).toBe(4096)
    expect(firstBody).not.toHaveProperty('output_config')

    const retryBody = wireBody(1)
    expect(retryBody.model).toBe('router-opaque-9f3')
    expect(retryBody.thinking).toEqual({ type: 'adaptive' })
    expect(retryBody.output_config).toEqual({ effort: 'high' })
    // Wire total unchanged by the conversion.
    expect(retryBody.max_tokens).toBe(4096)

    // A new logical request sends the learned shape directly in one call.
    fetchMock.mockResolvedValueOnce(messageResponse('router-opaque-9f3'))
    const second = await wrappedModelId('router-opaque-9f3', 'high')
    const later = await generateText({
      model: second,
      providerOptions: {
        anthropic: { thinking: { type: 'enabled', budgetTokens: 2000 }, sendReasoning: true }
      },
      prompt: 'hi',
      maxOutputTokens: 2096,
      maxRetries: 0
    })
    expect(later.text).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const learnedBody = wireBody(2)
    expect(learnedBody.model).toBe('router-opaque-9f3')
    expect(learnedBody.thinking).toEqual({ type: 'adaptive' })
    expect(learnedBody.output_config).toEqual({ effort: 'high' })
    expect(learnedBody.max_tokens).toBe(4096)
  })

  it('learns enabled on the reverse leg with the wire total preserved', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(ADAPTIVE_REJECTED_MESSAGE))
      .mockResolvedValueOnce(messageResponse('router-opaque-rev'))

    const first = await wrappedModelId('router-opaque-rev', 'medium')
    const { text } = await generateText({
      model: first,
      providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' } },
      prompt: 'hi',
      maxOutputTokens: 64000,
      maxRetries: 0
    })
    expect(text).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const firstBody = wireBody(0)
    expect(firstBody.model).toBe('router-opaque-rev')
    expect(firstBody.thinking).toEqual({ type: 'adaptive' })
    expect(firstBody.max_tokens).toBe(64000)

    const retryBody = wireBody(1)
    expect(retryBody.model).toBe('router-opaque-rev')
    // Opaque-model fallback budget for medium (8704) below the 64000 total.
    expect(retryBody.thinking).toEqual({ type: 'enabled', budget_tokens: 8704 })
    expect(retryBody).not.toHaveProperty('output_config')
    // SDK add-back restores the same wire total: 55296 + 8704.
    expect(retryBody.max_tokens).toBe(64000)
  })

  it('contradicted learned enabled inverts the actually-sent shape with the wire total preserved', async () => {
    const modelId = 'router-opaque-contradict-a'
    // Manually seed the learned enabled hint for this exact connection scope.
    const scopeKey = await buildThinkingScopeKey({ provider: makeProvider(), modelId })
    writeLearnedDialect(scopeKey, 'enabled')

    fetchMock
      .mockResolvedValueOnce(errorResponse(ENABLED_REJECTED_MESSAGE))
      .mockResolvedValueOnce(messageResponse(modelId))

    const first = await wrappedModelId(modelId, 'medium')
    const { text } = await generateText({
      model: first,
      providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' } },
      prompt: 'hi',
      maxOutputTokens: 64000,
      maxRetries: 0
    })
    expect(text).toBe('hi')
    // Single alternate: exactly one retry.
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const firstBody = wireBody(0)
    expect(firstBody.model).toBe(modelId)
    // Learned enabled sent first: 55296 + 8704 budget.
    expect(firstBody.thinking).toEqual({ type: 'enabled', budget_tokens: 8704 })
    expect(firstBody).not.toHaveProperty('output_config')
    expect(firstBody.max_tokens).toBe(64000)

    const retryBody = wireBody(1)
    expect(retryBody.model).toBe(modelId)
    // Retry inverts the actually-sent enabled shape back to adaptive 64000,
    // not the buggy 65024 (original 64000 + SDK default 1024).
    expect(retryBody.thinking).toEqual({ type: 'adaptive' })
    expect(retryBody.output_config).toEqual({ effort: 'medium' })
    expect(retryBody.max_tokens).toBe(64000)

    // The successful adaptive retry was recorded and reused directly in one call.
    fetchMock.mockResolvedValueOnce(messageResponse(modelId))
    const second = await wrappedModelId(modelId, 'medium')
    const later = await generateText({
      model: second,
      providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' } },
      prompt: 'hi',
      maxOutputTokens: 64000,
      maxRetries: 0
    })
    expect(later.text).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const learnedBody = wireBody(2)
    expect(learnedBody.model).toBe(modelId)
    expect(learnedBody.thinking).toEqual({ type: 'adaptive' })
    expect(learnedBody.output_config).toEqual({ effort: 'medium' })
    expect(learnedBody.max_tokens).toBe(64000)
  })

  it('contradicted learned adaptive inverts the actually-sent shape with the wire total preserved', async () => {
    const modelId = 'router-opaque-contradict-b'
    // Manually seed the learned adaptive hint for this exact connection scope.
    const scopeKey = await buildThinkingScopeKey({ provider: makeProvider(), modelId })
    writeLearnedDialect(scopeKey, 'adaptive')

    fetchMock
      .mockResolvedValueOnce(errorResponse(ADAPTIVE_REJECTED_MESSAGE))
      .mockResolvedValueOnce(messageResponse(modelId))

    const first = await wrappedModelId(modelId, 'medium')
    const { text } = await generateText({
      model: first,
      providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 8704 } } },
      prompt: 'hi',
      maxOutputTokens: 64000 - 8704,
      maxRetries: 0
    })
    expect(text).toBe('hi')
    // Single alternate: exactly one retry.
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const firstBody = wireBody(0)
    expect(firstBody.model).toBe(modelId)
    // Learned adaptive sent first: 55296 + 8704 -> adaptive 64000.
    expect(firstBody.thinking).toEqual({ type: 'adaptive' })
    expect(firstBody.output_config).toEqual({ effort: 'medium' })
    expect(firstBody.max_tokens).toBe(64000)

    const retryBody = wireBody(1)
    expect(retryBody.model).toBe(modelId)
    // Retry inverts the actually-sent adaptive total back to enabled
    // 55296 + 8704, not the buggy 46592 (original 55296 - 8704).
    expect(retryBody.thinking).toEqual({ type: 'enabled', budget_tokens: 8704 })
    expect(retryBody).not.toHaveProperty('output_config')
    expect(retryBody.max_tokens).toBe(64000)

    // The successful enabled retry was recorded and reused directly in one call.
    fetchMock.mockResolvedValueOnce(messageResponse(modelId))
    const second = await wrappedModelId(modelId, 'medium')
    const later = await generateText({
      model: second,
      providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 8704 } } },
      prompt: 'hi',
      maxOutputTokens: 64000 - 8704,
      maxRetries: 0
    })
    expect(later.text).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const learnedBody = wireBody(2)
    expect(learnedBody.model).toBe(modelId)
    expect(learnedBody.thinking).toEqual({ type: 'enabled', budget_tokens: 8704 })
    expect(learnedBody).not.toHaveProperty('output_config')
    expect(learnedBody.max_tokens).toBe(64000)
  })

  it('streams through the learned shape: 2 calls, then 1 call', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(ENABLED_REJECTED_MESSAGE))
      .mockResolvedValueOnce(streamResponse('router-opaque-stream'))

    const first = await wrappedModelId('router-opaque-stream', 'high')
    const firstResult = await streamText({
      model: first,
      providerOptions: {
        anthropic: { thinking: { type: 'enabled', budgetTokens: 2000 }, sendReasoning: true }
      },
      prompt: 'hi',
      maxOutputTokens: 2096,
      maxRetries: 0
    })
    await firstResult.consumeStream()
    expect(await firstResult.text).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(wireBody(1).thinking).toEqual({ type: 'adaptive' })
    expect(wireBody(1).output_config).toEqual({ effort: 'high' })

    fetchMock.mockResolvedValueOnce(streamResponse('router-opaque-stream'))
    const second = await wrappedModelId('router-opaque-stream', 'high')
    const secondResult = await streamText({
      model: second,
      providerOptions: {
        anthropic: { thinking: { type: 'enabled', budgetTokens: 2000 }, sendReasoning: true }
      },
      prompt: 'hi',
      maxOutputTokens: 2096,
      maxRetries: 0
    })
    await secondResult.consumeStream()
    expect(await secondResult.text).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(wireBody(2).thinking).toEqual({ type: 'adaptive' })
  })

  it('sends no thinking or output_config for default and keeps the model id', async () => {
    fetchMock.mockResolvedValueOnce(messageResponse('router-opaque-9f3'))
    const model = await wrappedModelId('router-opaque-9f3', 'default')
    const { text } = await generateText({
      model,
      providerOptions: { anthropic: {} },
      prompt: 'hi',
      maxOutputTokens: 128,
      maxRetries: 0
    })
    expect(text).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = wireBody(0)
    expect(body.model).toBe('router-opaque-9f3')
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('output_config')
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
  })

  it('sends explicit disabled thinking untouched and never negotiates it', async () => {
    fetchMock.mockResolvedValueOnce(messageResponse('router-opaque-9f3'))
    const model = await wrappedModelId('router-opaque-9f3', 'none')
    const { text } = await generateText({
      model,
      providerOptions: { anthropic: { thinking: { type: 'disabled' } } },
      prompt: 'hi',
      maxOutputTokens: 128,
      maxRetries: 0
    })
    expect(text).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = wireBody(0)
    expect(body.model).toBe('router-opaque-9f3')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body).not.toHaveProperty('output_config')
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
  })
})
