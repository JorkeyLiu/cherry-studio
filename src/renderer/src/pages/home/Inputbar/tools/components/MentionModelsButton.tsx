import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { ActionIconButton } from '@renderer/components/Buttons'
import ModelTagsWithLabel from '@renderer/components/ModelTagsWithLabel'
import { isEmbeddingModel, isRerankModel } from '@renderer/config/models'
import { useProviders } from '@renderer/hooks/useProvider'
import ToolPopover from '@renderer/pages/home/Inputbar/components/ToolPopover'
import { getModelUniqId } from '@renderer/services/ModelService'
import type { FileMetadata, Model } from '@renderer/types'
import { getFancyProviderName } from '@renderer/utils'
import { Tooltip } from 'antd'
import { sortBy } from 'lodash'
import { AtSign, CircleX, Plus } from 'lucide-react'
import type { FC } from 'react'
import { memo, useCallback, useMemo, useState } from 'react'
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

  const onClearMentionModels = useCallback(() => {
    setMentionedModels([])
    setOpen(false)
  }, [setMentionedModels])

  const content = useMemo(() => {
    return (
      <div data-testid="mention-models-popover">
        <PopoverTitle>{t('assistants.presets.edit.model.select.title')}</PopoverTitle>
        <List>
          <ListItem onClick={onClearMentionModels} data-testid="mention-clear-all">
            <Left>
              <CircleX size={16} />
              <Label>{t('settings.input.clear.all')}</Label>
            </Left>
            <Desc>{t('settings.input.clear.models')}</Desc>
          </ListItem>
          {providers.flatMap((provider) => {
            const providerModels = sortBy(
              provider.models.filter((model) => !isEmbeddingModel(model) && !isRerankModel(model)),
              ['group', 'name']
            )
            return providerModels.map((model) => {
              const isSelected = mentionedModels.some((selected) => getModelUniqId(selected) === getModelUniqId(model))
              return (
                <ListItem
                  key={getModelUniqId(model)}
                  $selected={isSelected}
                  onClick={() => onMentionModel(model)}
                  data-testid={`mention-model-${model.id}`}
                  data-selected={isSelected}>
                  <Left>
                    <ModelAvatar model={model} provider={provider} size={20} />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <Label className="flex min-w-0 items-center gap-1">
                        <span className="shrink-0">{getFancyProviderName(provider)} |</span>
                        <span className="min-w-0 truncate">{model.name}</span>
                      </Label>
                      <ModelTagsWithLabel model={model} provider={provider} size={10} style={{ opacity: 0.8 }} />
                    </div>
                  </Left>
                  {isSelected && <CheckMark>✓</CheckMark>}
                </ListItem>
              )
            })
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
        <ActionIconButton
          data-testid="mention-models-button"
          active={mentionedModels.length > 0}
          aria-label={t('assistants.presets.edit.model.select.title')}>
          <AtSign size={18} />
        </ActionIconButton>
      </Tooltip>
    </ToolPopover>
  )
}

const CheckMark = styled.span`
  font-size: 14px;
`

const PopoverTitle = styled.div`
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

const Left = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const Label = styled.div`
  font-size: 13px;
`

const Desc = styled.div`
  font-size: 11px;
  color: var(--color-text-3);
`

export default memo(MentionModelsButton)
