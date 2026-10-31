import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import ModelNameWithId from '@renderer/components/ModelNameWithId'
import { getModelUniqId } from '@renderer/services/ModelService'
import type { Model, Provider } from '@renderer/types'
import { matchKeywordsInString } from '@renderer/utils'
import { getFancyProviderName } from '@renderer/utils/naming'
import type { SelectProps } from 'antd'
import { Avatar, Select } from 'antd'
import { sortBy } from 'lodash'
import type { BaseSelectRef } from 'rc-select'
import { memo, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

interface ModelOption {
  label: React.ReactNode
  title: string
  value: string
  /** Explicit search keywords decoupled from visible title: display name + exact id + provider name/id */
  keywords: string
}

interface GroupedModelOption {
  label: string
  title: string
  options: ModelOption[]
}

type SelectOption = ModelOption | GroupedModelOption

interface ModelSelectorProps extends SelectProps {
  providers?: Provider[]
  predicate?: (model: Model) => boolean
  grouped?: boolean
  showAvatar?: boolean
  showSuffix?: boolean
}

/**
 * 模型选择器，封装了 antd Select
 * - 通过传入模型服务商列表和模型 predicate 来构造选项
 * - 支持按服务商分组
 * - 可以控制 avatar 和 suffix 显示与否（分组模式下 suffix 省略，因为分组标题已经表明服务商）
 * - 选项与已选字段统一展示 model name + 弱化的 model ID
 * @param providers 服务商列表
 * @param predicate 模型过滤条件
 * @param grouped 是否按服务商分组
 * @param showAvatar 是否显示模型图标
 * @param showSuffix 是否在模型名称后显示服务商作为后缀
 */
const ModelSelector = ({
  providers,
  predicate,
  grouped = true,
  showAvatar = true,
  showSuffix = true,
  ref,
  ...props
}: ModelSelectorProps & { ref?: React.Ref<BaseSelectRef> | null }) => {
  const { t } = useTranslation()

  // Provider suffix is only meaningful when options are not already grouped by
  // provider: in grouped mode the group heading carries the provider, so the
  // per-option suffix would be redundant. Ungrouped callers keep it.
  const showProviderSuffix = showSuffix && !grouped

  // 单个 provider 的模型选项 — display name + muted monospace ID via the shared
  // ModelNameWithId primitive (the ID is omitted when it equals the name, same
  // house rule as the provider model settings list).
  // Search is decoupled via explicit keywords containing display name + exact id + provider name/id.
  const getModelOptions = useCallback(
    (p: Provider, fancyName: string) => {
      const suffix = showProviderSuffix ? <span style={{ opacity: 0.45 }}>{` | ${fancyName}`}</span> : null
      return sortBy(p.models, 'name')
        .filter((model) => predicate?.(model) ?? true)
        .map((m) => {
          const keywords = `${m.name} ${m.id} ${p.name} ${p.id} ${fancyName}`
          return {
            label: (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {showAvatar && <ModelAvatar model={m} size={18} />}
                {/* The name+ID group takes all the width the avatar leaves; inside it the
                    name keeps its intrinsic width and the ID absorbs what remains, so an ID
                    that fits is never shortened (full ID stays available as its tooltip). */}
                <span style={{ display: 'flex', flex: '1 1 auto', minWidth: 0, alignItems: 'center' }}>
                  <ModelNameWithId
                    model={m}
                    className="flex min-w-0 flex-1 items-center gap-1.5"
                    nameClassName="min-w-0 max-w-full shrink-0 truncate"
                    idClassName="min-w-0 shrink truncate font-mono text-[12px] leading-[1.2] text-[var(--color-text-3)]"
                  />
                  {suffix}
                </span>
              </div>
            ),
            title: showProviderSuffix ? `${m.name} | ${fancyName}` : m.name,
            value: getModelUniqId(m),
            keywords
          }
        })
    },
    [predicate, showAvatar, showProviderSuffix]
  )

  // 所有 provider 的模型选项
  const options = useMemo((): SelectOption[] => {
    if (!providers) return []

    if (grouped) {
      return providers.flatMap((p) => {
        const fancyName = getFancyProviderName(p)
        const modelOptions = getModelOptions(p, fancyName)
        return modelOptions.length > 0
          ? [
              {
                label: fancyName,
                title: p.name,
                options: modelOptions
              } as GroupedModelOption
            ]
          : []
      })
    }
    return providers.flatMap((p) => getModelOptions(p, getFancyProviderName(p)))
  }, [providers, grouped, getModelOptions])

  const labelRender = useCallback(
    (props) => {
      const { label } = props
      if (label) {
        return label
      } else {
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {showAvatar && <Avatar size={18} />}
            <span>{t('knowledge.error.model_invalid')}</span>
          </div>
        )
      }
    },
    [showAvatar, t]
  )

  return (
    <Select
      ref={ref}
      options={options}
      filterOption={modelSelectFilter}
      labelRender={labelRender}
      showSearch
      {...props}
    />
  )
}

export default memo(ModelSelector)

/**
 * 用于 antd Select 组件的 filterOption，统一搜索行为：
 * - 优先使用显式 keywords（display name + exact id + provider name/id）
 * - 其次使用 title
 * - 最后使用 value
 * Visible title is name-only; search remains ID-aware via keywords.
 *
 * @param input 用户输入的搜索字符串
 * @param option Select 选项对象，包含 keywords/title/value
 * @returns 是否匹配
 */
export function modelSelectFilter(input: string, option: any): boolean {
  const keywords = typeof option?.keywords === 'string' ? option.keywords : undefined
  if (keywords !== undefined) {
    return matchKeywordsInString(input, keywords)
  }
  const target =
    typeof option?.title === 'string'
      ? option.title
      : typeof option?.label === 'string'
        ? option.label
        : typeof option?.value === 'string'
          ? option.value
          : ''
  return matchKeywordsInString(input, target)
}
