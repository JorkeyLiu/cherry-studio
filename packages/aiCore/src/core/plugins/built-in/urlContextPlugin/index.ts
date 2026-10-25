import type { UrlContextToolConfigMap } from '../../../providers'

/**
 * 插件初始化时接收的完整配置对象
 *
 * key = provider ID，value = 该 provider 的网页上下文配置
 *
 * 所有 key 从 coreExtensions 的 toolFactories 声明中自动提取
 * （UrlContextToolConfigMap）——仅保留 Anthropic webFetch 与 Google urlContext。
 */
export type UrlContextPluginConfig = UrlContextToolConfigMap
