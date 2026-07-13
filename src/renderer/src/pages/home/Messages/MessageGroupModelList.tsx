import { ArrowsAltOutlined, ShrinkOutlined } from '@ant-design/icons'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { Sortable } from '@renderer/components/dnd'
import { HStack } from '@renderer/components/Layout'
import Scrollbar from '@renderer/components/Scrollbar'
import { useMessageGroupSettings } from '@renderer/hooks/useSettings'
import { useAppDispatch } from '@renderer/store'
import { setFoldDisplayMode } from '@renderer/store/settings'
import type { Model } from '@renderer/types'
import { AssistantMessageStatus, type Message } from '@renderer/types/newMessage'
import { lightbulbSoftVariants } from '@renderer/utils/motionVariants'
import { Tooltip } from 'antd'
import { motion } from 'motion/react'
import type { FC } from 'react'
import { memo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface MessageGroupModelListProps {
  messages: Message[]
  selectMessageId: string
  setSelectedMessage: (message: Message) => void
  onReorderMessages?: (messages: Message[]) => void
}

type DisplayMode = 'compact' | 'expanded'

const MessageGroupModelList: FC<MessageGroupModelListProps> = ({
  messages,
  selectMessageId,
  setSelectedMessage,
  onReorderMessages
}) => {
  const dispatch = useAppDispatch()
  const { t } = useTranslation()
  const { foldDisplayMode } = useMessageGroupSettings()
  const isCompact = foldDisplayMode === 'compact'

  const isMessageProcessing = useCallback((message: Message) => {
    return [
      AssistantMessageStatus.PENDING,
      AssistantMessageStatus.PROCESSING,
      AssistantMessageStatus.SEARCHING
    ].includes(message.status as AssistantMessageStatus)
  }, [])

  const handleSortEnd = useCallback(
    ({ oldIndex, newIndex }: { oldIndex: number; newIndex: number }) => {
      const reorderedMessages = [...messages]
      const [movedMessage] = reorderedMessages.splice(oldIndex, 1)
      reorderedMessages.splice(newIndex, 0, movedMessage)
      onReorderMessages?.(reorderedMessages)
    },
    [messages, onReorderMessages]
  )

  const renderLabel = useCallback(
    (message: Message) => {
      const modelTip = message.model?.name
      const isProcessing = isMessageProcessing(message)

      if (isCompact) {
        return (
          <Tooltip key={message.id} title={modelTip} mouseEnterDelay={0.5} mouseLeaveDelay={0}>
            <AvatarWrapper
              className="avatar-wrapper"
              $isSelected={message.id === selectMessageId}
              onClick={() => {
                setSelectedMessage(message)
              }}>
              <motion.span variants={lightbulbSoftVariants} animate={isProcessing ? 'active' : 'idle'} initial="idle">
                <ModelAvatar model={message.model as Model} size={22} />
              </motion.span>
            </AvatarWrapper>
          </Tooltip>
        )
      }
      return (
        <SegmentedItem
          $isSelected={message.id === selectMessageId}
          onClick={() => {
            setSelectedMessage(message)
          }}>
          <SegmentedLabel>
            <ModelAvatar className={isProcessing ? 'animation-pulse' : ''} model={message.model as Model} size={20} />
            <ModelName>{message.model?.name}</ModelName>
          </SegmentedLabel>
        </SegmentedItem>
      )
    },
    [isCompact, isMessageProcessing, selectMessageId, setSelectedMessage]
  )

  return (
    <Container>
      <Tooltip
        title={
          isCompact
            ? t('message.message.multi_model_style.fold.expand')
            : t('message.message.multi_model_style.fold.compress')
        }
        placement="top"
        mouseEnterDelay={0.5}
        mouseLeaveDelay={0}>
        <DisplayModeToggle
          displayMode={foldDisplayMode}
          onClick={() => dispatch(setFoldDisplayMode(isCompact ? 'expanded' : 'compact'))}>
          {isCompact ? <ArrowsAltOutlined /> : <ShrinkOutlined />}
        </DisplayModeToggle>
      </Tooltip>
      <ModelsContainer $displayMode={foldDisplayMode}>
        <Sortable
          items={messages}
          itemKey="id"
          onSortEnd={handleSortEnd}
          renderItem={(message) => renderLabel(message)}
          horizontal
          useDragOverlay
          className={isCompact ? 'avatar-group ant-avatar-group' : 'segmented-list'}
        />
      </ModelsContainer>
    </Container>
  )
}

const Container = styled(HStack)`
  flex: 1;
  overflow: hidden;
  align-items: center;
  margin-left: 4px;
`

const DisplayModeToggle = styled.div<{ displayMode: DisplayMode }>`
  display: flex;
  cursor: pointer;
  padding: 2px 6px 3px 6px;
  border-radius: 4px;
  width: 26px;
  height: 26px;

  &:hover {
    background-color: var(--color-hover);
  }
`

const ModelsContainer = styled(Scrollbar)<{ $displayMode: DisplayMode }>`
  display: flex;
  flex-direction: ${(props) => (props.$displayMode === 'expanded' ? 'column' : 'row')};
  justify-content: ${(props) => (props.$displayMode === 'expanded' ? 'space-between' : 'flex-start')};
  align-items: center;
  overflow-x: auto;
  flex: 1;
  padding: 0 8px;

  &::-webkit-scrollbar {
    display: none;
  }

  /* Card mode styles */
  .avatar-group.ant-avatar-group {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    padding: 6px 4px;

    /* Base style - default overlapping effect */
    & > * {
      margin-left: -6px !important;
      transition:
        transform 0.18s ease-out,
        margin 0.18s ease-out !important;
      position: relative;
      will-change: transform;
    }

    & > *:first-child {
      margin-left: 0 !important;
    }

    /* Element before the hovered one */
    & > *:has(+ *:hover) {
      margin-right: 2px !important;
      /* Use transform instead of margin to reduce layout recalculations */
      transform: translateX(-2px);
    }

    /* Element after the hovered one */
    & > *:hover + * {
      margin-left: 5px !important;
      /* Avoid transform here to prevent jittering */
    }

    /* Second element after the hovered one */
    & > *:hover + * + * {
      margin-left: -4px !important;
    }
  }

  .segmented-list {
    width: 100%;
    background-color: transparent;
  }
`

const AvatarWrapper = styled.div<{ $isSelected: boolean }>`
  cursor: pointer;
  display: inline-flex;
  border-radius: 50%;
  background: var(--color-background);
  transition:
    transform 0.18s ease-out,
    margin 0.18s ease-out,
    filter 0.18s ease-out;
  z-index: ${(props) => (props.$isSelected ? 1 : 0)};
  border: ${(props) => (props.$isSelected ? '2px solid var(--color-primary)' : 'none')};

  &:hover {
    transform: translateX(6px) scale(1.15);
    filter: brightness(1.02);
    margin-left: 8px !important;
    margin-right: 4px !important;
  }
`

const SegmentedLabel = styled.div`
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 0;
`

const ModelName = styled.span`
  font-weight: 500;
  font-size: 12px;
`

const SegmentedItem = styled.div<{ $isSelected: boolean }>`
  cursor: pointer;
  padding: 0 11px;
  border-radius: var(--list-item-border-radius);
  border: ${({ $isSelected }) => ($isSelected ? '0.5px solid var(--color-border)' : '0.5px solid transparent')};
  background: ${({ $isSelected }) => ($isSelected ? 'var(--color-background)' : 'transparent')};

  &:hover {
    background: ${({ $isSelected }) => ($isSelected ? 'var(--color-background)' : 'var(--color-hover)')};
  }
`

export default memo(MessageGroupModelList)
