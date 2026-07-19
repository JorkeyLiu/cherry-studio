import { loggerService } from '@logger'
import Scrollbar from '@renderer/components/Scrollbar'
import { MessageEditingProvider } from '@renderer/context/MessageEditingContext'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useMessageOperations } from '@renderer/hooks/useMessageOperations'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTimer } from '@renderer/hooks/useTimer'
import { useAppDispatch } from '@renderer/store'
import type { MultiModelMessageStyle } from '@renderer/store/settings'
import { reorderMessageGroupThunk } from '@renderer/store/thunk/messageGroupReorder'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { classNames } from '@renderer/utils'
import { scrollIntoView } from '@renderer/utils/dom'
import { Popover } from 'antd'
import type { ComponentProps, WheelEvent as ReactWheelEvent } from 'react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import styled from 'styled-components'

import MessageItem from './Message'
import MessageGroupMenuBar from './MessageGroupMenuBar'

const logger = loggerService.withContext('MessageGroup')
interface Props {
  messages: (Message & { index: number })[]
  topic: Topic
  registerMessageElement?: (id: string, element: HTMLElement | null) => void
  isEditMode?: boolean
  onGroupClick?: (askId: string, isCtrl: boolean, isShift: boolean) => void
}

const MessageGroup = ({ messages, topic, registerMessageElement, isEditMode = false, onGroupClick }: Props) => {
  const messageLength = messages.length
  const groupId = messages[0]?.askId || messages[0]?.id

  // Hooks
  const { editMessage } = useMessageOperations(topic)
  const { multiModelMessageStyle: multiModelMessageStyleSetting, gridColumns, gridPopoverTrigger } = useSettings()
  const { isMultiSelectMode } = useChatContext(topic)
  const { setTimeoutTimer } = useTimer()
  const dispatch = useAppDispatch()

  const isGrouped = messageLength > 1 && messages.every((m) => m.role === 'assistant')

  // States
  const [_multiModelMessageStyle, setMultiModelMessageStyle] = useState<MultiModelMessageStyle>(
    messages[0].multiModelMessageStyle || multiModelMessageStyleSetting
  )

  // 对于单模型消息，采用简单的样式，避免 overflow 影响内部的 sticky 效果
  const multiModelMessageStyle = useMemo(
    () => (messageLength < 2 ? 'fold' : _multiModelMessageStyle),
    [_multiModelMessageStyle, messageLength]
  )

  const isGrid = multiModelMessageStyle === 'grid'

  const selectedMessageId = useMemo(() => {
    if (messages.length === 1) return messages[0]?.id
    const selectedMessage = messages.find((message) => message.foldSelected)
    if (selectedMessage) {
      return selectedMessage.id
    }
    return messages[0]?.id
  }, [messages])

  const setSelectedMessage = useCallback(
    (message: Message) => {
      // 前一个
      void editMessage(selectedMessageId, { foldSelected: false })
      // 当前选中的消息
      void editMessage(message.id, { foldSelected: true })

      setTimeoutTimer(
        'setSelectedMessage',
        () => {
          const messageElement = document.getElementById(`message-${message.id}`)
          if (messageElement) {
            scrollIntoView(messageElement, { behavior: 'smooth', block: 'start', container: 'nearest' })
          }
        },
        200
      )
    },
    [editMessage, selectedMessageId, setTimeoutTimer]
  )
  // NOTE: registerMessageElement logic is kept for future use (currently not used for navigation)
  useEffect(() => {
    messages.forEach((message) => {
      const element = document.getElementById(`message-${message.id}`)
      element && registerMessageElement?.(message.id, element)
    })
    return () => messages.forEach((message) => registerMessageElement?.(message.id, null))
  }, [messages, registerMessageElement])

  const onUpdateUseful = useCallback(
    (msgId: string) => {
      const message = messages.find((msg) => msg.id === msgId)
      if (!message) {
        logger.error("the message to update doesn't exist in this group")
        return
      }
      if (message.useful) {
        void editMessage(msgId, { useful: undefined })
        return
      } else {
        const toResetUsefulMsgs = messages.filter((msg) => msg.id !== msgId && msg.useful)
        toResetUsefulMsgs.forEach(async (msg) => {
          void editMessage(msg.id, {
            useful: undefined
          })
        })
        void editMessage(msgId, { useful: true })
      }
    },
    [editMessage, messages]
  )

  const handleReorderMessages = useCallback(
    (reorderedMessages: Message[]) => {
      void dispatch(
        reorderMessageGroupThunk(
          topic.id,
          reorderedMessages.map((message) => message.id)
        )
      )
    },
    [dispatch, topic.id]
  )

  const groupContextMessageId = useMemo(() => {
    // NOTE: 旧数据可能存在一组消息有多个useful的情况，只取第一个，不再另作迁移
    // find first useful
    const usefulMsg = messages.find((msg) => msg.useful)
    if (usefulMsg) {
      return usefulMsg.id
    } else if (messages.length > 0) {
      return messages[0].id
    } else {
      logger.warn('Empty message group')
      return ''
    }
  }, [messages])

  const handleHorizontalGroupWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('.message-content-container')) {
      return
    }

    const groupContainer = event.currentTarget
    const contentContainers = Array.from(groupContainer.querySelectorAll<HTMLElement>('.message-content-container'))
    const hasInnerVerticalScroll = contentContainers.some(
      (contentContainer) => contentContainer.scrollHeight > contentContainer.clientHeight + 1
    )
    const hasHorizontalScroll = groupContainer.scrollWidth > groupContainer.clientWidth + 1
    const horizontalDelta = Math.abs(event.deltaX) > 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0

    if (horizontalDelta !== 0 && hasHorizontalScroll) {
      event.preventDefault()
      event.stopPropagation()
      groupContainer.scrollLeft += horizontalDelta
      return
    }

    if (hasInnerVerticalScroll) {
      event.preventDefault()
      event.stopPropagation()
    }
  }, [])

  const renderMessage = useCallback(
    (message: Message & { index: number }) => {
      const isGridGroupMessage = isGrid && message.role === 'assistant' && isGrouped
      const messageProps = {
        isGrouped,
        isHorizontalMultiModelLayout: multiModelMessageStyle === 'horizontal',
        message,
        topic,
        index: message.index,
        isEditMode,
        onGroupClick
      } satisfies ComponentProps<typeof MessageItem>

      const messageContent = (
        <MessageWrapper
          id={`message-${message.id}`}
          key={message.id}
          className={classNames([
            {
              [multiModelMessageStyle]: message.role === 'assistant' && messages.length > 1,
              selected: message.id === selectedMessageId
            }
          ])}>
          <MessageItem
            onUpdateUseful={onUpdateUseful}
            isGroupContextMessage={isGrouped && message.id === groupContextMessageId}
            {...messageProps}
          />
        </MessageWrapper>
      )

      if (isGridGroupMessage) {
        return (
          <Popover
            key={message.id}
            destroyOnHidden
            content={
              <MessageWrapper
                className={classNames([
                  'in-popover',
                  {
                    [multiModelMessageStyle]: message.role === 'assistant' && messages.length > 1,
                    selected: message.id === selectedMessageId
                  }
                ])}>
                <MessageItem onUpdateUseful={onUpdateUseful} {...messageProps} />
              </MessageWrapper>
            }
            trigger={gridPopoverTrigger}
            styles={{
              root: { maxWidth: '60vw', overflowY: 'auto', zIndex: 1000 },
              body: { padding: 2 }
            }}>
            {messageContent}
          </Popover>
        )
      }

      return messageContent
    },
    [
      isGrid,
      isGrouped,
      topic,
      multiModelMessageStyle,
      messages,
      selectedMessageId,
      onUpdateUseful,
      groupContextMessageId,
      gridPopoverTrigger,
      isEditMode,
      onGroupClick
    ]
  )

  return (
    <MessageEditingProvider>
      <GroupContainer
        id={groupId ? `message-group-${groupId}` : undefined}
        className={classNames([multiModelMessageStyle])}>
        <GridContainer
          $count={messageLength}
          $gridColumns={gridColumns}
          className={classNames([multiModelMessageStyle, { 'multi-select-mode': isMultiSelectMode }])}
          onWheelCapture={multiModelMessageStyle === 'horizontal' ? handleHorizontalGroupWheel : undefined}>
          {messages.map(renderMessage)}
        </GridContainer>
        {isGrouped && (
          <MessageGroupMenuBar
            multiModelMessageStyle={multiModelMessageStyle}
            setMultiModelMessageStyle={(style) => {
              setMultiModelMessageStyle(style)
              messages.forEach((message) => {
                void editMessage(message.id, { multiModelMessageStyle: style })
              })
            }}
            messages={messages}
            selectMessageId={selectedMessageId}
            setSelectedMessage={setSelectedMessage}
            onReorderMessages={handleReorderMessages}
            topic={topic}
          />
        )}
      </GroupContainer>
    </MessageEditingProvider>
  )
}

const GroupContainer = styled.div`
  &.horizontal,
  &.grid {
    padding: 4px 10px;
    .group-menu-bar {
      margin-left: 0;
      margin-right: 0;
    }
  }
  &.multi-select-mode {
    padding: 5px 10px;
  }

`

const GridContainer = styled(Scrollbar)<{ $count: number; $gridColumns: number }>`
  width: 100%;
  display: grid;
  overflow-y: visible;
  gap: 16px;

  &.horizontal {
    padding-bottom: 4px;
    grid-template-columns: repeat(${({ $count }) => $count}, minmax(420px, 1fr));
    overflow-x: auto;
    overflow-y: hidden;
  }
  &.fold,
  &.vertical {
    grid-template-columns: repeat(1, minmax(0, 1fr));
    gap: 8px;
  }
  &.grid {
    grid-template-columns: repeat(
      ${({ $count, $gridColumns }) => ($count > 1 ? $gridColumns || 2 : 1)},
      minmax(0, 1fr)
    );
    grid-template-rows: auto;
  }

  &.multi-select-mode {
    grid-template-columns: repeat(1, minmax(0, 1fr));
    gap: 10px;
    .grid {
      height: auto;
    }
    .message {
      border: 0.5px solid var(--color-border);
      border-radius: 10px;
      padding: 10px;
      .message-content-container {
        max-height: 200px;
        overflow-y: hidden !important;
      }
      .MessageFooter {
        display: none;
      }
    }
  }
`

interface MessageWrapperProps {
  $isInPopover?: boolean
}

const MessageWrapper = styled.div<MessageWrapperProps>`
  &.horizontal {
    padding: 1px;
    overflow-y: visible;
    .message {
      height: 100%;
      border: 0.5px solid var(--color-border);
      border-radius: 10px;
    }
    .message-content-container {
      flex: 1;
      padding-left: 0;
      max-height: calc(100vh - 350px);
      overflow-y: auto !important;
      margin-right: -10px;
    }
    .MessageFooter {
      margin-left: 0;
      margin-top: 2px;
      margin-bottom: 2px;
    }
  }
  &.grid {
    display: block;
    height: 300px;
    overflow-y: hidden;
    border: 0.5px solid var(--color-border);
    border-radius: 10px;
    cursor: pointer;
    .message {
      height: 100%;
    }
    .message-content-container {
      overflow: hidden;
      padding-left: 0;
      flex: 1;
      pointer-events: none;
    }
    .MessageFooter {
      margin-left: 0;
      margin-top: 2px;
      margin-bottom: 2px;
    }
  }
  &.in-popover {
    height: auto;
    border: none;
    max-height: 50vh;
    overflow-y: auto;
    cursor: default;
    .message-content-container {
      padding-left: 0;
      pointer-events: auto;
    }
    .MessageFooter {
      margin-left: 0;
    }
  }
  &.fold {
    display: none;
    &.selected {
      display: inline-block;
    }
  }
`

export default memo(MessageGroup)
