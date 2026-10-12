import type * as AiCoreProviderModule from '@cherrystudio/ai-core/provider'
import type { Assistant, Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HeaderModule from '../header'
import {
  addAnthropicHeaders,
  generateRequestSessionId,
  getHeaderValue,
  isOpenCodeGoEndpoint,
  OPENCODE_SESSION_HEADER,
  resolveOutboundRequestHeaders
} from '../header'
import { buildStreamTextParams, getEffectiveMaxToolCalls } from '../parameterBuilder'

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      llm: { defaultModel: undefined }
    }),
    dispatch: vi.fn()
  }
}))

vi.mock('@renderer/aiCore/utils/options', () => ({
  buildProviderOptions: vi.fn(() => ({ providerOptions: {}, standardParams: {} }))
}))

vi.mock('@renderer/utils/prompt', () => ({
  replacePromptVariables: vi.fn(async (text: string) => text)
}))

vi.mock('@cherrystudio/ai-core/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof AiCoreProviderModule>()
  return {
    ...actual,
    extensionRegistry: { has: vi.fn(() => false) }
  }
})

vi.mock('@renderer/utils/provider', () => ({
  isSupportUrlContextProvider: vi.fn(() => false)
}))

vi.mock('../header', async (importOriginal) => {
  const actual = await importOriginal<typeof HeaderModule>()
  return {
    ...actual,
    addAnthropicHeaders: vi.fn(() => [] as string[])
  }
})

describe('getEffectiveMaxToolCalls', () => {
  it('uses the default cap when settings are missing', () => {
    expect(getEffectiveMaxToolCalls()).toBe(20)
  })

  it('uses the default cap when the switch is off', () => {
    expect(
      getEffectiveMaxToolCalls({
        enableMaxToolCalls: false,
        maxToolCalls: 50
      })
    ).toBe(20)
  })

  it('uses a custom cap when enabled', () => {
    expect(
      getEffectiveMaxToolCalls({
        enableMaxToolCalls: true,
        maxToolCalls: 50
      })
    ).toBe(50)
  })

  it('clamps invalid custom values back to the default cap', () => {
    expect(
      getEffectiveMaxToolCalls({
        enableMaxToolCalls: true,
        maxToolCalls: 999
      })
    ).toBe(20)
  })

  it('uses the default cap for old assistants without the new fields', () => {
    expect(
      getEffectiveMaxToolCalls({
        temperature: 0.7,
        contextCount: 10
      } as { maxToolCalls?: number; enableMaxToolCalls?: boolean })
    ).toBe(20)
  })
})

describe('buildStreamTextParams never injects x-opencode-session (AiProvider boundary owns it)', () => {
  const opencodeGoProvider = {
    id: 'test-opencode-go',
    name: 'OpenCode Go',
    type: 'openai',
    apiHost: 'https://opencode.ai/zen/go/v1'
  } as unknown as Provider

  const anthropicProvider = {
    id: 'test-anthropic',
    name: 'Test Anthropic',
    type: 'anthropic',
    apiHost: 'https://api.anthropic.com'
  } as unknown as Provider

  const opencodeGoModel = {
    id: 'some-model-behind-go-gateway',
    name: 'Some Model Behind Go Gateway',
    provider: 'test-opencode-go'
  } as unknown as Model

  const claudeModel = {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    provider: 'test-anthropic'
  } as unknown as Model

  const makeAssistant = (model: Model) =>
    ({
      id: 'test-assistant',
      name: 'Test Assistant',
      prompt: '',
      topics: [],
      messages: [],
      type: 'assistant',
      settings: {},
      model
    }) as unknown as Assistant

  beforeEach(() => {
    vi.mocked(addAnthropicHeaders).mockReturnValue([])
  })

  it('forwards explicit caller headers untouched without fabricating a session identity', async () => {
    const assistant = makeAssistant(opencodeGoModel)
    // Even on the Go endpoint the builder emits no session header: the
    // AiProvider request boundary mints topic/topicless identity instead.
    const bare = await buildStreamTextParams([], assistant, opencodeGoProvider, {})
    try {
      expect(bare.params.headers?.[OPENCODE_SESSION_HEADER]).toBeUndefined()
    } finally {
      bare.idleTimeout.cleanup()
    }

    const explicit = await buildStreamTextParams([], assistant, opencodeGoProvider, {
      requestOptions: { headers: { [OPENCODE_SESSION_HEADER]: 'caller-value', 'x-custom': 'keep' } }
    })
    try {
      // Explicit headers pass through byte-for-byte (no auto injection, no
      // duplicate canonical header, unrelated headers preserved).
      expect(explicit.params.headers?.[OPENCODE_SESSION_HEADER]).toBe('caller-value')
      expect(explicit.params.headers?.['x-custom']).toBe('keep')
    } finally {
      explicit.idleTimeout.cleanup()
    }
  })

  it('keeps the Anthropic beta header behavior without the session header on non-Go hosts', async () => {
    vi.mocked(addAnthropicHeaders).mockReturnValue(['interleaved-thinking-2025-05-14'])
    const assistant = makeAssistant(claudeModel)
    const withExplicit = await buildStreamTextParams([], assistant, anthropicProvider, {
      requestOptions: { headers: { 'x-custom': 'keep' } }
    })
    try {
      expect(withExplicit.params.headers?.[OPENCODE_SESSION_HEADER]).toBeUndefined()
      expect(withExplicit.params.headers?.['anthropic-beta']).toBe('interleaved-thinking-2025-05-14')
      expect(withExplicit.params.headers?.['x-custom']).toBe('keep')
    } finally {
      withExplicit.idleTimeout.cleanup()
    }
  })
})

describe('isOpenCodeGoEndpoint', () => {
  it('matches only the official HTTPS Go endpoint', () => {
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/go/v1')).toBe(true)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/go')).toBe(true)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/go/')).toBe(true)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/go/v1/')).toBe(true)
    // Case-insensitive host and path.
    expect(isOpenCodeGoEndpoint('HTTPS://OPENCODE.AI/ZEN/GO/V1')).toBe(true)
    // Existing apiHost formats: surrounding whitespace, trailing slash,
    // trailing-# endpoint marker, query strings and fragments.
    expect(isOpenCodeGoEndpoint('  https://opencode.ai/zen/go/v1  ')).toBe(true)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/go/v1/responses#')).toBe(true)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/go/v1?foo=bar')).toBe(true)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/go/v1#responses')).toBe(true)
  })

  it('rejects non-Go and forged endpoints', () => {
    // Ordinary Zen, DeepSeek direct, other OpenAI-compatible.
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/v1')).toBe(false)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen')).toBe(false)
    expect(isOpenCodeGoEndpoint('https://api.deepseek.com/v1')).toBe(false)
    expect(isOpenCodeGoEndpoint('https://example.com/v1')).toBe(false)
    // Suffix/prefix spoofing never matches (strict hostname + path prefix).
    expect(isOpenCodeGoEndpoint('https://opencode.ai.evil.com/zen/go/v1')).toBe(false)
    expect(isOpenCodeGoEndpoint('https://evil-opencode.ai/zen/go/v1')).toBe(false)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/goevil')).toBe(false)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/gopher/v1')).toBe(false)
    // Production requires HTTPS; plain http never matches.
    expect(isOpenCodeGoEndpoint('http://opencode.ai/zen/go/v1')).toBe(false)
    // Empty/invalid inputs never match.
    expect(isOpenCodeGoEndpoint(undefined)).toBe(false)
    expect(isOpenCodeGoEndpoint('')).toBe(false)
    expect(isOpenCodeGoEndpoint('   ')).toBe(false)
    expect(isOpenCodeGoEndpoint('not a url')).toBe(false)
  })
})

describe('resolveOutboundRequestHeaders (single request-boundary policy)', () => {
  const GO_HOST = 'https://opencode.ai/zen/go/v1'

  it('uses the stable topic identity for topic-scoped calls', () => {
    const first = resolveOutboundRequestHeaders({ apiHost: GO_HOST, topicId: 'topic-123' })
    const second = resolveOutboundRequestHeaders({ apiHost: GO_HOST, topicId: 'topic-123' })
    // Stability: the same topicId yields the identical value across
    // retries/continuations within the conversation.
    expect(first?.[OPENCODE_SESSION_HEADER]).toBe('topic-123')
    expect(second?.[OPENCODE_SESSION_HEADER]).toBe('topic-123')
  })

  it('mints one request-local opaque identity for genuinely topicless calls', () => {
    const headers = resolveOutboundRequestHeaders({ apiHost: GO_HOST, generateId: () => 'opaque-req-1' })
    expect(headers?.[OPENCODE_SESSION_HEADER]).toBe('opaque-req-1')
    for (const topicId of [undefined, '', '   '] as const) {
      const topicless = resolveOutboundRequestHeaders({ apiHost: GO_HOST, topicId, generateId: () => 'opaque-req-2' })
      // Blank/missing topicId never reuses a topic identity: the value is
      // exactly the generated opaque id (not a fake topic/persisted id).
      expect(topicless?.[OPENCODE_SESSION_HEADER]).toBe('opaque-req-2')
    }
  })

  it('generates an opaque default identity without user/model content', () => {
    const headers = resolveOutboundRequestHeaders({ apiHost: GO_HOST })
    const value = headers?.[OPENCODE_SESSION_HEADER] ?? ''
    expect(value).toBeTruthy()
    expect(value).not.toContain('user-1')
    expect(generateRequestSessionId()).toBeTruthy()
    expect(getHeaderValue(headers, OPENCODE_SESSION_HEADER)).toBe(value)
    expect(getHeaderValue(headers, 'X-OPENCODE-SESSION')).toBe(value)
  })

  it('sends nothing on non-Go hosts (Zen and other endpoints unchanged)', () => {
    expect(resolveOutboundRequestHeaders({ apiHost: 'https://opencode.ai/zen/v1', topicId: 't1' })).toBeUndefined()
    expect(resolveOutboundRequestHeaders({ apiHost: 'https://api.deepseek.com/v1', topicId: 't1' })).toBeUndefined()
    expect(resolveOutboundRequestHeaders({ apiHost: undefined, topicId: 't1' })).toBeUndefined()
  })

  it('lets an explicit caller header win case-insensitively without duplication', () => {
    const explicit = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      topicId: 'topic-1',
      explicitHeaders: { [OPENCODE_SESSION_HEADER]: 'caller-value' }
    })
    expect(explicit?.[OPENCODE_SESSION_HEADER]).toBe('caller-value')

    const mixed = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      topicId: 'topic-1',
      explicitHeaders: { 'X-OpenCode-Session': 'caller-mixed' }
    })
    expect(mixed?.['X-OpenCode-Session']).toBe('caller-mixed')
    expect(mixed?.[OPENCODE_SESSION_HEADER]).toBeUndefined()
  })

  it('lets provider extra session win over the automatic identity', () => {
    const viaProvider = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      topicId: 'topic-1',
      providerExtraHeaders: { [OPENCODE_SESSION_HEADER]: 'provider-extra' }
    })
    // No per-request injection: the provider value flows via config headers.
    expect(viaProvider?.[OPENCODE_SESSION_HEADER]).toBeUndefined()

    const explicitBeatsProvider = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      topicId: 'topic-1',
      explicitHeaders: { 'X-OPENCODE-SESSION': 'caller-mixed' },
      providerExtraHeaders: { [OPENCODE_SESSION_HEADER]: 'provider-extra' }
    })
    expect(explicitBeatsProvider?.['X-OPENCODE-SESSION']).toBe('caller-mixed')
  })

  it('merges non-conflicting explicit headers alongside the session header', () => {
    const merged = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      topicId: undefined,
      explicitHeaders: { 'x-custom': 'keep' },
      generateId: () => 'opaque-1'
    })
    expect(merged?.[OPENCODE_SESSION_HEADER]).toBe('opaque-1')
    expect(merged?.['x-custom']).toBe('keep')
  })

  it('injects for Go apiHost variants without copying endpoint logic', () => {
    // Endpoint strictness itself is owned by isOpenCodeGoEndpoint; here we
    // only assert representative Go vs non-Go routing through the policy.
    expect(
      resolveOutboundRequestHeaders({
        apiHost: 'https://opencode.ai/zen/go/v1/responses',
        topicId: 't1'
      })?.[OPENCODE_SESSION_HEADER]
    ).toBe('t1')
    expect(resolveOutboundRequestHeaders({ apiHost: 'https://api.deepseek.com/v1', topicId: 't1' })).toBeUndefined()
    expect(resolveOutboundRequestHeaders({ apiHost: 'https://opencode.ai/zen/v1', topicId: 't1' })).toBeUndefined()
  })
})
