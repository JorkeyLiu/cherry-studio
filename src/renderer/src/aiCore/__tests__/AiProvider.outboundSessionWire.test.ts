/**
 * AiProvider outbound session wire tests (real SDK, mocked fetch only).
 *
 * Proves the single request-boundary policy reaches the ACTUAL final
 * outbound HTTP headers through the installed AI SDK merge
 * (`combineHeaders(config.headers(), options.headers)` → fetch), not just
 * the AiProvider seam object. Coverage: Go topic identity, Go topicless
 * opaque identity, explicit case-insensitive win, provider-extra win over
 * automatic, and Zen/non-Go negatives.
 */
import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }
}))
vi.mock('@renderer/hooks/useSettings', () => ({ getEnableDeveloperMode: vi.fn(() => false) }))
vi.mock('@renderer/services/db/sendTimingDiagnostics', () => ({ logColdPathDiagnostic: vi.fn() }))
vi.mock('@renderer/services/SpanManagerService', () => ({ addSpan: vi.fn(), endSpan: vi.fn() }))
vi.mock('@renderer/utils', () => ({ getLowerBaseModelName: (id: string) => id.toLowerCase() }))
vi.mock('@renderer/aiCore/plugins/PluginBuilder', () => ({ buildPlugins: vi.fn(() => []) }))
vi.mock('@renderer/store', () => ({
  default: { getState: () => ({ settings: { openAI: { streamOptions: {} } } }) }
}))

import AiProvider from '../AiProvider'
import { OPENCODE_SESSION_HEADER } from '../prepareParams/header'

const SESSION = OPENCODE_SESSION_HEADER
const GO_HOST = 'https://opencode.ai/zen/go/v1'

function streamSse(modelId: string): string {
  const chunk = {
    id: 'chatcmpl-wire',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: modelId,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }]
  }
  const done = {
    id: 'chatcmpl-wire',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: modelId,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  }
  return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`
}

function installFetch() {
  const seen: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchMock = vi.fn(async (url: any, init: any) => {
    const raw = init?.headers ?? {}
    const headers: Record<string, string> = {}
    // fetch Headers are case-insensitive: normalize to observe the true wire
    // winner when case variants collide (later SDK options entry wins).
    const entries: Array<[string, string]> =
      typeof (raw as Headers)?.entries === 'function'
        ? Array.from((raw as Headers).entries())
        : Object.entries(raw as Record<string, string>)
    for (const [k, v] of entries) headers[k.toLowerCase()] = String(v)
    seen.push({ url: String(url), headers })
    return new Response(streamSse('wire-model'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  return { fetchMock, seen }
}

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'opencode-go',
    name: 'OpenCode Go',
    type: 'openai',
    apiKey: 'sk-fake-wire-key',
    apiHost: GO_HOST,
    models: [],
    ...overrides
  } as unknown as Provider
}

function makeModel(providerId: string): Model {
  return { id: 'wire-model', name: 'wire-model', provider: providerId } as Model
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('AiProvider outbound session wire (real SDK, mocked fetch)', () => {
  it('sends the stable topic identity on the Go endpoint', async () => {
    const { seen } = installFetch()
    const provider = makeProvider()
    const model = makeModel(provider.id)
    const ai = new AiProvider(model, provider)
    const result = await ai.completions(
      model.id,
      { prompt: 'hi' } as never,
      {
        assistant: { id: 'a' },
        callType: 'chat',
        topicId: 'topic-wire-1'
      } as never
    )
    expect(result.getText()).toContain('hi')
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toContain('/chat/completions')
    expect(seen[0].headers[SESSION]).toBe('topic-wire-1')
  })

  it('mints a topicless opaque identity without user/model content', async () => {
    const { seen } = installFetch()
    const provider = makeProvider()
    const model = makeModel(provider.id)
    const ai = new AiProvider(model, provider)
    await ai.completions(
      model.id,
      { prompt: 'hi' } as never,
      {
        assistant: { id: 'a' },
        callType: 'generate'
      } as never
    )
    const value = seen[0].headers[SESSION] ?? ''
    expect(value).toBeTruthy()
    expect(value).not.toContain('wire-model')
    expect(value).not.toContain('OpenCode Go')
  })

  it('explicit per-request headers win case-insensitively on the wire', async () => {
    const { seen } = installFetch()
    const provider = makeProvider()
    const model = makeModel(provider.id)
    const ai = new AiProvider(model, provider)
    await ai.completions(
      model.id,
      { prompt: 'hi', headers: { 'X-OpenCode-Session': 'caller-mixed' } } as never,
      { assistant: { id: 'a' }, callType: 'chat', topicId: 'topic-wire-1' } as never
    )
    // Normalized wire headers collapse case variants with the explicit value.
    expect(seen[0].headers[SESSION]).toBe('caller-mixed')
  })

  it('provider extra session wins over the automatic identity on the wire', async () => {
    const { seen } = installFetch()
    const provider = makeProvider({ extra_headers: { [SESSION]: 'provider-extra' } })
    const model = makeModel(provider.id)
    const ai = new AiProvider(model, provider)
    await ai.completions(
      model.id,
      { prompt: 'hi' } as never,
      {
        assistant: { id: 'a' },
        callType: 'chat',
        topicId: 'topic-wire-1'
      } as never
    )
    expect(seen[0].headers[SESSION]).toBe('provider-extra')
  })

  it('explicit mixed-case session wins over lowercase provider-extra on the wire with custom headers/auth retained', async () => {
    const { seen } = installFetch()
    const provider = makeProvider({
      extra_headers: { [SESSION]: 'provider-extra', 'X-Custom': 'provider-keep' }
    })
    const model = makeModel(provider.id)
    const ai = new AiProvider(model, provider)
    await ai.completions(
      model.id,
      {
        prompt: 'hi',
        headers: { 'X-OpenCode-Session': 'caller-mixed', 'X-Extra': 'request-keep' }
      } as never,
      { assistant: { id: 'a' }, callType: 'chat', topicId: 'topic-wire-1' } as never
    )
    expect(seen).toHaveLength(1)
    // Single final normalized winner: the explicit per-request value, with
    // no provider-extra leakage under any case variant.
    expect(seen[0].headers[SESSION]).toBe('caller-mixed')
    expect(seen[0].headers[SESSION]).not.toBe('provider-extra')
    // Unrelated custom headers from both layers are retained.
    expect(seen[0].headers['x-custom']).toBe('provider-keep')
    expect(seen[0].headers['x-extra']).toBe('request-keep')
    // Auth still reaches the wire untouched by the header precedence.
    expect(seen[0].headers['authorization']).toBe('Bearer sk-fake-wire-key')
  })

  it('sends no session header for Zen and non-Go endpoints', async () => {
    for (const apiHost of ['https://opencode.ai/zen/v1', 'https://api.deepseek.com/v1']) {
      const { seen } = installFetch()
      const provider = makeProvider({ id: 'other', apiHost })
      const model = makeModel(provider.id)
      const ai = new AiProvider(model, provider)
      await ai.completions(
        model.id,
        { prompt: 'hi' } as never,
        {
          assistant: { id: 'a' },
          callType: 'chat',
          topicId: 'topic-wire-1'
        } as never
      )
      expect(seen[0].headers[SESSION]).toBeUndefined()
    }
  })
})
