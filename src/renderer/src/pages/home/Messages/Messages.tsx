import { loggerService } from '@logger'
import ContextMenu from '@renderer/components/ContextMenu'
import EditModeActionBar from '@renderer/components/EditModeActionBar'
import { UNLIMITED_CONTEXT_COUNT } from '@renderer/config/constant'
import { EditModeProvider, useEditMode } from '@renderer/context/EditModeContext'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useClipboardKeyboard } from '@renderer/hooks/useClipboardKeyboard'
import { useMessageOperations, useTopicMessages } from '@renderer/hooks/useMessageOperations'
import useScrollPosition from '@renderer/hooks/useScrollPosition'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { autoRenameTopic } from '@renderer/hooks/useTopic'
import { getAssistantSettings, getDefaultTopic } from '@renderer/services/AssistantService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { IndexedMessage } from '@renderer/services/MessagesService'
import {
  clearPendingLocateMessage,
  getContextCount,
  getGroupedMessages,
  getPendingLocateMessage,
  getUserMessage
} from '@renderer/services/MessagesService'
import { estimateHistoryTokens } from '@renderer/services/TokenService'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import { messageBlocksSelectors, updateOneBlock } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import { saveMessageAndBlocksToDB, updateMessageAndBlocksThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant, Topic } from '@renderer/types'
import type { MessageBlock } from '@renderer/types/newMessage'
import { type Message, MessageBlockType } from '@renderer/types/newMessage'
import {
  captureScrollableAsBlob,
  captureScrollableAsDataURL,
  removeSpecialCharactersForFileName,
  runAsyncFunction
} from '@renderer/utils'
import { updateCodeBlock } from '@renderer/utils/markdown'
import {
  filterAdjacentUserMessaegs,
  filterAfterContextClearMessages,
  filterErrorOnlyMessagesWithRelated,
  filterLastAssistantMessage,
  filterUsefulMessages
} from '@renderer/utils/messageUtils/filters'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { isTextLikeBlock } from '@renderer/utils/messageUtils/is'
import { Spin } from 'antd'
import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import styled from 'styled-components'

import MessageGroup from './MessageGroup'
import NarrowLayout from './NarrowLayout'
import Prompt from './Prompt'
import { MessagesContainer, ScrollContainer } from './shared'

interface MessagesProps {
  assistant: Assistant
  topic: Topic
  setActiveTopic: (topic: Topic) => void
  onComponentUpdate?(): void
  onFirstUpdate?(): void
}

export interface MessagesHandle {
  scrollToMessageById: (messageId: string, align?: 'start' | 'center' | 'end') => void
  virtuosoRef: React.RefObject<VirtuosoHandle | null>
  groupedMessages: GroupEntry[]
}

const logger = loggerService.withContext('Messages')

type GroupEntry = [string, IndexedMessage[]]

interface MessagesContentProps {
  assistant: Assistant
  topic: Topic
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  handleScrollPosition: () => void
  messages: Message[]
  groupedMessages: GroupEntry[]
  registerMessageElement: (id: string, element: HTMLElement | null) => void
  virtuosoRef: React.RefObject<VirtuosoHandle | null>
  scrollParentEl: HTMLElement | null
  initialTopMostItemIndex: number
}

const MessagesContent = React.memo(function MessagesContent({
  assistant,
  topic,
  scrollContainerRef,
  handleScrollPosition,
  messages,
  groupedMessages,
  registerMessageElement,
  virtuosoRef,
  scrollParentEl,
  initialTopMostItemIndex
}: MessagesContentProps) {
  const { showPrompt } = useSettings()
  const { t } = useTranslation()

  const { isEnabled: isEditMode, selectedGroupIds, handleGroupClick } = useEditMode()
  useClipboardKeyboard()

  // Defer messages/groupedMessages for non-urgent computations (context window boundary)
  // This prevents the expensive 5-filter chain from blocking streaming updates
  const deferredMessages = useDeferredValue(messages)
  const deferredGroupedMessages = useDeferredValue(groupedMessages)

  // Centralized LOCATE_MESSAGE handler for Virtuoso virtualization compatibility.
  // When messages are not rendered (outside virtualization window), per-message
  // listeners don't exist. This centralized handler ensures all LOCATE_MESSAGE
  // events are handled by scrolling Virtuoso to the correct group.

  useEffect(() => {
    const handler = (messageId: string) => {
      const groupIndex = groupedMessages.findIndex(([, msgs]) => msgs.some((im) => im.message.id === messageId))
      if (groupIndex >= 0) {
        clearPendingLocateMessage(messageId)
        virtuosoRef.current?.scrollToIndex({ index: groupIndex, align: 'center', behavior: 'smooth' })
      } else {
        // Message not yet loaded — pending is already set in locateToMessage
      }
    }
    const unsubscribe = EventEmitter.on(EVENT_NAMES.LOCATE_MESSAGE, handler)
    return () => unsubscribe()
  }, [groupedMessages, virtuosoRef])

  // When groupedMessages updates, check for pending locate messages
  useEffect(() => {
    const pendingId = getPendingLocateMessage()
    if (pendingId && groupedMessages.length > 0) {
      const groupIndex = groupedMessages.findIndex(([, msgs]) => msgs.some((im) => im.message.id === pendingId))
      if (groupIndex >= 0) {
        clearPendingLocateMessage(pendingId)
        requestAnimationFrame(() => {
          virtuosoRef.current?.scrollToIndex({ index: groupIndex, align: 'center', behavior: 'smooth' })
        })
      }
    }
  }, [groupedMessages, virtuosoRef])

  // Scroll handler — just save position (Virtuoso handles virtualization)
  const handleScroll = useCallback(() => {
    handleScrollPosition()
  }, [handleScrollPosition])

  // Context window boundary: compute where the context window starts
  // Uses deferred values so this expensive computation doesn't block streaming updates
  const contextWindowBoundaryIndex = useMemo(() => {
    if (!assistant) return -1
    const settings = getAssistantSettings(assistant)

    // Unlimited context: hide the divider since there's no boundary
    if (settings.contextCount >= UNLIMITED_CONTEXT_COUNT) return -1

    // Apply the first 5 filter steps (mirrors ConversationService.filterMessagesPipeline)
    // to derive the pre-filtered message array used for boundary computation.
    const preFiltered = filterAdjacentUserMessaegs(
      filterLastAssistantMessage(
        filterErrorOnlyMessagesWithRelated(filterUsefulMessages(filterAfterContextClearMessages(deferredMessages)))
      )
    )

    let anchorOriginalIndex = -1

    if (settings.contextWindowMode === 'fixed') {
      // Fixed mode: locate the anchor message in the pre-filtered stream
      const anchorMessageId = settings.fixedWindowAnchor?.[topic.id]
      if (anchorMessageId) {
        const filteredIndex = preFiltered.findIndex((m) => m.id === anchorMessageId)
        if (filteredIndex >= 0) {
          // Map back to the anchor's original index in the full messages array
          anchorOriginalIndex = deferredMessages.findIndex((m) => m.id === anchorMessageId)
        }
      }

      // Anchor not found or not set — fall through to sliding logic
      if (anchorOriginalIndex < 0) {
        const windowStartIndex = Math.max(0, deferredMessages.length - settings.contextCount)
        if (windowStartIndex === 0) return -1
        anchorOriginalIndex = windowStartIndex
      }
    } else {
      // Sliding mode: compute where the window starts
      const windowStartIndex = Math.max(0, deferredMessages.length - settings.contextCount)
      // All messages fit inside the context window → hide the divider
      if (windowStartIndex === 0) return -1
      anchorOriginalIndex = windowStartIndex
    }

    if (anchorOriginalIndex < 0) return -1

    // In normal order (oldest first), find the anchor's position in messages
    // and then find the start of the group containing the anchor.
    // The boundary is the start of that group, so the divider renders before it.
    const anchorMessage = deferredMessages[anchorOriginalIndex]
    if (!anchorMessage) return -1

    // Find the group containing the anchor message
    for (const [, groupMessages] of deferredGroupedMessages) {
      const groupStart = groupMessages[0]?.index ?? -1
      const groupEnd = groupMessages[groupMessages.length - 1]?.index ?? -1
      if (anchorOriginalIndex >= groupStart && anchorOriginalIndex <= groupEnd) {
        return groupStart
      }
    }
    return -1
  }, [assistant, deferredMessages, deferredGroupedMessages, topic.id])

  // Find the group key where the context window divider should be rendered
  const contextDividerGroupKey = useMemo(() => {
    if (contextWindowBoundaryIndex <= 0) return null
    for (const [key, groupMessages] of groupedMessages) {
      const oldestMsgIndex = groupMessages[0]?.index ?? -1
      if (oldestMsgIndex >= contextWindowBoundaryIndex) {
        return key
      }
    }
    return null
  }, [groupedMessages, contextWindowBoundaryIndex])

  // Virtuoso item renderer
  const renderItem = useCallback(
    (_index: number, group: GroupEntry) => {
      const [key, groupMessages] = group
      const groupAskId = groupMessages[0]?.message.askId || groupMessages[0]?.message.id || ''
      const isSelected = isEditMode && selectedGroupIds.includes(groupAskId)

      return (
        <VirtuosoItemWrapper key={key} $isSelected={isSelected}>
          {key === contextDividerGroupKey && (
            <ContextWindowDivider data-context-boundary>
              <ContextWindowDividerLine />
              <ContextWindowDividerText>{t('chat.context_window_start')}</ContextWindowDividerText>
              <ContextWindowDividerLine />
            </ContextWindowDivider>
          )}
          <MessageGroup
            messages={groupMessages}
            topic={topic}
            registerMessageElement={registerMessageElement}
            isEditMode={isEditMode}
            onGroupClick={handleGroupClick}
          />
        </VirtuosoItemWrapper>
      )
    },
    [contextDividerGroupKey, isEditMode, selectedGroupIds, topic, registerMessageElement, handleGroupClick, t]
  )

  // Stable item key function
  const computeItemKey = useCallback(
    (index: number) => {
      return groupedMessages[index]?.[0] ?? `group-${index}`
    },
    [groupedMessages]
  )

  // Prompt header component (stable reference via useMemo)
  const virtuosoComponents = useMemo(() => {
    return {
      Header: function VirtuosoHeader() {
        if (!showPrompt) return null
        return <Prompt assistant={assistant} key={assistant.prompt} topic={topic} />
      }
    }
  }, [showPrompt, assistant, topic])

  return (
    <MessagesContainer
      id="messages"
      className="messages-container"
      ref={scrollContainerRef}
      key={assistant.id}
      onScroll={handleScroll}>
      {isEditMode && <EditModeActionBar />}
      <NarrowLayout>
        <ContextMenu>
          <ScrollContainer>
            {scrollParentEl && (
              <Virtuoso
                ref={virtuosoRef}
                customScrollParent={scrollParentEl}
                data={groupedMessages}
                itemContent={renderItem}
                computeItemKey={computeItemKey}
                components={virtuosoComponents}
                followOutput="auto"
                alignToBottom={true}
                increaseViewportBy={{ top: 600, bottom: 800 }}
                minOverscanItemCount={2}
                initialTopMostItemIndex={initialTopMostItemIndex}
              />
            )}
          </ScrollContainer>
        </ContextMenu>
      </NarrowLayout>
    </MessagesContainer>
  )
})

const Messages = ({
  ref,
  assistant,
  topic,
  setActiveTopic,
  onComponentUpdate,
  onFirstUpdate
}: MessagesProps & { ref?: React.RefObject<MessagesHandle | null> }) => {
  const {
    containerRef: scrollContainerRef,
    handleScroll: rawHandleScrollPosition,
    getSavedPosition,
    clearSavedPosition
  } = useScrollPosition(`topic-${topic.id}`)
  // Stabilize the scroll handler — useScrollPosition creates a new throttle each render
  const handleScrollPosition = useCallback(() => {
    rawHandleScrollPosition()
  }, [rawHandleScrollPosition])

  const [isProcessingContext, setIsProcessingContext] = useState(false)
  const [scrollParentEl, setScrollParentEl] = useState<HTMLElement | null>(null)

  const { addTopic, updateAssistantSettings } = useAssistant(assistant.id)
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const messages = useTopicMessages(topic.id)
  const { clearTopicMessages, deleteMessage, createTopicBranch } = useMessageOperations(topic)

  // Loading state for topic switch — shows spinner while IndexedDB loads messages
  const isLoading = useAppSelector((state) => state.messages.loadingByTopic[topic.id] ?? false)

  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const messagesRef = useRef<Message[]>(messages)

  // Set scroll parent after layout commit (before paint)
  useLayoutEffect(() => {
    setScrollParentEl(scrollContainerRef.current)
  }, [isLoading])

  // Compute grouped messages from all messages (used by both parent and child)
  // Object.entries() is cheap; Virtuoso has virtualization protection; no extra memo needed.
  const groupedMessages = useMemo(() => {
    return Object.entries(getGroupedMessages(messages))
  }, [messages])

  // Compute initial scroll position for Virtuoso to avoid flash-of-content from index 0
  const initialTopMostItemIndex = useMemo(() => {
    const saved = getSavedPosition()
    if (saved?.anchorId) {
      const idx = groupedMessages.findIndex(([, msgs]) => msgs.some((im) => im.message.id === saved.anchorId))
      if (idx >= 0) return idx
    }
    // Default: scroll to bottom
    return Math.max(0, groupedMessages.length - 1)
  }, [getSavedPosition, groupedMessages])

  // 滚动到指定消息组 (uses Virtuoso API for virtualization compatibility)
  const scrollToGroup = useCallback(
    (askId: string) => {
      // Find the group containing this askId
      const groupIndex = groupedMessages.findIndex(([key, msgs]) => {
        return key === askId || msgs.some((im) => im.message.askId === askId || im.message.id === askId)
      })
      if (groupIndex >= 0) {
        virtuosoRef.current?.scrollToIndex({
          index: groupIndex,
          align: 'start',
          behavior: 'smooth'
        })
      }
    },
    [groupedMessages]
  )

  // All message group IDs for edit mode keyboard navigation
  const visibleGroupIds = useMemo(() => {
    return new Set(
      messages
        .map((m) => {
          if (m.role === 'assistant') {
            return m.askId ?? m.id
          }
          return m.id
        })
        .filter(Boolean)
    )
  }, [messages])

  // No-op: Virtuoso manages DOM lifecycle; MessageGroup still calls this
  const registerMessageElement = useCallback((_id: string, _element: HTMLElement | null) => {
    // no-op
  }, [])

  const scrollToMessageById = useCallback(
    (messageId: string, align: 'start' | 'center' | 'end' = 'start') => {
      // Find the group containing this message
      const groupIndex = groupedMessages.findIndex(([, msgs]) => msgs.some((im) => im.message.id === messageId))
      if (groupIndex >= 0) {
        virtuosoRef.current?.scrollToIndex({
          index: groupIndex,
          align,
          behavior: 'auto'
        })
      }
    },
    [groupedMessages]
  )

  useImperativeHandle(ref, () => ({ scrollToMessageById, virtuosoRef, groupedMessages }), [
    scrollToMessageById,
    virtuosoRef,
    groupedMessages
  ])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // Scroll to bottom using Virtuoso API
  const scrollToBottom = useCallback(() => {
    if (groupedMessages.length === 0) return
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({
        index: groupedMessages.length - 1,
        align: 'end',
        behavior: 'auto'
      })
    })
  }, [groupedMessages])

  const clearTopic = useCallback(
    async (data: Topic) => {
      if (data && data.id !== topic.id) {
        await clearTopicMessages(data.id)
        return
      }

      await clearTopicMessages()
      clearSavedPosition()
    },
    [clearTopicMessages, topic.id, clearSavedPosition]
  )

  useEffect(() => {
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.SEND_MESSAGE, scrollToBottom),
      EventEmitter.on(EVENT_NAMES.CLEAR_MESSAGES, async (data: Topic) => {
        window.modal.confirm({
          title: t('chat.input.clear.title'),
          content: t('chat.input.clear.content'),
          centered: true,
          onOk: () => clearTopic(data)
        })
      }),
      EventEmitter.on(EVENT_NAMES.COPY_TOPIC_IMAGE, async () => {
        await captureScrollableAsBlob(scrollContainerRef, async (blob) => {
          if (blob) {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          }
        })
      }),
      EventEmitter.on(EVENT_NAMES.EXPORT_TOPIC_IMAGE, async () => {
        const imageData = await captureScrollableAsDataURL(scrollContainerRef)
        if (imageData) {
          void window.api.file.saveImage(removeSpecialCharactersForFileName(topic.name), imageData)
        }
      }),
      EventEmitter.on(EVENT_NAMES.NEW_CONTEXT, async () => {
        if (isProcessingContext) return
        setIsProcessingContext(true)

        try {
          const msgs = messagesRef.current

          if (msgs.length === 0) {
            return
          }

          const lastMessage = msgs.at(-1)

          if (lastMessage?.type === 'clear') {
            await deleteMessage(lastMessage.id)
            scrollToBottom()
            return
          }

          const { message: clearMessage } = getUserMessage({ assistant, topic, type: 'clear' })
          dispatch(newMessagesActions.addMessage({ topicId: topic.id, message: clearMessage }))
          await saveMessageAndBlocksToDB(topic.id, clearMessage, [])

          scrollToBottom()
        } finally {
          setIsProcessingContext(false)
        }
      }),
      EventEmitter.on(EVENT_NAMES.NEW_BRANCH, async (index: number) => {
        const newTopic = getDefaultTopic(assistant.id)
        newTopic.name = topic.name
        const currentMessages = messagesRef.current

        if (index < 0 || index > currentMessages.length) {
          logger.error(`[NEW_BRANCH] Invalid branch index: ${index}`)
          return
        }

        // 1. Add the new topic to Redux store FIRST
        addTopic(newTopic)

        // 2. Call the thunk to clone messages and update DB
        const success = await createTopicBranch(topic.id, currentMessages.length - index, newTopic)

        if (success) {
          // 3. Set the new topic as active
          setActiveTopic(newTopic)
          // 4. Trigger auto-rename for the new topic
          void autoRenameTopic(assistant, newTopic.id)
          // 5. Inherit fixed context window anchor
          const assistantSettings = getAssistantSettings(assistant)
          if (assistantSettings.contextWindowMode === 'fixed') {
            const sourceAnchorId = assistantSettings.fixedWindowAnchor?.[topic.id]
            if (sourceAnchorId) {
              // Find the anchor's index in the original messages
              const anchorIndex = currentMessages.findIndex((m) => m.id === sourceAnchorId)
              // Anchor must be within the cloned range (before the branch point)
              const clonedCount = currentMessages.length - index
              if (anchorIndex >= 0 && anchorIndex < clonedCount) {
                // Get the new topic's message IDs from the store
                const newTopicMessageIds = store.getState().messages.messageIdsByTopic[newTopic.id]
                if (newTopicMessageIds && newTopicMessageIds.length > anchorIndex) {
                  const newAnchorId = newTopicMessageIds[anchorIndex]
                  updateAssistantSettings({
                    fixedWindowAnchor: {
                      ...assistantSettings.fixedWindowAnchor,
                      [newTopic.id]: newAnchorId
                    }
                  })
                }
              }
            }
          }
        } else {
          logger.error(`[NEW_BRANCH] Failed to create topic branch for topic ${newTopic.id}`)
          window.toast.error(t('message.branch.error'))
        }
      }),
      EventEmitter.on(
        EVENT_NAMES.EDIT_CODE_BLOCK,
        async (data: { msgBlockId: string; codeBlockId: string; newContent: string }) => {
          const { msgBlockId, codeBlockId, newContent } = data

          const msgBlock = messageBlocksSelectors.selectById(store.getState(), msgBlockId)

          // FIXME: 目前 error block 没有 content
          if (msgBlock && isTextLikeBlock(msgBlock) && msgBlock.type !== MessageBlockType.ERROR) {
            try {
              const updatedRaw = updateCodeBlock(msgBlock.content, codeBlockId, newContent)
              const updatedBlock: MessageBlock = {
                ...msgBlock,
                content: updatedRaw,
                updatedAt: new Date().toISOString()
              }

              dispatch(updateOneBlock({ id: msgBlockId, changes: { content: updatedRaw } }))
              await dispatch(updateMessageAndBlocksThunk(topic.id, null, [updatedBlock]))

              window.toast.success(t('code_block.edit.save.success'))
            } catch (error) {
              logger.error(
                `Failed to save code block ${codeBlockId} content to message block ${msgBlockId}:`,
                error as Error
              )
              window.toast.error(t('code_block.edit.save.failed.label'))
            }
          } else {
            logger.error(
              `Failed to save code block ${codeBlockId} content to message block ${msgBlockId}: no such message block or the block doesn't have a content field`
            )
            window.toast.error(t('code_block.edit.save.failed.label'))
          }
        }
      )
    ]

    return () => unsubscribes.forEach((unsub) => unsub())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant, dispatch, scrollToBottom, topic, isProcessingContext])

  useEffect(() => {
    void runAsyncFunction(async () => {
      void EventEmitter.emit(EVENT_NAMES.ESTIMATED_TOKEN_COUNT, {
        tokensCount: await estimateHistoryTokens(assistant, messages),
        contextCount: getContextCount(assistant, messages, topic.id)
      })
    }).then(() => onFirstUpdate?.())
  }, [assistant, messages, onFirstUpdate, topic.id])

  useShortcut('copy_last_message', () => {
    const lastMessage = messages.at(-1)
    if (lastMessage) {
      void navigator.clipboard.writeText(getMainTextContent(lastMessage))
      window.toast.success(t('message.copy.success'))
    }
  })

  useShortcut('edit_last_user_message', () => {
    const lastUserMessage = messagesRef.current.findLast((m) => m.role === 'user' && m.type !== 'clear')
    if (lastUserMessage) {
      void EventEmitter.emit(EVENT_NAMES.EDIT_MESSAGE, lastUserMessage.id)
    }
  })

  useEffect(() => {
    requestAnimationFrame(() => onComponentUpdate?.())
  }, [onComponentUpdate])

  // Show a loading indicator while topic messages are being fetched from IndexedDB
  if (isLoading && messages.length === 0) {
    return (
      <EditModeProvider topicId={topic.id} scrollToGroup={scrollToGroup} visibleGroupIds={visibleGroupIds}>
        <MessagesContainer id="messages" className="messages-container" ref={scrollContainerRef}>
          <NarrowLayout>
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
              <Spin />
            </div>
          </NarrowLayout>
        </MessagesContainer>
      </EditModeProvider>
    )
  }

  return (
    <EditModeProvider topicId={topic.id} scrollToGroup={scrollToGroup} visibleGroupIds={visibleGroupIds}>
      <MessagesContent
        assistant={assistant}
        topic={topic}
        scrollContainerRef={scrollContainerRef}
        handleScrollPosition={handleScrollPosition}
        messages={messages}
        groupedMessages={groupedMessages}
        registerMessageElement={registerMessageElement}
        virtuosoRef={virtuosoRef}
        scrollParentEl={scrollParentEl}
        initialTopMostItemIndex={initialTopMostItemIndex}
      />
    </EditModeProvider>
  )
}

// NOTE: 编辑模式下每个消息组独立包裹选区样式（box-shadow），
// 不再将连续选中的多个组合并到单个 SelectionBlock 中。
// 这是 Virtuoso 虚拟化的限制：每个 item 独立渲染，无法跨 item 合并 DOM 包裹。
const VirtuosoItemWrapper = styled.div<{ $isSelected?: boolean }>`
  ${(props) =>
    props.$isSelected &&
    `
    box-shadow: 0 0 0 1.5px var(--color-primary);
    border-radius: 10px;
    margin: 2px 0;
  `}
`

const ContextWindowDivider = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  margin: 4px 0;
`

const ContextWindowDividerLine = styled.div`
  flex: 1;
  height: 1px;
  background: var(--color-border);
`

const ContextWindowDividerText = styled.span`
  font-size: 12px;
  color: var(--color-text-3);
  white-space: nowrap;
`

export default Messages
