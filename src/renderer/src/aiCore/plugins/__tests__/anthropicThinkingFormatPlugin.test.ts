/**
 * Focused unit tests for the generic Anthropic thinking-format plugin.
 *
 * Every model id, host, and connection id is opaque and arbitrary: routing,
 * learning, and retry decisions never depend on a name. The inner model is a
 * scripted fake standing in for the wrapped SDK model, mirroring the real
 * middleware topology (first attempt through the doStream/doGenerate closure,
 * retries through the inner model so inner wrappers apply once).
 */
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart
} from '@ai-sdk/provider'
import type { Assistant, Model, Provider } from '@renderer/types'
import type { LanguageModelMiddleware } from 'ai'
import { APICallError } from 'ai'
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
  getProviderByModel: vi.fn(() => ({ id: 'conn-opaque-1', name: 'Opaque' })),
  getDefaultAssistant: vi.fn(() => ({ id: 'default', name: 'Default', settings: {} }))
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

import {
  buildThinkingScopeKey,
  THINKING_DIALECT_STORAGE_KEY,
  writeLearnedDialect
} from '../../utils/anthropicThinkingDialect'
import { createAnthropicThinkingFormatPlugin } from '../anthropicThinkingFormatPlugin'

const ENABLED_REJECTED_MESSAGE =
  "thinking.type 'enabled' is not supported for this model. Use thinking.type 'adaptive' with output_config.effort instead."
const ADAPTIVE_REJECTED_MESSAGE =
  "adaptive thinking is not supported for model 'router-opaque-7f2a'. Use thinking.type 'enabled' with budget_tokens instead."

function invalidRequestError(message: string) {
  return { type: 'error', error: { type: 'invalid_request_error', message } }
}

function apiError(statusCode: number, body: unknown): APICallError {
  const responseBody = typeof body === 'string' ? body : JSON.stringify(body)
  return new APICallError({
    message: 'API call failed',
    url: 'https://api.example.com/v1/messages',
    requestBodyValues: {},
    statusCode,
    responseHeaders: {},
    responseBody,
    data: typeof body === 'string' ? undefined : (body as Record<string, unknown>),
    isRetryable: false
  })
}

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'conn-opaque-1',
    name: 'Opaque',
    type: 'anthropic',
    apiKey: 'sk-secret-1',
    apiHost: 'https://api.example.com',
    models: [],
    ...overrides
  } as Provider
}

function makeModel(id = 'router-opaque-7f2a'): Model {
  return { id, name: id, provider: 'conn-opaque-1' } as Model
}

function makeAssistant(reasoningEffort: unknown, extraSettings: Record<string, unknown> = {}): Assistant {
  return {
    id: 'assistant-opaque-1',
    name: 'Opaque',
    settings: { reasoning_effort: reasoningEffort, ...extraSettings }
  } as unknown as Assistant
}

function makeParams(overrides: Record<string, any> = {}): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxOutputTokens: 2096,
    providerOptions: {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: 2000 },
        sendReasoning: true
      }
    },
    ...overrides
  } as unknown as LanguageModelV3CallOptions
}

function makeAdaptiveParams(overrides: Record<string, any> = {}): LanguageModelV3CallOptions {
  return makeParams({
    maxOutputTokens: 64000,
    providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' } },
    ...overrides
  })
}

function generateOk(): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text: 'hi' }],
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: []
  } as unknown as LanguageModelV3GenerateResult
}

function successParts(): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't0' },
    { type: 'text-delta', id: 't0', delta: 'hi' },
    { type: 'text-end', id: 't0' },
    {
      type: 'finish',
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      finishReason: { unified: 'stop', raw: 'end_turn' }
    }
  ] as unknown as LanguageModelV3StreamPart[]
}

function partsToStream(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    }
  })
}

async function consume(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const reader = stream.getReader()
  const seen: LanguageModelV3StreamPart[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    seen.push(value)
  }
  return seen
}

function makeInner() {
  return {
    doGenerate: vi.fn(),
    doStream: vi.fn()
  }
}

async function getMiddleware(provider?: Provider, model?: Model, assistant?: Assistant) {
  const plugin = createAnthropicThinkingFormatPlugin({
    provider: provider ?? makeProvider(),
    model: model ?? makeModel(),
    assistant: assistant ?? makeAssistant('high')
  })
  const context: { middlewares: LanguageModelMiddleware[] } = { middlewares: [] }
  plugin.configureContext!(context as never)
  return context.middlewares[0]
}

function callGenerate(
  middleware: LanguageModelMiddleware,
  params: LanguageModelV3CallOptions,
  inner: ReturnType<typeof makeInner>
) {
  return middleware.wrapGenerate!({
    params,
    model: inner as never,
    doGenerate: () => inner.doGenerate(params),
    doStream: () => inner.doStream(params)
  } as never) as Promise<LanguageModelV3GenerateResult>
}

function callStream(
  middleware: LanguageModelMiddleware,
  params: LanguageModelV3CallOptions,
  inner: ReturnType<typeof makeInner>
) {
  return middleware.wrapStream!({
    params,
    model: inner as never,
    doGenerate: () => inner.doGenerate(params),
    doStream: () => inner.doStream(params)
  } as never) as Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }>
}

function anthropicBucketOf(params: LanguageModelV3CallOptions): Record<string, any> {
  return (params.providerOptions as Record<string, any>)?.['anthropic']
}

describe('anthropicThinkingFormatPlugin', () => {
  beforeEach(() => {
    localStorage.removeItem(THINKING_DIALECT_STORAGE_KEY)
  })

  it('retries an enabled rejection once with adaptive, then sends the learned shape directly', async () => {
    const provider = makeProvider()
    const model = makeModel()
    const params = makeParams()
    const snapshot = JSON.parse(JSON.stringify(params))

    const first = await getMiddleware(provider, model, makeAssistant('high'))
    const inner = makeInner()
    inner.doGenerate
      .mockRejectedValueOnce(apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE)))
      .mockResolvedValueOnce(generateOk())

    const result = await callGenerate(first, params, inner)
    expect(result.content).toHaveLength(1)
    expect(inner.doGenerate).toHaveBeenCalledTimes(2)

    // First leg kept the default enabled shape; the retry converted it.
    const firstSend = inner.doGenerate.mock.calls[0][0] as LanguageModelV3CallOptions
    expect(firstSend).toBe(params)
    expect(anthropicBucketOf(firstSend)).toEqual({
      thinking: { type: 'enabled', budgetTokens: 2000 },
      sendReasoning: true
    })
    const retrySend = inner.doGenerate.mock.calls[1][0] as LanguageModelV3CallOptions
    expect(retrySend).not.toBe(params)
    expect(anthropicBucketOf(retrySend)).toEqual({ thinking: { type: 'adaptive' }, effort: 'high' })
    // Wire total preserved: 2096 prepared + 2000 budget = 4096.
    expect(retrySend.maxOutputTokens).toBe(4096)

    // Input params were never mutated.
    expect(JSON.parse(JSON.stringify(params))).toEqual(snapshot)

    // A new instance (new logical request) sends the learned shape in one call.
    const second = await getMiddleware(provider, model, makeAssistant('high'))
    const inner2 = makeInner()
    inner2.doGenerate.mockResolvedValueOnce(generateOk())
    await callGenerate(second, makeParams(), inner2)
    expect(inner2.doGenerate).toHaveBeenCalledTimes(1)
    const learnedSend = inner2.doGenerate.mock.calls[0][0] as LanguageModelV3CallOptions
    expect(anthropicBucketOf(learnedSend)).toEqual({ thinking: { type: 'adaptive' }, effort: 'high' })
    expect(learnedSend.maxOutputTokens).toBe(4096)

    // The persisted record holds no raw connection values.
    const raw = localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)
    expect(raw).toContain('adaptive')
    for (const secret of ['router-opaque-7f2a', 'sk-secret-1', 'api.example.com', 'conn-opaque-1']) {
      expect(raw).not.toContain(secret)
    }
  })

  it('recomputes the learned shape from the current effort (high -> low/auto)', async () => {
    const provider = makeProvider()
    const model = makeModel()
    const setup = await getMiddleware(provider, model, makeAssistant('high'))
    const setupInner = makeInner()
    setupInner.doGenerate
      .mockRejectedValueOnce(apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE)))
      .mockResolvedValueOnce(generateOk())
    await callGenerate(setup, makeParams(), setupInner)

    const low = await getMiddleware(provider, model, makeAssistant('low'))
    const lowInner = makeInner()
    lowInner.doGenerate.mockResolvedValueOnce(generateOk())
    await callGenerate(low, makeParams(), lowInner)
    expect(anthropicBucketOf(lowInner.doGenerate.mock.calls[0][0])).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'low'
    })

    const auto = await getMiddleware(provider, model, makeAssistant('auto'))
    const autoInner = makeInner()
    autoInner.doGenerate.mockResolvedValueOnce(generateOk())
    await callGenerate(auto, makeParams(), autoInner)
    expect(anthropicBucketOf(autoInner.doGenerate.mock.calls[0][0])).toEqual({
      thinking: { type: 'adaptive' }
    })
  })

  it('keeps cache entries isolated across endpoint, model, auth, and headers', async () => {
    const baseProvider = makeProvider()
    const model = makeModel()
    async function learn(provider: Provider, id: string) {
      const middleware = await getMiddleware(provider, makeModel(id), makeAssistant('high'))
      const inner = makeInner()
      inner.doGenerate
        .mockRejectedValueOnce(apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE)))
        .mockResolvedValueOnce(generateOk())
      await callGenerate(middleware, makeParams(), inner)
      return inner.doGenerate.mock.calls.length
    }

    expect(await learn(baseProvider, 'router-opaque-7f2a')).toBe(2)
    // Same triple hits the learned shape in one call.
    const hit = await getMiddleware(baseProvider, model, makeAssistant('high'))
    const hitInner = makeInner()
    hitInner.doGenerate.mockResolvedValueOnce(generateOk())
    await callGenerate(hit, makeParams(), hitInner)
    expect(hitInner.doGenerate).toHaveBeenCalledTimes(1)

    // Each changed scope misses and renegotiates.
    expect(await learn(makeProvider({ apiHost: 'https://other.example.net' }), 'router-opaque-7f2a')).toBe(2)
    expect(await learn(baseProvider, 'router-opaque-bb91')).toBe(2)
    expect(await learn(makeProvider({ apiKey: 'sk-secret-2' }), 'router-opaque-7f2a')).toBe(2)
    expect(await learn(makeProvider({ extra_headers: { 'x-route': 'a' } }), 'router-opaque-7f2a')).toBe(2)
  })

  it('rediscovers enabled after a contradictory adaptive rejection and overwrites only on success', async () => {
    const provider = makeProvider()
    const model = makeModel()
    // Seed the learned adaptive shape from the default enabled shape.
    const setup = await getMiddleware(provider, model, makeAssistant('medium'))
    const setupInner = makeInner()
    setupInner.doGenerate
      .mockRejectedValueOnce(apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE)))
      .mockResolvedValueOnce(generateOk())
    await callGenerate(setup, makeParams(), setupInner)
    expect(setupInner.doGenerate).toHaveBeenCalledTimes(2)

    // Learned adaptive is now sent first and precisely rejected.
    const middleware = await getMiddleware(provider, model, makeAssistant('medium'))
    const inner = makeInner()
    inner.doGenerate
      .mockRejectedValueOnce(apiError(400, invalidRequestError(ADAPTIVE_REJECTED_MESSAGE)))
      .mockResolvedValueOnce(generateOk())
    await callGenerate(middleware, makeAdaptiveParams(), inner)
    expect(inner.doGenerate).toHaveBeenCalledTimes(2)
    const firstSend = inner.doGenerate.mock.calls[0][0] as LanguageModelV3CallOptions
    expect(anthropicBucketOf(firstSend).thinking).toEqual({ type: 'adaptive' })
    const retrySend = inner.doGenerate.mock.calls[1][0] as LanguageModelV3CallOptions
    // Opaque-model fallback budget for medium (8704) below the 64000 total.
    expect(anthropicBucketOf(retrySend)).toEqual({ thinking: { type: 'enabled', budgetTokens: 8704 } })
    expect(retrySend.maxOutputTokens).toBe(64000 - 8704)

    // The stale hint was overwritten: the next request sends enabled directly.
    const next = await getMiddleware(provider, model, makeAssistant('medium'))
    const nextInner = makeInner()
    nextInner.doGenerate.mockResolvedValueOnce(generateOk())
    await callGenerate(next, makeAdaptiveParams(), nextInner)
    expect(nextInner.doGenerate).toHaveBeenCalledTimes(1)
    expect(anthropicBucketOf(nextInner.doGenerate.mock.calls[0][0]).thinking).toEqual({
      type: 'enabled',
      budgetTokens: 8704
    })
  })

  it('inverts the actually-sent enabled shape when a learned enabled hint is contradicted', async () => {
    const provider = makeProvider()
    const model = makeModel()
    const assistant = makeAssistant('medium')
    // Manually seed the learned enabled hint for this exact connection scope.
    const scopeKey = await buildThinkingScopeKey({ provider, modelId: model.id })
    writeLearnedDialect(scopeKey, 'enabled')

    const controller = new AbortController()
    const params = makeAdaptiveParams({ abortSignal: controller.signal })
    const snapshot = JSON.parse(JSON.stringify({ ...params, abortSignal: undefined }))

    const middleware = await getMiddleware(provider, model, assistant)
    const inner = makeInner()
    inner.doGenerate
      .mockRejectedValueOnce(apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE)))
      .mockResolvedValueOnce(generateOk())
    const result = await callGenerate(middleware, params, inner)
    expect(result.content).toHaveLength(1)
    // Single alternate: exactly one retry.
    expect(inner.doGenerate).toHaveBeenCalledTimes(2)

    const firstSend = inner.doGenerate.mock.calls[0][0] as LanguageModelV3CallOptions
    // Learned enabled sent first: 64000 total -> 55296 + 8704 budget.
    expect(anthropicBucketOf(firstSend).thinking).toEqual({ type: 'enabled', budgetTokens: 8704 })
    expect(firstSend.maxOutputTokens).toBe(64000 - 8704)
    const retrySend = inner.doGenerate.mock.calls[1][0] as LanguageModelV3CallOptions
    // Retry inverts the actually-sent enabled shape back to adaptive 64000,
    // not the buggy 65024 (original 64000 + SDK default 1024).
    expect(anthropicBucketOf(retrySend)).toEqual({ thinking: { type: 'adaptive' }, effort: 'medium' })
    expect(retrySend.maxOutputTokens).toBe(64000)
    // Original abort signal and prompt intent preserved on the retry.
    expect((retrySend as { abortSignal?: unknown }).abortSignal).toBe(controller.signal)
    expect(retrySend.prompt).toEqual(params.prompt)

    // Input params were never mutated (ignoring the live AbortSignal).
    const after = JSON.parse(JSON.stringify({ ...params, abortSignal: undefined }))
    expect(after).toEqual(snapshot)
    expect((params as { abortSignal?: unknown }).abortSignal).toBe(controller.signal)

    // The successful adaptive retry was recorded and reused directly.
    const next = await getMiddleware(provider, model, assistant)
    const nextInner = makeInner()
    nextInner.doGenerate.mockResolvedValueOnce(generateOk())
    await callGenerate(next, makeAdaptiveParams(), nextInner)
    expect(nextInner.doGenerate).toHaveBeenCalledTimes(1)
    const learnedSend = nextInner.doGenerate.mock.calls[0][0] as LanguageModelV3CallOptions
    expect(anthropicBucketOf(learnedSend)).toEqual({ thinking: { type: 'adaptive' }, effort: 'medium' })
    expect(learnedSend.maxOutputTokens).toBe(64000)
  })

  it('inverts the actually-sent adaptive shape when a learned adaptive hint is contradicted', async () => {
    const provider = makeProvider()
    const model = makeModel()
    const assistant = makeAssistant('medium')
    // Manually seed the learned adaptive hint for this exact connection scope.
    const scopeKey = await buildThinkingScopeKey({ provider, modelId: model.id })
    writeLearnedDialect(scopeKey, 'adaptive')

    const controller = new AbortController()
    const params = makeParams({
      maxOutputTokens: 64000 - 8704,
      providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 8704 } } },
      abortSignal: controller.signal
    })
    const snapshot = JSON.parse(JSON.stringify({ ...params, abortSignal: undefined }))

    const middleware = await getMiddleware(provider, model, assistant)
    const inner = makeInner()
    inner.doGenerate
      .mockRejectedValueOnce(apiError(400, invalidRequestError(ADAPTIVE_REJECTED_MESSAGE)))
      .mockResolvedValueOnce(generateOk())
    const result = await callGenerate(middleware, params, inner)
    expect(result.content).toHaveLength(1)
    // Single alternate: exactly one retry.
    expect(inner.doGenerate).toHaveBeenCalledTimes(2)

    const firstSend = inner.doGenerate.mock.calls[0][0] as LanguageModelV3CallOptions
    // Learned adaptive sent first: 55296 + 8704 -> adaptive 64000.
    expect(anthropicBucketOf(firstSend)).toEqual({ thinking: { type: 'adaptive' }, effort: 'medium' })
    expect(firstSend.maxOutputTokens).toBe(64000)
    const retrySend = inner.doGenerate.mock.calls[1][0] as LanguageModelV3CallOptions
    // Retry inverts the actually-sent adaptive total back to enabled
    // 55296 + 8704, not the buggy 46592 (original 55296 - 8704).
    expect(anthropicBucketOf(retrySend)).toEqual({ thinking: { type: 'enabled', budgetTokens: 8704 } })
    expect(retrySend.maxOutputTokens).toBe(64000 - 8704)
    // Original abort signal and prompt intent preserved on the retry.
    expect((retrySend as { abortSignal?: unknown }).abortSignal).toBe(controller.signal)
    expect(retrySend.prompt).toEqual(params.prompt)

    // Input params were never mutated (ignoring the live AbortSignal).
    const after = JSON.parse(JSON.stringify({ ...params, abortSignal: undefined }))
    expect(after).toEqual(snapshot)
    expect((params as { abortSignal?: unknown }).abortSignal).toBe(controller.signal)

    // The successful enabled retry was recorded and reused directly.
    const next = await getMiddleware(provider, model, assistant)
    const nextInner = makeInner()
    nextInner.doGenerate.mockResolvedValueOnce(generateOk())
    await callGenerate(
      next,
      makeParams({
        maxOutputTokens: 64000 - 8704,
        providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 8704 } } }
      }),
      nextInner
    )
    expect(nextInner.doGenerate).toHaveBeenCalledTimes(1)
    const learnedSend = nextInner.doGenerate.mock.calls[0][0] as LanguageModelV3CallOptions
    expect(anthropicBucketOf(learnedSend).thinking).toEqual({ type: 'enabled', budgetTokens: 8704 })
    expect(learnedSend.maxOutputTokens).toBe(64000 - 8704)
  })

  it('bounds the enabled fallback to total-1 for small wire totals (4096 -> 4095 + 1)', async () => {
    const provider = makeProvider()
    const model = makeModel()
    const middleware = await getMiddleware(provider, model, makeAssistant('high'))
    const inner = makeInner()
    inner.doGenerate
      .mockRejectedValueOnce(apiError(400, invalidRequestError(ADAPTIVE_REJECTED_MESSAGE)))
      .mockResolvedValueOnce(generateOk())
    const params = makeAdaptiveParams({ maxOutputTokens: 4096 })
    await callGenerate(middleware, params, inner)
    expect(inner.doGenerate).toHaveBeenCalledTimes(2)
    const retrySend = inner.doGenerate.mock.calls[1][0] as LanguageModelV3CallOptions
    // Generic fallback for high (13312) exceeds the 4096 total, so it is
    // bounded to total-1 instead of failing as unconvertable.
    expect(anthropicBucketOf(retrySend)).toEqual({ thinking: { type: 'enabled', budgetTokens: 4095 } })
    expect(retrySend.maxOutputTokens).toBe(1)
  })

  it('preserves the original error when the wire total cannot fit a valid budget (1024)', async () => {
    const middleware = await getMiddleware(makeProvider(), makeModel(), makeAssistant('high'))
    const inner = makeInner()
    const failure = apiError(400, invalidRequestError(ADAPTIVE_REJECTED_MESSAGE))
    inner.doGenerate.mockRejectedValueOnce(failure)
    const params = makeAdaptiveParams({ maxOutputTokens: 1024 })
    await expect(callGenerate(middleware, params, inner)).rejects.toBe(failure)
    expect(inner.doGenerate).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
  })

  it('keeps undefined totals without inventing a limit on the reverse leg', async () => {
    const middleware = await getMiddleware(makeProvider(), makeModel(), makeAssistant('medium'))
    const inner = makeInner()
    inner.doGenerate
      .mockRejectedValueOnce(apiError(400, invalidRequestError(ADAPTIVE_REJECTED_MESSAGE)))
      .mockResolvedValueOnce(generateOk())
    const params = makeAdaptiveParams({ maxOutputTokens: undefined })
    await callGenerate(middleware, params, inner)
    expect(inner.doGenerate).toHaveBeenCalledTimes(2)
    const retrySend = inner.doGenerate.mock.calls[1][0] as LanguageModelV3CallOptions
    expect(anthropicBucketOf(retrySend)).toEqual({ thinking: { type: 'enabled', budgetTokens: 8704 } })
    expect(retrySend.maxOutputTokens).toBeUndefined()
  })

  it('retries at most once across both legs and surfaces the last error without learning', async () => {
    const middleware = await getMiddleware()
    const inner = makeInner()
    const firstError = apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE))
    const secondError = apiError(400, invalidRequestError(ADAPTIVE_REJECTED_MESSAGE))
    inner.doGenerate.mockRejectedValueOnce(firstError).mockRejectedValueOnce(secondError)
    await expect(callGenerate(middleware, makeParams(), inner)).rejects.toBe(secondError)
    expect(inner.doGenerate).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
  })

  it('shares one retry budget across calls of the same instance', async () => {
    const middleware = await getMiddleware()
    const inner = makeInner()
    inner.doGenerate.mockRejectedValue(apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE)))
    await expect(callGenerate(middleware, makeParams(), inner)).rejects.toBeTruthy()
    expect(inner.doGenerate).toHaveBeenCalledTimes(2)
    // Budget exhausted: the next step surfaces the original error with no retry.
    await expect(callGenerate(middleware, makeParams(), inner)).rejects.toBeTruthy()
    expect(inner.doGenerate).toHaveBeenCalledTimes(3)
  })

  it.each([{ effort: undefined }, { effort: 'default' }, { effort: 'none' }, { effort: 'minimal' }])(
    'never negotiates for reasoning effort $effort',
    async ({ effort }) => {
      const params =
        effort === 'none'
          ? makeParams({ providerOptions: { anthropic: { thinking: { type: 'disabled' } } } })
          : makeParams()
      const middleware = await getMiddleware(makeProvider(), makeModel(), makeAssistant(effort))
      const inner = makeInner()
      const failure = apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE))
      inner.doGenerate.mockRejectedValueOnce(failure)
      await expect(callGenerate(middleware, params, inner)).rejects.toBe(failure)
      expect(inner.doGenerate).toHaveBeenCalledTimes(1)
      expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
    }
  )

  it('passes default-shaped (thinking-absent) requests through untouched', async () => {
    const middleware = await getMiddleware()
    const inner = makeInner()
    inner.doGenerate.mockResolvedValueOnce(generateOk())
    const params = makeParams({ providerOptions: { anthropic: {} }, maxOutputTokens: undefined })
    const result = await callGenerate(middleware, params, inner)
    expect(result.finishReason.unified).toBe('stop')
    expect(inner.doGenerate).toHaveBeenCalledTimes(1)
    expect(inner.doGenerate.mock.calls[0][0]).toBe(params)
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
  })

  it('opts out when custom parameters explicitly control the thinking shape', async () => {
    const custom = [{ name: 'thinking', value: { type: 'adaptive' }, type: 'json' }]
    const middleware = await getMiddleware(
      makeProvider(),
      makeModel(),
      makeAssistant('high', { customParameters: custom })
    )
    const inner = makeInner()
    const failure = apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE))
    inner.doGenerate.mockRejectedValueOnce(failure)
    await expect(callGenerate(middleware, makeParams(), inner)).rejects.toBe(failure)
    expect(inner.doGenerate).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
  })

  it('does not apply a learned hint when custom parameters take over', async () => {
    const provider = makeProvider()
    const model = makeModel()
    const setup = await getMiddleware(provider, model, makeAssistant('high'))
    const setupInner = makeInner()
    setupInner.doGenerate
      .mockRejectedValueOnce(apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE)))
      .mockResolvedValueOnce(generateOk())
    await callGenerate(setup, makeParams(), setupInner)

    const custom = [{ name: 'anthropic', value: { effort: 'low' }, type: 'json' }]
    const middleware = await getMiddleware(provider, model, makeAssistant('high', { customParameters: custom }))
    const inner = makeInner()
    inner.doGenerate.mockResolvedValueOnce(generateOk())
    const params = makeParams()
    await callGenerate(middleware, params, inner)
    expect(inner.doGenerate).toHaveBeenCalledTimes(1)
    expect(inner.doGenerate.mock.calls[0][0]).toBe(params)
  })

  it.each([
    { name: '401', error: () => apiError(401, invalidRequestError(ENABLED_REJECTED_MESSAGE)) },
    { name: '429', error: () => apiError(429, invalidRequestError(ENABLED_REJECTED_MESSAGE)) },
    { name: '500', error: () => apiError(500, invalidRequestError(ENABLED_REJECTED_MESSAGE)) },
    { name: 'network', error: () => new TypeError('fetch failed') },
    {
      name: 'wrong error type',
      error: () =>
        apiError(400, {
          type: 'error',
          error: { type: 'authentication_error', message: ENABLED_REJECTED_MESSAGE }
        })
    },
    {
      name: 'budget validation without recommendation',
      error: () => apiError(400, invalidRequestError('thinking.budget_tokens (50000) must be less than max_tokens.'))
    },
    { name: 'malformed body', error: () => apiError(400, 'not json{{{') }
  ])('leaves $name errors transparent', async ({ error }) => {
    const middleware = await getMiddleware()
    const inner = makeInner()
    const failure = error()
    inner.doGenerate.mockRejectedValueOnce(failure)
    await expect(callGenerate(middleware, makeParams(), inner)).rejects.toBe(failure)
    expect(inner.doGenerate).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
  })

  it('does not retry when the request was aborted', async () => {
    const middleware = await getMiddleware()
    const inner = makeInner()
    const failure = apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE))
    inner.doGenerate.mockRejectedValueOnce(failure)
    const controller = new AbortController()
    controller.abort()
    await expect(callGenerate(middleware, makeParams({ abortSignal: controller.signal }), inner)).rejects.toBe(failure)
    expect(inner.doGenerate).toHaveBeenCalledTimes(1)
  })

  it('retries a rejected stream once and commits only after terminal success', async () => {
    const middleware = await getMiddleware()
    const inner = makeInner()
    inner.doStream
      .mockRejectedValueOnce(apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE)))
      .mockResolvedValueOnce({ stream: partsToStream(successParts()) })
    const result = await callStream(middleware, makeParams(), inner)
    expect(inner.doStream).toHaveBeenCalledTimes(2)
    const retrySend = inner.doStream.mock.calls[1][0] as LanguageModelV3CallOptions
    expect(anthropicBucketOf(retrySend)).toEqual({ thinking: { type: 'adaptive' }, effort: 'high' })
    const seen = await consume(result.stream)
    expect(seen.map((part) => part.type)).toContain('finish')
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toContain('adaptive')
  })

  it.each([
    {
      name: 'error part',
      parts: () => [...successParts().slice(0, 3), { type: 'error', error: 'boom' }] as never
    },
    { name: 'missing finish', parts: () => successParts().slice(0, 4) },
    {
      name: 'error finish',
      parts: () =>
        successParts().map((part) =>
          part.type === 'finish' ? { ...part, finishReason: { unified: 'error', raw: 'error' } } : part
        )
    }
  ])('never commits a stream with $name', async ({ parts }) => {
    const middleware = await getMiddleware()
    const inner = makeInner()
    inner.doStream
      .mockRejectedValueOnce(apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE)))
      .mockResolvedValueOnce({ stream: partsToStream(parts() as LanguageModelV3StreamPart[]) })
    const result = await callStream(middleware, makeParams(), inner)
    await consume(result.stream)
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
  })

  it('never commits when the stream errors or is cancelled after the retry', async () => {
    const middleware = await getMiddleware()
    const errorInner = makeInner()
    errorInner.doStream
      .mockRejectedValueOnce(apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE)))
      .mockResolvedValueOnce({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 't0' } as LanguageModelV3StreamPart)
            controller.error(new Error('mid-stream failure'))
          }
        })
      })
    const errored = await callStream(middleware, makeParams(), errorInner)
    // The mid-stream failure surfaces to the reader (already-queued chunks
    // are dropped when the pipe errors) and nothing is committed.
    const reader = errored.stream.getReader()
    await expect(reader.read()).rejects.toThrow('mid-stream failure')
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()

    const cancelInner = makeInner()
    cancelInner.doStream.mockResolvedValueOnce({ stream: partsToStream(successParts()) })
    const fresh = await getMiddleware()
    const cancellable = await callStream(fresh, makeParams(), cancelInner)
    await cancellable.stream.getReader().cancel()
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
  })

  it('does not commit a generate result with an error finish reason', async () => {
    const middleware = await getMiddleware()
    const inner = makeInner()
    inner.doGenerate
      .mockRejectedValueOnce(apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE)))
      .mockResolvedValueOnce({
        content: [],
        finishReason: { unified: 'error', raw: 'error' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: []
      })
    const result = await callGenerate(middleware, makeParams(), inner)
    expect(result.finishReason.unified).toBe('error')
    expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
  })
})
