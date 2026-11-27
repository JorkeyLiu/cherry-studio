import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { isEmbeddingModel, isRerankModel } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useProviders } from '@renderer/hooks/useProvider'
import ToolPopover from '@renderer/pages/home/Inputbar/components/ToolPopover'
import { getModelUniqId } from '@renderer/services/ModelService'
import type { Assistant, Model } from '@renderer/types'
import { getFancyProviderName } from '@renderer/utils'
import { sortBy } from 'lodash'
import { ChevronDown, Plus } from 'lucide-react'
import type { FC } from 'react'
import { Fragment, memo, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import styled from 'styled-components'

interface Props {
  assistant: Assistant
}

/**
 * Inputbar single-model selector: a compact trigger (current model/provider
 * icon + current model name + chevron) on the independent model row,
 * opening the same lightweight, provider-grouped Popover list as the
 * former @ entry (downwards, the row sits at the composer top). A click
 * selects exactly one current model (persisted on the assistant) and
 * closes the popover. No multi-select, no clear-all, no mention state.
 */
const MentionModelsButton: FC<Props> = ({ assistant }) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { providers } = useProviders()
  const { updateAssistant } = useAssistant(assistant.id)
  const [open, setOpen] = useState(false)

  const currentModelId = assistant.model ? getModelUniqId(assistant.model) : null
  const currentProvider = useMemo(
    () =>
      (currentModelId
        ? providers.find((p) => p.models.some((m) => getModelUniqId(m) === currentModelId))
        : undefined) ?? null,
    [providers, currentModelId]
  )
  const placeholder = t('assistants.presets.edit.model.select.title')

  const onSelectModel = useCallback(
    (model: Model) => {
      updateAssistant({ model })
      setOpen(false)
    },
    [updateAssistant]
  )

  const content = useMemo(() => {
    return (
      <div data-testid="mention-models-popover">
        <PopoverHeaderRow>
          <span>{t('assistants.presets.edit.model.select.title')}</span>
        </PopoverHeaderRow>
        <List data-testid="mention-model-list">
          {providers.map((provider) => {
            const providerModels = sortBy(
              provider.models.filter((model) => !isEmbeddingModel(model) && !isRerankModel(model)),
              ['group', 'name']
            )
            // 空的服务商不产生分组标题
            if (providerModels.length === 0) return null
            const fancyProviderName = getFancyProviderName(provider)
            return (
              <Fragment key={provider.id}>
                <ProviderGroupHeader data-testid={`mention-provider-group-${provider.id}`}>
                  {fancyProviderName}
                </ProviderGroupHeader>
                {providerModels.map((model) => {
                  const isSelected = currentModelId === getModelUniqId(model)
                  return (
                    <ListItem
                      key={getModelUniqId(model)}
                      $selected={isSelected}
                      onClick={() => onSelectModel(model)}
                      data-testid={`mention-model-${model.id}`}
                      data-provider-id={provider.id}
                      data-selected={isSelected}>
                      <Left>
                        <ModelAvatar model={model} provider={provider} size={20} />
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <Label className="min-w-0 truncate">{model.name}</Label>
                          {/* 两行结构：模型名在上，弱化的 model ID 常驻第二行（含完整 ID tooltip） */}
                          <div
                            className="min-w-0 truncate font-mono text-[12px] text-[var(--color-text-3)] leading-[1.2]"
                            title={model.id}>
                            {model.id}
                          </div>
                        </div>
                      </Left>
                      {isSelected && <CheckMark>✓</CheckMark>}
                    </ListItem>
                  )
                })}
              </Fragment>
            )
          })}
          <ListItem
            onClick={() => {
              navigate('/settings/provider')
              setOpen(false)
            }}
            data-testid="mention-add-model">
            <Left>
              <Plus size={16} />
              <Label>{t('settings.models.add.add_model')}...</Label>
            </Left>
          </ListItem>
        </List>
      </div>
    )
  }, [t, providers, currentModelId, onSelectModel, navigate])

  return (
    <ToolPopover open={open} onOpenChange={setOpen} content={content} width={320} placement="bottom">
      <ModelButton
        type="button"
        data-testid="mention-models-button"
        aria-label={placeholder}
        onClick={() => setOpen((v) => !v)}>
        {assistant.model && <ModelAvatar model={assistant.model} provider={currentProvider} size={16} />}
        <ModelName className="truncate">{assistant.model?.name ?? placeholder}</ModelName>
        <ChevronDown size={14} />
      </ModelButton>
    </ToolPopover>
  )
}

/**
 * 紧凑模型触发按钮：聊天客户端常见的“图标 + 当前模型名 + 下拉箭头”
 * 形态。文字 13px/半粗、最大约 190px 省略；容器自适应宽度（ToolPopover
 * 的 Trigger 已放宽为 min 28px），方形工具按钮不受影响。
 */
const ModelButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  color: var(--color-text);
  &:hover {
    background: var(--color-background-soft);
  }
`

const ModelName = styled.span`
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const CheckMark = styled.span`
  font-size: 14px;
`

/**
 * 标题行：左侧为弹层标题。单选语义下没有清除操作，标题独占头部。
 * 沿用应用内其他输入栏弹层的标题行样式（13px、半粗、底部间距）。
 */
const PopoverHeaderRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
`

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 300px;
  overflow-y: auto;
`

const ListItem = styled.div<{ $selected?: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  background: ${(p) => (p.$selected ? 'var(--color-background-soft)' : 'transparent')};
  &:hover {
    background: var(--color-background-soft);
  }
`

/**
 * 服务商分组标题：沿用应用内既有的 provider 分组样式（小字号、弱化色、不可选中）。
 */
const ProviderGroupHeader = styled.div`
  min-width: 0;
  padding: 6px 8px 2px;
  font-size: 12px;
  line-height: 1.2;
  color: var(--color-text-3);
  user-select: none;
  pointer-events: none;
`

const Left = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`

const Label = styled.div`
  font-size: 13px;
`

export default memo(MentionModelsButton)
