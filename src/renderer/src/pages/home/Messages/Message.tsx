import HorizontalScrollContainer from '@renderer/components/HorizontalScrollContainer'
import Scrollbar from '@renderer/components/Scrollbar'
import { useOptionalEditMode } from '@renderer/context/EditModeContext'
import { useMessageEditing } from '@renderer/context/MessageEditingContext'
import { useMessageAssistant } from '@renderer/hooks/useAssistant'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useMessageActionController } from '@renderer/hooks/useMessageActionController'
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
import type { SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import type { Dispatch, FC, SetStateAction } from 'react'
import React, { memo, useCallback, useEffect, useRef } from 'react'
import styled from 'styled-components'

import MessageContent from './MessageContent'
import MessageEditor from './MessageEditor'
import MessageErrorBoundary from './MessageErrorBoundary'
import MessageHeader from './MessageHeader'
import MessageMenubar from './MessageMenubar'
import { areProjectedMessagesEqual, areTopicsViewportEqual, isSameViewportPosition } from './messageViewportProjection'
import {
  captureInteractionIntent,
  INTERACTION_REGION_CONTROLS,
  useOptionalRouteViewportCommands
} from './routeViewportContext'

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
  /**
   * Optional caller-local snapshot block map for history rendering.
   * When provided, content/outline resolve blocks from the snapshot;
   * undefined preserves the default active-chat Redux behavior.
   */
  snapshotBlocksById?: SnapshotBlockMap
  /**
   * Whether this row publishes the stable `message-<id>` / `data-message-id`
   * DOM anchors. Defaults to true for the live chat list; offscreen renders
   * (topic image export) pass false so a duplicate anchor can never divert the
   * viewport geometry reads of the resident rows.
   */
  renderDomId?: boolean
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
  onGroupClick,
  snapshotBlocksById,
  renderDomId = true
}) => {
  // Narrow presentation subscription: configuration only, never topics, so
  // ordinary-send topic updatedAt bumps cannot invalidate history messages.
  const { assistant, setModel } = useMessageAssistant(message.assistantId)
  const { isMultiSelectMode } = useChatContext(topic)
  const model = useModel(getMessageModelId(message), message.model?.provider) || message.model
  const { fontSize } = useSettings()
  const { editSave, resendWithEdit } = useMessageActionController()
  const messageContainerRef = useRef<HTMLDivElement>(null)
  const { editingMessageId, startEditing, stopEditing } = useMessageEditing()
  const { setTimeoutTimer } = useTimer()
  const isEditing = editingMessageId === message.id
  const editMode = useOptionalEditMode()
  const selectedGroupIds = editMode?.selectedGroupIds ?? EMPTY_SELECTED_GROUP_IDS
  // Stable command surface (NOT the versioned context): a row renders its own
  // message/config/window, never the viewport version, so subscribing to the
  // versioned value would re-render every mounted row on every viewport
  // notification (native key repeats included) for no rendered output.
  const routeViewport = useOptionalRouteViewportCommands()
  const viewportController = routeViewport?.controller ?? null

  // Edit open/cancel never smooth-centers: the shared interaction hold keeps
  // the footer ↔ action-bar region stationary through the editor swap, and
  // the editor focuses with preventScroll (see MessageEditor). The former
  // `scrollIntoView(center, smooth)` competing write is removed; explicit
  // locate navigation (messageHighlightHandler below) keeps its own path.

  const captureControlsIntent = useCallback(() => {
    try {
      if (!viewportController) return
      captureInteractionIntent(viewportController, { kind: 'message', id: message.id }, INTERACTION_REGION_CONTROLS)
    } catch {}
  }, [viewportController, message.id])

  const handleEditSave = useCallback(
    async (blocks: MessageBlock[], onCommit: (blockIds: readonly string[]) => void) => {
      const ok = await editSave({ topicId: topic.id, messageId: message.id }, blocks, onCommit)
      if (ok === false) {
        // missing/cross-topic target must not silently close the editor;
        // propagate so MessageEditor keeps processing state for retry
        throw new Error(`[handleEditSave] missing target ${message.id}`)
      }
      stopEditing()
    },
    [editSave, topic.id, message.id, stopEditing]
  )

  const handleEditResend = useCallback(
    async (blocks: MessageBlock[], onCommit: (blockIds: readonly string[]) => void) => {
      const ok = await resendWithEdit({ topicId: topic.id, messageId: message.id }, blocks, onCommit)
      if (ok === false) {
        throw new Error(`[handleEditResend] missing target ${message.id}`)
      }
      stopEditing()
    },
    [resendWithEdit, topic.id, message.id, stopEditing]
  )

  const handleEditCancel = useCallback(() => {
    // Non-click cancel paths (Esc key, programmatic) carry no click-boundary
    // capture: arm the shared region hold synchronously before the close.
    // Click cancels already armed via the shared click boundary; re-arming
    // with the same pre-mutation geometry is harmless (newer gesture wins).
    captureControlsIntent()
    stopEditing()
  }, [stopEditing, captureControlsIntent])

  const isLastMessage = index === 0 || !!isGrouped
  const isAssistantMessage = message.role === 'assistant'
  const isProcessing = isMessageProcessing(message)
  // Edit mode is selection-only: the ordinary message toolbar keeps its
  // DOM/layout structure and occupied height. Forced hiding is owned one
  // layer up by the turn container (EditTurn), which hides this footer in
  // the same edit-mode commit with no transition while reserving height.
  // The floating edit-mode selection action bar is a separate overlay and
  // is unaffected.
  const showMenubar = !hideMenuBar && !isEditing && !isProcessing
  // LOCK-105: message style is always bubble; every assistant-message
  // toolbar sits on the LEFT side (not only the last assistant message).
  // User-message positioning is unchanged.
  const shouldReverseFooter = isAssistantMessage

  // Neutral hover preview lives at the turn interaction owner
  // (EditTurn), covering the whole Q&A turn — never per MessageItem.
  // Selected turns sit inside the selected outline with no preview ring.

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
        // Shortcut/programmatic open carries no click: capture the live
        // footer region synchronously before the editor swap.
        captureControlsIntent()
        startEditing(message.id)
      }
    }
    const unsubscribe = EventEmitter.on(EVENT_NAMES.EDIT_MESSAGE, handleEditRequest)
    return () => {
      unsubscribe()
    }
  }, [message.id, startEditing, captureControlsIntent])

  return (
    <WrapperContainer isMultiSelectMode={isMultiSelectMode}>
      <MessageContainer
        key={message.id}
        id={renderDomId ? `message-${message.id}` : undefined}
        data-message-id={renderDomId ? message.id : undefined}
        data-ask-id={isAssistantMessage ? message.askId || message.id : undefined}
        className={classNames({
          message: true,
          'message-assistant': isAssistantMessage,
          'message-user': !isAssistantMessage,
          'edit-mode-message': isEditMode
        })}
        ref={messageContainerRef}
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
            <MessageContentContainer
              className="message-content-container"
              style={{
                fontSize,
                overflowY: isHorizontalMultiModelLayout ? 'auto' : 'visible'
              }}>
              <MessageErrorBoundary>
                <MessageContent message={message} snapshotBlocksById={snapshotBlocksById} />
              </MessageErrorBoundary>
            </MessageContentContainer>
            {showMenubar && (
              <MessageFooter
                data-interaction-region="message-controls"
                data-viewport-baseline-edge="end"
                className="MessageFooter">
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
    cursor: pointer;
    user-select: none;
    .markdown {
      user-select: none;
    }
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

/**
 * History-isolation comparator for the send/append hot path (mirrors the
 * MessageGroup boundary one level down).
 *
 * The numeric `index` prop is compared by 0-boundary only: it feeds exactly
 * `isLastMessage = index === 0 || isGrouped`, so a pure non-zero displacement
 * after an append cannot change rendering while a newest-marker hand-off
 * invalidates. The topic tolerates pure `updatedAt` send bumps and compares
 * every other field. All message fields compare complete (no whitelist), so
 * status/model/fold/useful/blocks-membership/branch changes always update.
 * Store/context subscriptions inside (assistant/model/settings/editing/
 * selection/blocks) bypass this boundary and never go stale.
 */
export const areMessageItemPropsEqual = (prev: Props, next: Props): boolean => {
  if (prev === next) return true
  if (!areProjectedMessagesEqual(prev.message, next.message)) return false
  if (!isSameViewportPosition(prev.index, next.index)) return false
  if (!areTopicsViewportEqual(prev.topic, next.topic)) return false
  if (prev.assistant !== next.assistant) return false
  if ((prev.total ?? 0) !== (next.total ?? 0)) return false
  if ((prev.hideMenuBar ?? false) !== (next.hideMenuBar ?? false)) return false
  if ((prev.isGrouped ?? false) !== (next.isGrouped ?? false)) return false
  if ((prev.isStreaming ?? false) !== (next.isStreaming ?? false)) return false
  if ((prev.isGroupContextMessage ?? false) !== (next.isGroupContextMessage ?? false)) return false
  if ((prev.isHorizontalMultiModelLayout ?? false) !== (next.isHorizontalMultiModelLayout ?? false)) return false
  if ((prev.isEditMode ?? false) !== (next.isEditMode ?? false)) return false
  if (prev.style !== next.style) return false
  if (prev.onSetMessages !== next.onSetMessages) return false
  if (prev.onUpdateUseful !== next.onUpdateUseful) return false
  if (prev.onGroupClick !== next.onGroupClick) return false
  if (prev.snapshotBlocksById !== next.snapshotBlocksById) return false
  if ((prev.renderDomId ?? true) !== (next.renderDomId ?? true)) return false
  return true
}

export default memo(MessageItem, areMessageItemPropsEqual)
