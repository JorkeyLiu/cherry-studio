import { loggerService } from '@logger'
import Scrollbar from '@renderer/components/Scrollbar'
import { MessageEditingProvider } from '@renderer/context/MessageEditingContext'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useMessageActionController } from '@renderer/hooks/useMessageActionController'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { isLoadedAnswerGroupMutable, resolveLoadedAnswerGroup } from '@renderer/store/routeAnswerGroup'
import { reorderMessageGroupThunk } from '@renderer/store/thunk/messageGroupReorder'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { classNames } from '@renderer/utils'
import type { ComponentProps } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import styled from 'styled-components'

import MessageItem from './Message'
import MessageGroupMenuBar from './MessageGroupMenuBar'
import { deriveStableGroupId } from './messageRenderLayers'
import { areProjectedMessagesEqual, areTopicsViewportEqual } from './messageViewportProjection'
import { useOptionalRouteViewport } from './routeViewportContext'

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
  const stableGroupId = useMemo(() => deriveStableGroupId(messages), [messages])
  const domGroupId = useMemo(() => {
    if (!stableGroupId || stableGroupId === 'group:empty') return undefined
    return `message-group-${stableGroupId.replace(/[:|]/g, (ch) => (ch === ':' ? '-' : '_'))}`
  }, [stableGroupId])

  // Hooks
  const { selectAnswer, selectUseful } = useMessageActionController()
  const { isMultiSelectMode } = useChatContext(topic)
  const dispatch = useAppDispatch()
  const tabViewport = useOptionalRouteViewport()

  const isGrouped = messageLength > 1 && messages.every((m) => m.role === 'assistant')

  // BRANCH-12 group capability: every loaded assistant member must be
  // owned through the active route (reading the loaded user root never
  // blocks). Unknown capability or any loaded non-owned member disables
  // group mutations (selector, useful, reorder, retry-all); Main stays
  // final for window-outside members. Single (non-grouped) messages fall
  // back to their own mutability.
  const groupMutable = useAppSelector((state) => {
    try {
      const seedId = messages.length > 0 ? messages[0].id : null
      if (!seedId) return false
      const group = resolveLoadedAnswerGroup(state, topic.id, seedId)
      if (!group) return false
      return isLoadedAnswerGroupMutable(state, topic.id, group)
    } catch {
      return false
    }
  })

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
      // BRANCH-12: the whole selector is inert when the group is non-owned.
      if (!groupMutable) return
      // S3.4: explicit target IDs resolved at event time to the latest
      // complete answer group. No captured messages array is used so a
      // projection update that expands the group is observed.
      // Viewport SWITCHING: the clicked tab's geometry is captured
      // synchronously in the tab strip (see MessageGroupModelList) BEFORE
      // this dispatch; the keeper holds that tab stationary across the async
      // DB-first selection + height swap (no body-anchor jump, no bottom
      // jump). Authority selection still flows through selectAnswer; guards
      // unchanged. Failure clears ONLY the gesture it belongs to: a stale
      // rejection must never clear a newer click's hold.
      const controller = tabViewport?.controller ?? null
      let gestureEpoch: number | undefined
      let gestureId: number | undefined
      try {
        const live = controller?.activeAnswerTabIntent ?? null
        if (live && live.tabMessageId === message.id) {
          gestureEpoch = live.epoch
          gestureId = live.gestureId
        }
      } catch {
        gestureEpoch = undefined
        gestureId = undefined
      }
      const clearOwnGestureOnly = (): void => {
        try {
          if (!controller || gestureEpoch === undefined) return
          const live = controller.activeAnswerTabIntent
          if (
            live &&
            live.epoch === gestureEpoch &&
            live.tabMessageId === message.id &&
            (gestureId === undefined || live.gestureId === gestureId)
          ) {
            controller.clearAnswerTabSwitch(gestureEpoch, message.id, gestureId)
          }
        } catch {}
      }
      try {
        const pending = selectAnswer({ topicId: topic.id, messageId: message.id }) as unknown
        if (pending && typeof (pending as { catch?: unknown }).catch === 'function') {
          void (pending as Promise<unknown>).catch(() => {
            // A failed/cancelled selection must not retain its own stale tab
            // hold — but must never clear a newer gesture.
            clearOwnGestureOnly()
          })
        }
      } catch {
        clearOwnGestureOnly()
      }
    },
    [groupMutable, selectAnswer, tabViewport, topic.id]
  )
  // NOTE: registerMessageElement logic is kept for future use (currently not used for navigation)
  useEffect(() => {
    messages.forEach((message) => {
      const element = document.getElementById(`message-${message.id}`)
      element && registerMessageElement?.(message.id, element)
    })
    return () => messages.forEach((message) => registerMessageElement?.(message.id, null))
  }, [messages, registerMessageElement])

  // BRANCH-12: group-level atomic useful toggle. One Main transaction sets
  // the single useful member (or clears when already useful); the old
  // per-message forEach(editMessage) partial-write path is removed.
  // History isolation: the member lookup resolves at event time through a
  // live ref (S3.4 pattern, mirroring setSelectedMessage above), so this
  // callback keeps a stable identity across parent rebuilds that reuse the
  // same canonical entities — unchanged sibling MessageItems below stay
  // referentially equal and skip re-render.
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const onUpdateUseful = useCallback(
    (msgId: string) => {
      const message = messagesRef.current.find((msg) => msg.id === msgId)
      if (!message) {
        logger.error("the message to update doesn't exist in this group")
        return
      }
      if (!groupMutable) return
      void selectUseful({ topicId: topic.id, messageId: msgId }).catch((e) => {
        logger.error('[onUpdateUseful] Failed to toggle useful:', e as Error)
      })
    },
    [groupMutable, selectUseful, topic.id]
  )

  const handleReorderMessages = useCallback(
    (reorderedMessages: Message[]) => {
      // BRANCH-12: sortable is disabled when the group is non-owned; the
      // handler stays fail-closed as defense-in-depth.
      if (!groupMutable) return
      void dispatch(
        reorderMessageGroupThunk(
          topic.id,
          reorderedMessages.map((message) => message.id)
        )
      )
    },
    [dispatch, groupMutable, topic.id]
  )

  // Edit-mode selection ownership lives one layer up at the turn
  // container (EditTurn): it captures the click once per gesture for the
  // whole Q&A turn and draws the single hover ring. MessageGroup owns no
  // click/hover handler, keeps no hover state or timer, and exposes no
  // geometry query attribute — MessageItem keeps only the right-click
  // auto-select path via onGroupClick.

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
      <GroupContainer id={domGroupId} className={classNames([multiModelMessageStyle])}>
        <GridContainer className={classNames([multiModelMessageStyle, { 'multi-select-mode': isMultiSelectMode }])}>
          {messages.map(renderMessage)}
        </GridContainer>
        {/* Edit-mode forced hide (not non-render): the bar keeps its DOM
            structure and occupied height while staying invisible,
            noninteractive, and inaccessible — see MessageGroupMenuBar.
            Group selection still flows through the group-level capture
            interaction. */}
        {isGrouped && (
          <MessageGroupMenuBar
            messages={messages}
            selectMessageId={selectedMessageId}
            setSelectedMessage={setSelectedMessage}
            onReorderMessages={handleReorderMessages}
            topic={topic}
            disabled={!groupMutable}
            isEditMode={isEditMode}
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

/**
 * History-isolation comparator for the send/append hot path.
 *
 * An unchanged history group skips re-render when: same member count, every
 * member render-equal (canonical entity identity, or a field-identical entity
 * with only a proven render-neutral non-zero index displacement), and a
 * viewport-equal topic (pure `updatedAt` send bumps ignored, every other
 * topic field compared). Callbacks are reference-compared: they are stable
 * across sends (`registerMessageElement` has `[]` deps; `onGroupClick` is the
 * stable non-edit-mode handler), while a genuine selection change yields a
 * new handler and correctly invalidates. Edit mode, capability (internal
 * selector subscription), and context-driven updates bypass this boundary by
 * design and never go stale.
 */
export const areMessageGroupPropsEqual = (prev: Props, next: Props): boolean => {
  if (prev === next) return true
  if ((prev.isEditMode ?? false) !== (next.isEditMode ?? false)) return false
  if (prev.registerMessageElement !== next.registerMessageElement) return false
  if (prev.onGroupClick !== next.onGroupClick) return false
  if (!areTopicsViewportEqual(prev.topic, next.topic)) return false
  if (prev.messages.length !== next.messages.length) return false
  for (let i = 0; i < prev.messages.length; i += 1) {
    if (!areProjectedMessagesEqual(prev.messages[i], next.messages[i])) return false
  }
  return true
}

export default memo(MessageGroup, areMessageGroupPropsEqual)
