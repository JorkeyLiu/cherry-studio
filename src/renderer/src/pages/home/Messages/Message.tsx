import HorizontalScrollContainer from '@renderer/components/HorizontalScrollContainer'
import Scrollbar from '@renderer/components/Scrollbar'
import { useOptionalEditMode } from '@renderer/context/EditModeContext'
import { useMessageEditing } from '@renderer/context/MessageEditingContext'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useMessageOperations } from '@renderer/hooks/useMessageOperations'
import { useModel } from '@renderer/hooks/useModel'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTimer } from '@renderer/hooks/useTimer'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { getMessageModelId } from '@renderer/services/MessagesService'
import { getModelUniqId } from '@renderer/services/ModelService'
import type { Assistant, Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { classNames, cn } from '@renderer/utils'
import { scrollIntoView } from '@renderer/utils/dom'
import { isMessageProcessing } from '@renderer/utils/messageUtils/is'
import { estimateMessageBlocksUsage } from '@renderer/utils/messageUtils/usage'
import type { Dispatch, FC, SetStateAction } from 'react'
import React, { memo, useCallback, useEffect, useRef } from 'react'
import styled from 'styled-components'

import MessageContent from './MessageContent'
import MessageEditor from './MessageEditor'
import MessageErrorBoundary from './MessageErrorBoundary'
import MessageHeader from './MessageHeader'
import MessageMenubar from './MessageMenubar'
import MessageOutline from './MessageOutline'

interface Props {
  message: Message
  topic: Topic
  assistant?: Assistant
  index?: number
  total?: number
  hideMenuBar?: boolean
  style?: React.CSSProperties
  isGrouped?: boolean
  isStreaming?: boolean
  onSetMessages?: Dispatch<SetStateAction<Message[]>>
  onUpdateUseful?: (msgId: string) => void
  isGroupContextMessage?: boolean
  isHorizontalMultiModelLayout?: boolean
  isEditMode?: boolean
  onGroupClick?: (askId: string, isCtrl: boolean, isShift: boolean) => void
}

/** Module-level stable reference — avoids creating a new [] on every render when editMode is null. */
const EMPTY_SELECTED_GROUP_IDS: readonly string[] = []

const WrapperContainer = ({
  isMultiSelectMode,
  children
}: {
  isMultiSelectMode: boolean
  children: React.ReactNode
}) => {
  return isMultiSelectMode ? <label style={{ cursor: 'pointer' }}>{children}</label> : children
}

const MessageItem: FC<Props> = ({
  message,
  topic,
  // assistant,
  index,
  hideMenuBar = false,
  isGrouped,
  onUpdateUseful,
  isGroupContextMessage,
  isHorizontalMultiModelLayout = false,
  isEditMode = false,
  onGroupClick
}) => {
  const { assistant, setModel } = useAssistant(message.assistantId)
  const { isMultiSelectMode } = useChatContext(topic)
  const model = useModel(getMessageModelId(message), message.model?.provider) || message.model
  const { fontSize, showMessageOutline } = useSettings()
  const { editMessageBlocks, resendUserMessageWithEdit } = useMessageOperations(topic)
  const messageContainerRef = useRef<HTMLDivElement>(null)
  const { editingMessageId, startEditing, stopEditing } = useMessageEditing()
  const { setTimeoutTimer } = useTimer()
  const isEditing = editingMessageId === message.id
  const editMode = useOptionalEditMode()
  const selectedGroupIds = editMode?.selectedGroupIds ?? EMPTY_SELECTED_GROUP_IDS

  useEffect(() => {
    if (isEditing && messageContainerRef.current) {
      scrollIntoView(messageContainerRef.current, {
        behavior: 'smooth',
        block: 'center',
        container: 'nearest'
      })
    }
  }, [isEditing])

  const handleEditSave = useCallback(
    async (blocks: MessageBlock[], onCommit: (blockIds: readonly string[]) => void) => {
      // LOCK-003: Rethrow on failure so MessageEditor can reset isProcessing
      // and keep the editor open for retry. No catch here — error propagates
      // to MessageEditor.handleSave's catch block.
      // LOCK-002: Compute usage from ALL edited blocks including file/image
      // metadata in the same atomic patch — no separate void editMessage.
      const editedUsage = await estimateMessageBlocksUsage(blocks)
      const extraUpdates: Partial<Message> & Pick<Message, 'id'> = editedUsage
        ? { id: message.id, usage: editedUsage }
        : { id: message.id }
      await editMessageBlocks(message.id, blocks, extraUpdates, onCommit)
      stopEditing()
    },
    [message, editMessageBlocks, stopEditing]
  )

  const handleEditResend = useCallback(
    async (blocks: MessageBlock[], onCommit: (blockIds: readonly string[]) => void) => {
      // LOCK-003: Rethrow on failure so MessageEditor can reset isProcessing
      // and keep the editor open for retry.
      await resendUserMessageWithEdit(message, blocks, assistant, onCommit)
      stopEditing()
    },
    [message, resendUserMessageWithEdit, assistant, stopEditing]
  )

  const handleEditCancel = useCallback(() => {
    stopEditing()
  }, [stopEditing])

  const isLastMessage = index === 0 || !!isGrouped
  const isAssistantMessage = message.role === 'assistant'
  const isProcessing = isMessageProcessing(message)
  const showMenubar = !hideMenuBar && !isEditing && !isProcessing
  // LOCK-105: message style is always bubble; the footer reverses for the
  // last assistant message.
  const shouldReverseFooter = isLastMessage && isAssistantMessage

  // 编辑模式下点击消息内容区域触发组选择
  const handleMessageClick = useCallback(
    (e: React.MouseEvent) => {
      if (!isEditMode || !onGroupClick) return
      // 排除 Footer（菜单栏）区域，按钮有自己的 handler
      if (
        (e.target as HTMLElement).closest(
          '.menubar, ' +
            '.message-editor-area, ' +
            '.message-header > :first-child, ' +
            '.ant-image, ' +
            '.ant-collapse-header, ' +
            '.message-attachments, ' +
            'video, ' +
            '.message-action-button, ' +
            '.ant-dropdown, ' +
            '.ant-dropdown-menu-submenu-popup, ' +
            '.ant-image-preview-root, ' +
            '.ant-popover, ' +
            '.ant-modal'
        )
      )
        return
      const askId = message.role === 'user' ? message.id : message.askId || message.id
      if (!askId) return
      const isCtrl = e.metaKey || e.ctrlKey
      const isShift = e.shiftKey
      onGroupClick(askId, isCtrl, isShift)
    },
    [isEditMode, message, onGroupClick]
  )

  // 编辑模式下右键消息内容区域自动选中消息组，不在可选区域时抑制菜单弹出
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!isEditMode || !onGroupClick) return

      // 排除区域：阻止冒泡到 EditModeContextMenu 的 Dropdown，不弹出编辑模式菜单
      if (
        (e.target as HTMLElement).closest(
          '.menubar, ' +
            '.message-editor-area, ' +
            '.message-header > :first-child, ' +
            '.ant-image, ' +
            '.ant-collapse-header, ' +
            '.message-attachments, ' +
            'video, ' +
            '.message-action-button, ' +
            '.ant-dropdown, ' +
            '.ant-dropdown-menu-submenu-popup, ' +
            '.ant-image-preview-root, ' +
            '.ant-popover, ' +
            '.ant-modal'
        )
      ) {
        e.stopPropagation()
        return
      }

      const askId = message.role === 'user' ? message.id : message.askId || message.id
      if (!askId) {
        e.stopPropagation()
        return
      }

      // 右键时：如果目标消息组已在选中列表中，不调用 onGroupClick（避免 toggle 清空选区）
      // 如果不在选中列表中，调用 onGroupClick 选中它（替换当前选区）
      if (!selectedGroupIds.includes(askId)) {
        onGroupClick(askId, false, false)
      }
      // 不调用 stopPropagation，让 EditModeContextMenu 的 Dropdown 正常弹出
    },
    [isEditMode, message, onGroupClick, selectedGroupIds]
  )

  const messageHighlightHandler = useCallback(
    (highlight: boolean = true) => {
      if (messageContainerRef.current) {
        scrollIntoView(messageContainerRef.current, { behavior: 'smooth', block: 'center', container: 'nearest' })
        if (highlight) {
          setTimeoutTimer(
            'messageHighlightHandler',
            () => {
              const classList = messageContainerRef.current?.classList
              classList?.add('animation-locate-highlight')

              const handleAnimationEnd = () => {
                classList?.remove('animation-locate-highlight')
                messageContainerRef.current?.removeEventListener('animationend', handleAnimationEnd)
              }

              messageContainerRef.current?.addEventListener('animationend', handleAnimationEnd)
            },
            500
          )
        }
      }
    },
    [setTimeoutTimer]
  )

  useEffect(() => {
    const unsubscribes = [EventEmitter.on(EVENT_NAMES.LOCATE_MESSAGE + ':' + message.id, messageHighlightHandler)]
    return () => unsubscribes.forEach((unsub) => unsub())
  }, [message.id, messageHighlightHandler])

  // Listen for external edit requests and activate editor for this message if it matches
  useEffect(() => {
    const handleEditRequest = (targetId: string) => {
      if (targetId === message.id) {
        startEditing(message.id)
      }
    }
    const unsubscribe = EventEmitter.on(EVENT_NAMES.EDIT_MESSAGE, handleEditRequest)
    return () => {
      unsubscribe()
    }
  }, [message.id, startEditing])

  return (
    <WrapperContainer isMultiSelectMode={isMultiSelectMode}>
      <MessageContainer
        key={message.id}
        id={`message-${message.id}`}
        data-message-id={message.id}
        data-ask-id={isAssistantMessage ? message.askId || message.id : undefined}
        className={classNames({
          message: true,
          'message-assistant': isAssistantMessage,
          'message-user': !isAssistantMessage,
          'edit-mode-message': isEditMode
        })}
        ref={messageContainerRef}
        onClick={isEditMode ? handleMessageClick : undefined}
        onContextMenu={isEditMode ? handleContextMenu : undefined}>
        <MessageHeader
          message={message}
          assistant={assistant}
          model={model}
          key={getModelUniqId(model)}
          topic={topic}
          isGroupContextMessage={isGroupContextMessage}
        />
        {isEditing && (
          <MessageEditor
            message={message}
            topicId={topic.id}
            onSave={handleEditSave}
            onResend={handleEditResend}
            onCancel={handleEditCancel}
          />
        )}
        {!isEditing && (
          <>
            {!isMultiSelectMode && message.role === 'assistant' && showMessageOutline && (
              <MessageOutline message={message} />
            )}
            <MessageContentContainer
              className="message-content-container"
              style={{
                fontSize,
                overflowY: isHorizontalMultiModelLayout ? 'auto' : 'visible'
              }}>
              <MessageErrorBoundary>
                <MessageContent message={message} />
              </MessageErrorBoundary>
            </MessageContentContainer>
            {showMenubar && (
              <MessageFooter className="MessageFooter">
                <HorizontalScrollContainer
                  classNames={{
                    content: cn(
                      'flex-1 items-center justify-between',
                      shouldReverseFooter ? 'flex-row-reverse' : 'flex-row'
                    )
                  }}>
                  <MessageMenubar
                    message={message}
                    assistant={assistant}
                    model={model}
                    topic={topic}
                    isLastMessage={isLastMessage}
                    isAssistantMessage={isAssistantMessage}
                    isGrouped={isGrouped}
                    messageContainerRef={messageContainerRef as React.RefObject<HTMLDivElement>}
                    setModel={setModel}
                    onUpdateUseful={onUpdateUseful}
                  />
                </HorizontalScrollContainer>
              </MessageFooter>
            )}
          </>
        )}
      </MessageContainer>
    </WrapperContainer>
  )
}

const MessageContainer = styled.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  position: relative;
  transition: background-color 0.3s ease;
  transform: translateZ(0);
  will-change: transform;
  padding: 10px;
  padding-bottom: 0;
  border-radius: 10px;
  .menubar {
    opacity: 0;
    transition: opacity 0.2s ease;
    transform: translateZ(0);
    will-change: opacity;
    &.show {
      opacity: 1;
    }
  }
  &:hover {
    .menubar {
      opacity: 1;
    }
  }
  &.edit-mode-message {
  }
`

const MessageContentContainer = styled(Scrollbar)`
  max-width: 100%;
  padding-left: 46px;
  margin-top: 0;
  overflow-y: auto;
`

const MessageFooter = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-left: 46px;
  margin-top: 3px;
  user-select: none;
`

export default memo(MessageItem)
