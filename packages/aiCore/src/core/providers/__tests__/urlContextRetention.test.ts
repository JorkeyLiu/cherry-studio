/**
 * 网页上下文保留与原生搜索移除的针对性证明
 *
 * - Google / Anthropic 的 urlContext 工厂在注册表真实存在
 * - 原生 webSearch 在全部核心 provider（含 openai-chat 变体）不再支持
 * - 普通函数工具（知识库类）经通用 ToolExecutor 可执行
 */
import '../core/initialization'

import { createMockProviderV3, createMockTool } from '@test-utils'
import { describe, expect, it, vi } from 'vitest'

import { ToolExecutor } from '../../plugins/built-in/toolUsePlugin/ToolExecutor'
import { extensionRegistry } from '../core/ExtensionRegistry'
import { ExtensionRegistry } from '../core/ExtensionRegistry'
import { ProviderExtension } from '../core/ProviderExtension'

describe('urlContext retention (core registry)', () => {
  it('anthropic 保留 urlContext 工厂（webFetch_20260209 通道）', () => {
    const factory = extensionRegistry.getToolFactory('anthropic', 'urlContext')
    expect(factory).toBeDefined()
  })

  it('google 保留 urlContext 工厂', () => {
    const factory = extensionRegistry.getToolFactory('google', 'urlContext')
    expect(factory).toBeDefined()
  })

  it('urlContext 工厂产物键为 urlContext 而非 webSearch', async () => {
    const mockTool = { type: 'provider-defined' }
    const mockProvider = {
      ...createMockProviderV3(),
      tools: { urlContext: vi.fn().mockReturnValue(mockTool) }
    }
    const registry = new ExtensionRegistry()
    registry.register(
      new ProviderExtension({
        name: 'mock-url',
        create: () => mockProvider as any,
        toolFactories: {
          urlContext: (provider: any) => () => ({
            tools: { urlContext: provider.tools.urlContext({}) }
          })
        }
      })
    )
    const resolved = await registry.resolveToolCapability('mock-url', 'urlContext')
    expect(resolved).toBeDefined()
    const patch = resolved!.factory(resolved!.provider)({})
    expect(patch.tools).toHaveProperty('urlContext')
    expect(patch.tools).not.toHaveProperty('webSearch')
  })
})

describe('native webSearch removal (core registry)', () => {
  it.each(['anthropic', 'google', 'openai', 'openai-chat'])('%s 不再支持 webSearch', (providerId) => {
    expect(extensionRegistry.getToolFactory(providerId, 'webSearch' as any)).toBeUndefined()
  })

  it('resolveToolCapability 对 webSearch 返回 undefined', async () => {
    await expect(extensionRegistry.resolveToolCapability('anthropic', 'webSearch' as any)).resolves.toBeUndefined()
    await expect(extensionRegistry.resolveToolCapability('openai-chat', 'webSearch' as any)).resolves.toBeUndefined()
  })
})

describe('generic tool execution retained', () => {
  it('普通函数工具（知识库类）可经 ToolExecutor 执行', async () => {
    const executor = new ToolExecutor()
    const knowledgeTool = createMockTool('knowledge_lookup', 'Knowledge base lookup')
    const controller = { enqueue: vi.fn() }
    const results = await executor.executeTools(
      [{ id: 'call-1', toolName: 'knowledge_lookup', arguments: { value: 'q' }, status: 'pending' }],
      { knowledge_lookup: knowledgeTool },
      controller as any
    )
    expect(results).toHaveLength(1)
    expect(results[0].isError).toBe(false)
    expect(results[0].result).toBe('mock result')
  })
})
