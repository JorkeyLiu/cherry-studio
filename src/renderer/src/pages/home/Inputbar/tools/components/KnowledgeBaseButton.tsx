import { ActionIconButton } from '@renderer/components/Buttons'
import ToolPopover from '@renderer/pages/home/Inputbar/components/ToolPopover'
import { useAppSelector } from '@renderer/store'
import type { KnowledgeBase } from '@renderer/types'
import { Tooltip } from 'antd'
import { Check, CircleX, FileSearch, Plus } from 'lucide-react'
import type { FC } from 'react'
import { memo, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import styled from 'styled-components'

interface Props {
  selectedBases?: KnowledgeBase[]
  onSelect: (bases: KnowledgeBase[]) => void
  disabled?: boolean
}

const KnowledgeBaseButton: FC<Props> = ({ selectedBases, onSelect, disabled }) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const knowledgeState = useAppSelector((state) => state.knowledge)
  const [open, setOpen] = useState(false)

  const handleBaseSelect = useCallback(
    (base: KnowledgeBase) => {
      const current = selectedBases ?? []
      if (current.some((selected) => selected.id === base.id)) {
        onSelect(current.filter((selected) => selected.id !== base.id))
      } else {
        onSelect([...current, base])
      }
    },
    [onSelect, selectedBases]
  )

  const handleClearAll = useCallback(() => {
    onSelect([])
    setOpen(false)
  }, [onSelect])

  const content = useMemo(() => {
    return (
      <div>
        <PopoverTitle>{t('chat.input.knowledge_base')}</PopoverTitle>
        <List>
          <ListItem onClick={handleClearAll} data-testid="kb-clear-all">
            <Left>
              <CircleX size={16} />
              <div>
                <Label>{t('settings.input.clear.all')}</Label>
                <Desc>{t('settings.input.clear.knowledge_base')}</Desc>
              </div>
            </Left>
          </ListItem>
          {knowledgeState.bases.map((base) => {
            const isSelected = selectedBases?.some((selected) => selected.id === base.id) ?? false
            return (
              <ListItem
                key={base.id}
                $selected={isSelected}
                onClick={() => handleBaseSelect(base)}
                data-testid={`kb-option-${base.id}`}
                data-selected={isSelected}>
                <Left>
                  <FileSearch size={16} />
                  <div>
                    <Label>{base.name}</Label>
                    <Desc>
                      {base.items.length} {t('files.count')}
                    </Desc>
                  </div>
                </Left>
                {isSelected && <Check size={14} />}
              </ListItem>
            )
          })}
          <ListItem
            onClick={() => {
              navigate('/knowledge')
              setOpen(false)
            }}
            data-testid="kb-add">
            <Left>
              <Plus size={16} />
              <Label>{t('knowledge.add.title')}...</Label>
            </Left>
          </ListItem>
        </List>
      </div>
    )
  }, [t, knowledgeState.bases, selectedBases, handleBaseSelect, handleClearAll, navigate])

  const active = selectedBases && selectedBases.length > 0

  return (
    <ToolPopover open={open} onOpenChange={setOpen} content={content}>
      <Tooltip
        placement="top"
        title={t('chat.input.knowledge_base')}
        mouseLeaveDelay={0}
        arrow
        open={open ? false : undefined}>
        <ActionIconButton active={!!active} disabled={disabled} aria-label={t('chat.input.knowledge_base')}>
          <FileSearch size={18} />
        </ActionIconButton>
      </Tooltip>
    </ToolPopover>
  )
}

const PopoverTitle = styled.div`
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
`

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 260px;
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

export default memo(KnowledgeBaseButton)
