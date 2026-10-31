import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { ComposerIconButton } from '@renderer/components/Buttons'
import { isEmbeddingModel, isRerankModel } from '@renderer/config/models'
import { useProviders } from '@renderer/hooks/useProvider'
import ToolPopover from '@renderer/pages/home/Inputbar/components/ToolPopover'
import { getModelUniqId } from '@renderer/services/ModelService'
import type { FileMetadata, Model } from '@renderer/types'
import { getFancyProviderName } from '@renderer/utils'
import { Tooltip } from 'antd'
import { sortBy } from 'lodash'
import { AtSign, Plus } from 'lucide-react'
import type { FC } from 'react'
import { Fragment, memo, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import styled from 'styled-components'

interface Props {
  mentionedModels: Model[]
  setMentionedModels: React.Dispatch<React.SetStateAction<Model[]>>
  files: FileMetadata[]
  setText: React.Dispatch<React.SetStateAction<string>>
}

const MentionModelsButton: FC<Props> = ({ mentionedModels, setMentionedModels }) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { providers } = useProviders()
  const [open, setOpen] = useState(false)

  const onMentionModel = useCallback(
    (model: Model) => {
      setMentionedModels((prev) => {
        const modelId = getModelUniqId(model)
        const exists = prev.some((m) => getModelUniqId(m) === modelId)
        return exists ? prev.filter((m) => getModelUniqId(m) !== modelId) : [...prev, model]
      })
    },
    [setMentionedModels]
  )

  /**
   * 清空已提及模型：只作用于 @ 模型选择，不影响会话默认模型；
   * 保留弹层打开状态，便于清空后继续选择。
   */
  const onClearMentionModels = useCallback(() => {
    setMentionedModels([])
  }, [setMentionedModels])

  const content = useMemo(() => {
    return (
      <div data-testid="mention-models-popover">
        <PopoverHeaderRow>
          <span>{t('assistants.presets.edit.model.select.title')}</span>
          {/* 清空操作位于标题行右侧、可滚动列表之外，且仅在有选中模型时出现 */}
          {mentionedModels.length > 0 && (
            <Tooltip title={t('settings.input.clear.models')} mouseLeaveDelay={0}>
              <ClearButton
                type="button"
                aria-label={t('settings.input.clear.models')}
                data-testid="mention-clear-all"
                onClick={(e) => {
                  e.stopPropagation()
                  onClearMentionModels()
                }}
                onMouseDown={(e) => e.stopPropagation()}>
                {t('settings.input.clear.all')}
              </ClearButton>
            </Tooltip>
          )}
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
                  const isSelected = mentionedModels.some(
                    (selected) => getModelUniqId(selected) === getModelUniqId(model)
                  )
                  return (
                    <ListItem
                      key={getModelUniqId(model)}
                      $selected={isSelected}
                      onClick={() => onMentionModel(model)}
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
  }, [t, providers, mentionedModels, onMentionModel, onClearMentionModels, navigate])

  return (
    <ToolPopover open={open} onOpenChange={setOpen} content={content} width={320}>
      <Tooltip
        placement="top"
        title={t('assistants.presets.edit.model.select.title')}
        mouseLeaveDelay={0}
        arrow
        open={open ? false : undefined}>
        <ComposerIconButton
          data-testid="mention-models-button"
          active={mentionedModels.length > 0}
          aria-label={t('assistants.presets.edit.model.select.title')}>
          <AtSign size={16} />
        </ComposerIconButton>
      </Tooltip>
    </ToolPopover>
  )
}

const CheckMark = styled.span`
  font-size: 14px;
`

/**
 * 标题行：左侧为弹层标题，右侧承载清空操作；两者都在可滚动列表之外。
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

/**
 * 清空按钮：中性的文字按钮，非破坏性样式，参与键盘焦点链（原生 button）。
 */
const ClearButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--color-text-3);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.2;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  &:hover {
    background: var(--color-background-soft);
    color: var(--color-text-1);
  }
  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
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
