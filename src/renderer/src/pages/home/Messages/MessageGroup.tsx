import { loggerService } from '@logger'
import Scrollbar from '@renderer/components/Scrollbar'
import { MessageEditingProvider } from '@renderer/context/MessageEditingContext'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useMessageActionController } from '@renderer/hooks/useMessageActionController'
import { useMessageOperations } from '@renderer/hooks/useMessageOperations'
import { useTimer } from '@renderer/hooks/useTimer'
import { useAppDispatch } from '@renderer/store'
import { reorderMessageGroupThunk } from '@renderer/store/thunk/messageGroupReorder'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { classNames } from '@renderer/utils'
import { scrollIntoView } from '@renderer/utils/dom'
import type { ComponentProps } from 'react'
import { memo, useCallback, useEffect, useMemo } from 'react'
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
  const { selectAnswer } = useMessageActionController()
  const { isMultiSelectMode } = useChatContext(topic)
  const { setTimeoutTimer } = useTimer()
  const dispatch = useAppDispatch()

  const isGrouped = messageLength > 1 && messages.every((m) => m.role === 'assistant')

  // LOCK-105: multi-model answer layout is always fold/tag mode. The runtime
  // no longer renders horizontal/vertical/grid layouts; the per-message
  // `multiModelMessageStyle` field is preserved for Cherry Studio
  // import/schema compatibility only (LOCK-001).
  const multiModelMessageStyle = 'fold'

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
      // S3.4: explicit target IDs resolved at event time to the latest
      // complete answer group. No captured messages array is used so a
      // projection update that expands the group is observed.
      void selectAnswer({ topicId: topic.id, messageId: message.id })

      // LOCK-105/PERF-100: the 200ms setTimeoutTimer smooth-scroll contract
      // is preserved exactly — do not optimize, remove, or retime it.
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
    [selectAnswer, topic.id, setTimeoutTimer]
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

  const renderMessage = useCallback(
    (message: Message & { index: number }) => {
      const messageProps = {
        isGrouped,
        // LOCK-105: horizontal multi-model layout is removed.
        isHorizontalMultiModelLayout: false,
        message,
        topic,
        index: message.index,
        isEditMode,
        onGroupClick
      } satisfies ComponentProps<typeof MessageItem>

      return (
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
    },
    [
      isGrouped,
      topic,
      multiModelMessageStyle,
      messages,
      selectedMessageId,
      onUpdateUseful,
      groupContextMessageId,
      isEditMode,
      onGroupClick
    ]
  )

  return (
    <MessageEditingProvider resetToken={isEditMode}>
      <GroupContainer
        id={groupId ? `message-group-${groupId}` : undefined}
        className={classNames([multiModelMessageStyle])}>
        <GridContainer className={classNames([multiModelMessageStyle, { 'multi-select-mode': isMultiSelectMode }])}>
          {messages.map(renderMessage)}
        </GridContainer>
        {isGrouped && (
          <MessageGroupMenuBar
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
  &.multi-select-mode {
    padding: 5px 10px;
  }
`

const GridContainer = styled(Scrollbar)`
  width: 100%;
  display: grid;
  overflow-y: visible;
  gap: 16px;

  // LOCK-105: fold/tag is the only runtime layout.
  &.fold {
    grid-template-columns: repeat(1, minmax(0, 1fr));
    gap: 8px;
  }

  &.multi-select-mode {
    grid-template-columns: repeat(1, minmax(0, 1fr));
    gap: 10px;
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

// LOCK-105: fold/tag is the only runtime multi-model layout. The horizontal /
// grid / in-popover wrapper styles are removed.
const MessageWrapper = styled.div`
  &.fold {
    display: none;
    &.selected {
      display: inline-block;
    }
  }
`

export default memo(MessageGroup)
