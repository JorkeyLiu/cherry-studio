import type { WebSearchToolConfigMap } from '../../../providers'

/**
 * 插件初始化时接收的完整配置对象
 *
 * key = provider ID，value = 该 provider 的搜索配置
 *
 * 所有 key 从 coreExtensions 的 toolFactories 声明中自动提取
 * （WebSearchToolConfigMap）——仅限已批准的活动协议。
 */
export type WebSearchPluginConfig = WebSearchToolConfigMap
