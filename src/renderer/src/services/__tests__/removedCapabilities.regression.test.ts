import { buildPlugins } from '@renderer/aiCore/plugins/PluginBuilder'
import { buildStreamTextParams } from '@renderer/aiCore/prepareParams/parameterBuilder'
import {
  createAssistantDefaults,
  createAssistantFromDefaults,
  createEphemeralAssistant,
  toAssistantDefaults
} from '@renderer/services/assistantDefaults'
import type { Assistant, Model, Provider } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      llm: { defaultModel: undefined, providers: [] },
      settings: {}
    })
  }
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  getStoreSetting: () => undefined
}))

const makeModel = (): Model => ({
  id: 'gemini-2.0-flash',
  provider: 'gemini',
  name: 'Gemini Flash',
  group: 'Gemini'
})

const makeProvider = (): Provider =>
  ({
    id: 'gemini',
    name: 'Gemini',
    type: 'gemini',
    apiKey: 'k',
    apiHost: 'https://example.com'
  }) as unknown as Provider

const makeAssistant = (overrides: Partial<Assistant> = {}): Assistant =>
  ({
    id: 'a1',
    name: 'A',
    prompt: 'hi',
    type: 'assistant',
    topics: [],
    messages: [],
    settings: {
      temperature: 1,
      topP: 1,
      contextCount: 5,
      streamOutput: true,
      reasoning_effort: 'default',
      toolUseMode: 'function'
    },
    model: makeModel(),
    ...overrides
  }) as Assistant

describe('removed capabilities regression (MCP / websearch / memory)', () => {
  it('toAssistantDefaults drops legacy backend fields and keeps urlContext', () => {
    const legacy = {
      name: 'Old',
      prompt: 'p',
      type: 'assistant',
      enableWebSearch: true,
      webSearchProviderId: 'tavily',
      mcpMode: 'manual',
      mcpServers: [{ id: 's1' }],
      enableMemory: true,
      enableUrlContext: true,
      knowledge_bases: [{ id: 'kb1' }]
    }
    const next = toAssistantDefaults(legacy)
    expect((next as unknown as Record<string, unknown>).enableWebSearch).toBeUndefined()
    expect((next as unknown as Record<string, unknown>).webSearchProviderId).toBeUndefined()
    expect((next as unknown as Record<string, unknown>).mcpMode).toBeUndefined()
    expect((next as unknown as Record<string, unknown>).mcpServers).toBeUndefined()
    expect((next as unknown as Record<string, unknown>).enableMemory).toBeUndefined()
    expect(next.enableUrlContext).toBe(true)
  })

  it('createAssistantFromDefaults strips legacy overrides and keeps urlContext', () => {
    const defaults = createAssistantDefaults({ enableUrlContext: true })
    const assistant = createAssistantFromDefaults(defaults, {
      enableWebSearch: true,
      webSearchProviderId: 'tavily',
      mcpMode: 'manual',
      mcpServers: [{ id: 's1' }],
      enableMemory: true
    } as unknown as Partial<Assistant>)
    expect((assistant as Record<string, unknown>).enableWebSearch).toBeUndefined()
    expect((assistant as Record<string, unknown>).webSearchProviderId).toBeUndefined()
    expect((assistant as Record<string, unknown>).mcpMode).toBeUndefined()
    expect((assistant as Record<string, unknown>).mcpServers).toBeUndefined()
    expect((assistant as Record<string, unknown>).enableMemory).toBeUndefined()
    expect(assistant.enableUrlContext).toBe(true)
  })

  it('createEphemeralAssistant strips legacy fields', () => {
    const ephemeral = createEphemeralAssistant({
      enableWebSearch: true,
      mcpMode: 'auto',
      enableMemory: true
    } as unknown as Partial<Assistant>)
    expect((ephemeral as Record<string, unknown>).enableWebSearch).toBeUndefined()
    expect((ephemeral as Record<string, unknown>).mcpMode).toBeUndefined()
    expect((ephemeral as Record<string, unknown>).enableMemory).toBeUndefined()
  })

  it('buildStreamTextParams retains urlContext capability and injects no removed search/MCP', async () => {
    const assistant = makeAssistant({ enableUrlContext: true } as Partial<Assistant>)
    // Legacy fields must not be present on the request assistant.
    expect((assistant as Record<string, unknown>).enableWebSearch).toBeUndefined()
    expect((assistant as Record<string, unknown>).webSearchProviderId).toBeUndefined()

    const { params, capabilities } = await buildStreamTextParams(
      [{ role: 'user', content: 'hello' }],
      assistant,
      makeProvider(),
      {}
    )
    expect(capabilities.enableUrlContext).toBe(true)
    expect((capabilities as unknown as Record<string, unknown>).enableWebSearch).toBeUndefined()
    expect(params.tools).toBeUndefined()
    expect(params.system).toBe('hi')
  })

  it('buildPlugins keeps urlContext + knowledge orchestration and no removed websearch/MCP', () => {
    const assistant = makeAssistant({
      enableUrlContext: true,
      knowledge_bases: [{ id: 'kb1' } as never],
      knowledgeRecognition: 'on'
    })
    const plugins = buildPlugins({
      provider: makeProvider(),
      model: makeModel(),
      config: {
        assistant,
        streamOutput: true,
        enableReasoning: false,
        isPromptToolUse: false,
        isSupportedToolUse: true,
        enableGenerateImage: false,
        enableUrlContext: true
      } as never
    })
    const names = plugins.map((p) => p.name)
    expect(names).toContain('urlContext')
    expect(names).toContain('knowledge-orchestration')
    expect(names).not.toContain('webSearch')
    expect(names).not.toContain('search-orchestration')
    expect(names.join(',')).not.toMatch(/mcp/i)
  })

  it('knowledge orchestration exposes only the knowledge tool (no websearch/memory)', async () => {
    const { knowledgeOrchestrationPlugin } = await import('@renderer/aiCore/plugins/knowledgeOrchestrationPlugin')
    const assistant = makeAssistant({
      knowledge_bases: [{ id: 'kb1' } as never],
      knowledgeRecognition: 'on'
    })
    const plugin = knowledgeOrchestrationPlugin(assistant, 'topic-1')
    expect(plugin.name).toBe('knowledge-orchestration')
    // transformParams must not reference removed tool names.
    const source = knowledgeOrchestrationPlugin.toString()
    expect(source).not.toMatch(/webSearch|memorySearch|builtin_memory_search/i)
  })
})
