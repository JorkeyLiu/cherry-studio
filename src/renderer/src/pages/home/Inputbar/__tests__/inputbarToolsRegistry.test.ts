import '@renderer/pages/home/Inputbar/tools'

import { getAllTools, getToolsForScope } from '@renderer/pages/home/Inputbar/types'
import type { Assistant, Model } from '@renderer/types'
import { TopicType } from '@renderer/types'
import { describe, expect, it } from 'vitest'

const assistant = { id: 'assistant-1' } as unknown as Assistant

describe('Inputbar tool registry', () => {
  it('retains ordinary Chat tools: attachment, thinking, mention_models, mcp_tools', () => {
    const keys = getAllTools().map((tool) => tool.key)
    expect(keys).toContain('attachment')
    expect(keys).toContain('thinking')
    expect(keys).toContain('new_topic')
    expect(keys).toContain('mention_models')
    expect(keys).toContain('mcp_tools')
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
})
