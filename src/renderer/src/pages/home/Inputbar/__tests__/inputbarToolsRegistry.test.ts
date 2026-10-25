import '@renderer/pages/home/Inputbar/tools'

import { getAllTools, getToolsForScope } from '@renderer/pages/home/Inputbar/types'
import type { Assistant, Model } from '@renderer/types'
import { TopicType } from '@renderer/types'
import { asConfiguredServingModel } from '@renderer/utils/effectiveModel'
import { describe, expect, it } from 'vitest'

const assistant = { id: 'assistant-1' } as unknown as Assistant

describe('Inputbar tool registry', () => {
  it('retains ordinary Chat tools: attachment thinking mention_models url_context knowledge generate_image', () => {
    const keys = getAllTools().map((tool) => tool.key)
    expect(keys).toContain('attachment')
    expect(keys).toContain('thinking')
    expect(keys).toContain('new_topic')
    expect(keys).toContain('mention_models')
    expect(keys).toContain('url_context')
    expect(keys).toContain('knowledge_base')
    expect(keys).toContain('generate_image')
    // Removed capabilities never re-enter the registry: web_search + mcp_tools
    // were deleted Inputbar tools; memory never had an Inputbar key (guard only).
    for (const removed of ['web_search', 'mcp_tools', 'memory_search']) {
      expect(keys).not.toContain(removed)
    }
  })

  it('registers no retired inputbar tools (clear_topic, new_context, toggle_expand)', () => {
    const keys = getAllTools().map((tool) => tool.key)
    for (const retired of ['clear_topic', 'new_context', 'toggle_expand']) {
      expect(keys).not.toContain(retired)
    }
  })

  it('registers no Agent Session tools', () => {
    const keys = getAllTools().map((tool) => tool.key)
    for (const sessionTool of [
      'slash_commands',
      'resource_panel',
      'create_session',
      'activity_directory',
      'permission_mode'
    ]) {
      expect(keys).not.toContain(sessionTool)
    }
  })

  it('returns attachment and thinking for the ordinary Chat scope', () => {
    // o3-mini matches the reasoning-model regex used by the thinking tool condition.
    const reasoningModel = { id: 'o3-mini', name: 'o3 Mini', provider: 'openai' } as Model
    const chatTools = getToolsForScope(TopicType.Chat, { assistant, model: reasoningModel })
    const keys = chatTools.map((tool) => tool.key)
    expect(keys).toContain('attachment')
    expect(keys).toContain('thinking')
  })

  it('does not return Agent Session tools for the ordinary Chat scope', () => {
    const chatTools = getToolsForScope(TopicType.Chat, { assistant })
    const keys = chatTools.map((tool) => tool.key)
    expect(keys).not.toContain('slash_commands')
    expect(keys).not.toContain('resource_panel')
  })

  it('malformed persisted selection resolves to unconfigured so the Chat/Inputbar tool pipeline does not crash', () => {
    // Realistic persisted shapes: optional model objects copied without id validation.
    const malformedPersisted: unknown[] = [
      {},
      { id: undefined, provider: 'openai' },
      { id: '', provider: 'openai' },
      { id: 'm1', provider: '' },
      { id: 123, provider: 'openai' }
    ]
    for (const persisted of malformedPersisted) {
      // Same resolver the effective-model pipeline uses: pick-then-normalize.
      const model = asConfiguredServingModel(persisted)
      expect(model).toBeUndefined()
      expect(() => getToolsForScope(TopicType.Chat, { assistant, model })).not.toThrow()
      const keys = getToolsForScope(TopicType.Chat, { assistant, model }).map((tool) => tool.key)
      expect(keys).not.toContain('thinking')
    }
  })

  it('valid serving selections keep reasoning/vision tool behavior unchanged', () => {
    const reasoningModel = { id: 'o3-mini', name: 'o3 Mini', provider: 'openai' } as Model
    expect(asConfiguredServingModel(reasoningModel)).toBe(reasoningModel)
    const withReasoning = getToolsForScope(TopicType.Chat, {
      assistant,
      model: asConfiguredServingModel(reasoningModel)
    }).map((tool) => tool.key)
    expect(withReasoning).toContain('thinking')

    // Arbitrary valid IDs with missing display/group metadata stay accepted (no metadata gating).
    const minimal = { id: 'custom-valid-id', provider: 'custom-conn' } as unknown as Model
    expect(asConfiguredServingModel(minimal)).toBe(minimal)
    expect(() =>
      getToolsForScope(TopicType.Chat, { assistant, model: asConfiguredServingModel(minimal) })
    ).not.toThrow()
  })
})
