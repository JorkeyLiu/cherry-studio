import type { ProviderV3 } from '@ai-sdk/provider'

/**
 * 跨 provider 的工具能力标识
 *
 * 仅保留网页上下文（urlContext）作为供应商原生工具能力：
 * Anthropic 经 webFetch_20260209、Google 经 urlContext 表达同一能力。
 * 原生网络搜索（webSearch）已完整移除，不再作为能力键。
 * fileSearch / codeExecution 为 SDK 透传兼容键（无原生执行工厂），
 * 通用函数工具经 ToolSet / providerToolPlugin 通道执行，不经此处。
 */
export type ToolCapability = 'fileSearch' | 'codeExecution' | 'urlContext'

/**
 * 工具工厂返回的 patch，描述要合并到 params 的修改。
 *
 * `tools` 使用 `Record<string, any>` 而非 `ToolSet`：各 provider SDK（例如 Anthropic
 * 的 `webFetch_20260209` 与 Google 的 `urlContext`）返回的
 * `Tool<INPUT, OUTPUT>` 在最新泛型下不再能收敛到 `ToolSet` 的
 * `Tool<any,any>|Tool<any,never>|Tool<never,any>|Tool<never,never>` 交集，
 * 导致 `satisfies ProviderExtensionConfig<...>` 失败。运行时只是浅拷贝进 `params.tools`，形状一致。
 */
export interface ToolFactoryPatch {
  tools?: Record<string, any>
  providerOptions?: Record<string, any>
}

/**
 * 工具工厂函数 — 形状约束
 *
 * 使用 `...args: any[]` 而非 `config: Record<string, any>`，
 * 这样 `as const satisfies` 不会擦除声明时的具体 config 类型。
 * `ExtractToolConfig` 可从声明中提取具体 config 类型。
 */
export type ToolFactory<TProvider extends ProviderV3 = ProviderV3> = (
  provider: TProvider
) => (...args: any[]) => ToolFactoryPatch

/** Map of ToolCapability keys to their factory functions. */
export type ToolFactoryMap<TProvider extends ProviderV3 = ProviderV3> = {
  [K in ToolCapability]?: ToolFactory<TProvider>
}
