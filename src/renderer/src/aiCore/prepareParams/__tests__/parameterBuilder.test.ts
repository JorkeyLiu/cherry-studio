import type * as AiCoreProviderModule from '@cherrystudio/ai-core/provider'
import type { Assistant, Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HeaderModule from '../header'
import {
  addAnthropicHeaders,
  buildOpencodeCheckSessionHeaders,
  isOpenCodeGoEndpoint,
  OPENCODE_SESSION_HEADER
} from '../header'
import { buildStreamTextParams, getEffectiveMaxToolCalls } from '../parameterBuilder'

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      llm: { defaultModel: undefined },
      websearch: { maxResults: 5, excludeDomains: [], searchWithTime: false }
    }),
    dispatch: vi.fn()
  }
}))

vi.mock('@renderer/aiCore/utils/options', () => ({
  buildProviderOptions: vi.fn(() => ({ providerOptions: {}, standardParams: {} }))
}))

vi.mock('@renderer/aiCore/utils/mcp', () => ({
  setupToolsConfig: vi.fn(() => undefined)
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

vi.mock('@renderer/config/prompts-code-mode', () => ({
  getHubModeSystemPrompt: vi.fn(() => undefined)
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

describe('buildStreamTextParams x-opencode-session', () => {
  const openaiProvider = {
    id: 'test-openai',
    name: 'Test OpenAI',
    type: 'openai',
    apiHost: 'https://example.com/v1'
  } as unknown as Provider

  const anthropicProvider = {
    id: 'test-anthropic',
    name: 'Test Anthropic',
    type: 'anthropic',
    apiHost: 'https://api.anthropic.com'
  } as unknown as Provider

  const deepseekProvider = {
    id: 'test-deepseek',
    name: 'DeepSeek',
    type: 'deepseek',
    apiHost: 'https://api.deepseek.com/v1'
  } as unknown as Provider

  const opencodeGoProvider = {
    id: 'test-opencode-go',
    name: 'OpenCode Go',
    type: 'openai',
    apiHost: 'https://opencode.ai/zen/go/v1'
  } as unknown as Provider

  const opencodeZenProvider = {
    id: 'test-opencode-zen',
    name: 'OpenCode Zen',
    type: 'openai',
    apiHost: 'https://opencode.ai/zen/v1'
  } as unknown as Provider

  const openaiModel = {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    provider: 'test-openai'
  } as unknown as Model

  const claudeModel = {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    provider: 'test-anthropic'
  } as unknown as Model

  const deepseekModel = {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    provider: 'test-deepseek'
  } as unknown as Model

  const opencodeGoModel = {
    id: 'some-model-behind-go-gateway',
    name: 'Some Model Behind Go Gateway',
    provider: 'test-opencode-go'
  } as unknown as Model

  const opencodeZenModel = {
    id: 'some-model-behind-zen',
    name: 'Some Model Behind Zen',
    provider: 'test-opencode-zen'
  } as unknown as Model

  const makeAssistant = (model: Model) =>
    ({
      id: 'test-assistant',
      name: 'Test Assistant',
      prompt: '',
      topics: [],
      messages: [],
      type: 'assistant',
      mcpMode: 'disabled',
      settings: {},
      model
    }) as unknown as Assistant

  beforeEach(() => {
    vi.mocked(addAnthropicHeaders).mockReturnValue([])
  })

  it('emits a stable x-opencode-session header from topicId on the OpenCode Go endpoint', async () => {
    const assistant = makeAssistant(opencodeGoModel)
    const first = await buildStreamTextParams([], assistant, opencodeGoProvider, { topicId: 'topic-123' })
    const second = await buildStreamTextParams([], assistant, opencodeGoProvider, { topicId: 'topic-123' })
    try {
      // Stability: the same topicId must yield the identical value on every
      // request within the conversation (gateway routing/cache identity).
      expect(first.params.headers?.[OPENCODE_SESSION_HEADER]).toBe('topic-123')
      expect(second.params.headers?.[OPENCODE_SESSION_HEADER]).toBe('topic-123')
    } finally {
      first.idleTimeout.cleanup()
      second.idleTimeout.cleanup()
    }
  })

  it('sends no session identity without a topicId (no fabrication)', async () => {
    const assistant = makeAssistant(opencodeGoModel)
    const cases = [undefined, '', '   '] as const
    for (const topicId of cases) {
      const result = await buildStreamTextParams(
        [],
        assistant,
        opencodeGoProvider,
        topicId === undefined ? {} : { topicId }
      )
      try {
        // translate/check/generate/listModels-style calls without a topic must
        // not fabricate a session identity.
        expect(result.params.headers?.[OPENCODE_SESSION_HEADER]).toBeUndefined()
      } finally {
        result.idleTimeout.cleanup()
      }
    }
  })

  it('preserves an explicit caller header of the same name', async () => {
    const assistant = makeAssistant(opencodeGoModel)
    const lower = await buildStreamTextParams([], assistant, opencodeGoProvider, {
      topicId: 'topic-123',
      requestOptions: { headers: { [OPENCODE_SESSION_HEADER]: 'caller-value' } }
    })
    try {
      expect(lower.params.headers?.[OPENCODE_SESSION_HEADER]).toBe('caller-value')
    } finally {
      lower.idleTimeout.cleanup()
    }

    // HTTP header names are case-insensitive: an explicit differently-cased
    // caller header must also win without emitting a duplicate default.
    const mixed = await buildStreamTextParams([], assistant, opencodeGoProvider, {
      topicId: 'topic-123',
      requestOptions: { headers: { 'X-OpenCode-Session': 'caller-mixed' } }
    })
    try {
      expect(mixed.params.headers?.['X-OpenCode-Session']).toBe('caller-mixed')
      expect(mixed.params.headers?.[OPENCODE_SESSION_HEADER]).toBeUndefined()
    } finally {
      mixed.idleTimeout.cleanup()
    }
  })

  it('keeps the Anthropic beta header behavior without the session header on non-Go hosts', async () => {
    vi.mocked(addAnthropicHeaders).mockReturnValue(['interleaved-thinking-2025-05-14'])
    const assistant = makeAssistant(claudeModel)
    const withTopic = await buildStreamTextParams([], assistant, anthropicProvider, { topicId: 'topic-123' })
    try {
      // Anthropic hosts are not the OpenCode Go endpoint: no session header,
      // even with a topicId. The beta header behavior is unchanged.
      expect(withTopic.params.headers?.[OPENCODE_SESSION_HEADER]).toBeUndefined()
      expect(withTopic.params.headers?.['anthropic-beta']).toBe('interleaved-thinking-2025-05-14')
    } finally {
      withTopic.idleTimeout.cleanup()
    }

    const withoutTopic = await buildStreamTextParams([], assistant, anthropicProvider, {})
    try {
      expect(withoutTopic.params.headers?.['anthropic-beta']).toBe('interleaved-thinking-2025-05-14')
      expect(withoutTopic.params.headers?.[OPENCODE_SESSION_HEADER]).toBeUndefined()
    } finally {
      withoutTopic.idleTimeout.cleanup()
    }
  })

  it('does not inject the session header for non-OpenCode providers even with a topicId', async () => {
    const cases = [
      { assistant: makeAssistant(openaiModel), provider: openaiProvider },
      { assistant: makeAssistant(deepseekModel), provider: deepseekProvider },
      { assistant: makeAssistant(claudeModel), provider: anthropicProvider }
    ] as const
    for (const { assistant, provider } of cases) {
      const result = await buildStreamTextParams([], assistant, provider as unknown as Provider, {
        topicId: 'topic-123'
      })
      try {
        expect(result.params.headers?.[OPENCODE_SESSION_HEADER]).toBeUndefined()
      } finally {
        result.idleTimeout.cleanup()
      }
    }
  })

  it('does not inject the session header for ordinary OpenCode Zen (/zen/v1)', async () => {
    const assistant = makeAssistant(opencodeZenModel)
    const result = await buildStreamTextParams([], assistant, opencodeZenProvider, { topicId: 'topic-123' })
    try {
      expect(result.params.headers?.[OPENCODE_SESSION_HEADER]).toBeUndefined()
    } finally {
      result.idleTimeout.cleanup()
    }
  })

  it('injects the session header for OpenCode Go apiHost variants (case, slash, #endpoint)', async () => {
    const assistant = makeAssistant(opencodeGoModel)
    const variants = [
      'https://opencode.ai/zen/go/v1',
      'https://opencode.ai/zen/go/v1/',
      'https://opencode.ai/zen/go',
      'https://opencode.ai/zen/go/',
      'HTTPS://OPENCODE.AI/ZEN/GO/V1',
      '  https://opencode.ai/zen/go/v1  ',
      'https://opencode.ai/zen/go/v1/responses#',
      'https://opencode.ai/zen/go/v1?foo=bar'
    ]
    for (const apiHost of variants) {
      const provider = { ...opencodeGoProvider, apiHost } as unknown as Provider
      const result = await buildStreamTextParams([], assistant, provider, { topicId: 'topic-123' })
      try {
        expect(result.params.headers?.[OPENCODE_SESSION_HEADER]).toBe('topic-123')
      } finally {
        result.idleTimeout.cleanup()
      }
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

describe('buildOpencodeCheckSessionHeaders (one-shot checkApi identity)', () => {
  const GO_HOST = 'https://opencode.ai/zen/go/v1'

  it('emits the synthetic check id as the session header on the Go endpoint', () => {
    const headers = buildOpencodeCheckSessionHeaders(GO_HOST, 'check-uuid-123')
    expect(headers?.[OPENCODE_SESSION_HEADER]).toBe('check-uuid-123')
  })

  it('emits the header for apiHost variants without copying endpoint logic', () => {
    // Endpoint strictness itself is owned by isOpenCodeGoEndpoint; here we
    // only assert representative Go vs non-Go routing.
    expect(
      buildOpencodeCheckSessionHeaders('https://opencode.ai/zen/go/v1/responses', 'check-1')?.[OPENCODE_SESSION_HEADER]
    ).toBe('check-1')
    expect(buildOpencodeCheckSessionHeaders('https://api.deepseek.com/v1', 'check-1')).toBeUndefined()
    expect(buildOpencodeCheckSessionHeaders('https://opencode.ai/zen/v1', 'check-1')).toBeUndefined()
  })

  it('sends nothing on non-Go hosts (behavior unchanged)', () => {
    expect(buildOpencodeCheckSessionHeaders('https://api.deepseek.com/v1', 'check-1')).toBeUndefined()
    expect(buildOpencodeCheckSessionHeaders('https://example.com/v1', 'check-1')).toBeUndefined()
    expect(buildOpencodeCheckSessionHeaders(undefined, 'check-1')).toBeUndefined()
    expect(buildOpencodeCheckSessionHeaders('', 'check-1')).toBeUndefined()
  })

  it('sends nothing without a usable check id (no fabrication)', () => {
    for (const checkId of [undefined, '', '   '] as const) {
      expect(buildOpencodeCheckSessionHeaders(GO_HOST, checkId)).toBeUndefined()
    }
  })

  it('uses only the synthetic check id, never user/model content', () => {
    const headers = buildOpencodeCheckSessionHeaders(GO_HOST, 'check-uuid-123')
    const value = headers?.[OPENCODE_SESSION_HEADER] ?? ''
    // The value is exactly the synthetic per-check id: it must not embed
    // user, provider, or model identifiers.
    expect(value).toBe('check-uuid-123')
    expect(value).not.toContain('user-1')
    expect(value).not.toContain('OpenCode Go')
    expect(value).not.toContain('some-model')
  })

  it('lets an explicit caller header win case-insensitively without duplication', () => {
    const explicit = buildOpencodeCheckSessionHeaders(GO_HOST, 'check-1', {
      [OPENCODE_SESSION_HEADER]: 'caller-value'
    })
    expect(explicit?.[OPENCODE_SESSION_HEADER]).toBe('caller-value')

    const mixed = buildOpencodeCheckSessionHeaders(GO_HOST, 'check-1', {
      'X-OpenCode-Session': 'caller-mixed'
    })
    expect(mixed?.['X-OpenCode-Session']).toBe('caller-mixed')
    expect(mixed?.[OPENCODE_SESSION_HEADER]).toBeUndefined()
  })

  it('merges non-conflicting explicit headers alongside the session header', () => {
    const merged = buildOpencodeCheckSessionHeaders(GO_HOST, 'check-1', { 'x-custom': 'keep' })
    expect(merged?.[OPENCODE_SESSION_HEADER]).toBe('check-1')
    expect(merged?.['x-custom']).toBe('keep')
  })
})
