import { loggerService } from '@logger'
import ContextMenu from '@renderer/components/ContextMenu'
import EditModeActionBar from '@renderer/components/EditModeActionBar'
import EditModeContextMenu from '@renderer/components/EditModeContextMenu'
import { LoadingIcon } from '@renderer/components/Icons'
import { LOAD_MORE_COUNT } from '@renderer/config/constant'
import { EditModeProvider, useEditMode } from '@renderer/context/EditModeContext'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useClipboardKeyboard } from '@renderer/hooks/useClipboardKeyboard'
import { useMessageOperations, useTopicLoading, useTopicMessages } from '@renderer/hooks/useMessageOperations'
import useScrollPosition from '@renderer/hooks/useScrollPosition'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTimer } from '@renderer/hooks/useTimer'
import { autoRenameTopic } from '@renderer/hooks/useTopic'
import { useTopicSegments } from '@renderer/hooks/useTopicSegments'
import { getBranchEndpoint } from '@renderer/pages/home/Messages/messageBranch'
import { createMessageViewportGroupModel } from '@renderer/pages/home/Messages/messageGroups'
import {
  applyColumnReverseScroll,
  type BootstrapPhase,
  canHandleUserViewportScroll,
  chooseNavigationWindow,
  handlePendingNavigateEvent,
  type MessageNavigationIntent,
  resolveAdjacentUserMessage,
  resolveBootstrapDecision,
  resolveMessageNavigation,
  runMessageNavigationTransaction,
  shouldPersistNavigationResult
} from '@renderer/pages/home/Messages/messageNavigation'
import {
  createMessageViewportState,
  type MessageViewportLoadDirection,
  type MessageViewportLoadToken,
  type MessageViewportNavigationToken,
  messageViewportReducer,
  type MessageViewportScrollMode,
  type MessageViewportScrollToken
} from '@renderer/pages/home/Messages/messageViewportReducer'
import {
  createLatestMessageWindow,
  expandMessageWindowNewer,
  expandMessageWindowOlder,
  type MessageWindow,
  reconcileMessageWindow
} from '@renderer/pages/home/Messages/messageWindow'
import SelectionBox from '@renderer/pages/home/Messages/SelectionBox'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import {
  clearPendingNavigate,
  getContextCount,
  getPendingNavigate,
  getUserMessage
} from '@renderer/services/MessagesService'
import { estimateHistoryTokens } from '@renderer/services/TokenService'
import store, { useAppDispatch } from '@renderer/store'
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
import { scrollIntoView } from '@renderer/utils/dom'
import { updateCodeBlock } from '@renderer/utils/markdown'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { isTextLikeBlock } from '@renderer/utils/messageUtils/is'
import { last } from 'lodash'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import InfiniteScroll from 'react-infinite-scroll-component'
import styled from 'styled-components'

import MessageAnchorLine from './MessageAnchorLine'
import MessageGroup from './MessageGroup'
import NarrowLayout from './NarrowLayout'
import Prompt from './Prompt'
import { MessagesContainer, ScrollContainer } from './shared'
import TopicSegmentLine from './TopicSegmentLine'
import { createViewportCommitWaiter } from './viewportCommitWaiter'

interface MessagesProps {
  assistant: Assistant
  topic: Topic
  setActiveTopic: (topic: Topic) => void
  onComponentUpdate?(): void
  onFirstUpdate?(): void
}

export interface MessagesHandle {
  scrollToMessageById: (messageId: string) => void
  scrollToBottom: () => void
  scrollToTop: () => void
  previousUserMessage: (currentMessageId: string) => void
  nextUserMessage: (currentMessageId: string) => void
}

/**
 * Find the first visible message element in the scroll container.
 * Returns the element and its bounding rect, or null if not found.
 */
const findFirstVisibleMessage = (
  container: HTMLElement | null,
  elements: Map<string, HTMLElement>
): { element: HTMLElement; rect: DOMRect } | null => {
  if (!container) return null
  const containerRect = container.getBoundingClientRect()

  let closest: { element: HTMLElement; rect: DOMRect } | null = null
  let minDistance = Infinity
  for (const el of elements.values()) {
    const rect = el.getBoundingClientRect()
    const distance = Math.abs(rect.top - containerRect.top)
    if (distance < minDistance) {
      minDistance = distance
      closest = { element: el, rect }
    }
  }
  return closest
}

const logger = loggerService.withContext('Messages')

interface MessagesContentProps {
  assistant: Assistant
  topic: Topic
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  handleScrollPosition: () => void
  displayMessages: Message[]
  hasMore: boolean
  isLoadingMore: boolean
  isLoadingNewer: boolean
  loadMoreMessages: () => void
  registerMessageElement: (id: string, element: HTMLElement | null) => void
}

const MessagesContent: React.FC<MessagesContentProps> = ({
  assistant,
  topic,
  scrollContainerRef,
  handleScrollPosition,
  displayMessages,
  hasMore,
  isLoadingMore,
  isLoadingNewer,
  loadMoreMessages,
  registerMessageElement
}) => {
  const { showPrompt, messageNavigation } = useSettings()

  const { isEnabled: isEditMode, selectedGroupIds, handleGroupClick } = useEditMode()
  const { isMessageFirstInSegment, isMessageLastInSegment, isMessageInSegment } = useTopicSegments(topic.id)
  useClipboardKeyboard()

  // NOTE: displayMessages is reversed, so each group's messages must be restored to chronological order for rendering.
  const groupedMessages = useMemo(() => {
    return createMessageViewportGroupModel(displayMessages).groups.map(
      (group) =>
        [
          group.key,
          group.messages.map((message, offset) => ({ ...message, index: group.range.start + offset })).toReversed()
        ] as const
    )
  }, [displayMessages])

  // 将消息按是否选中分段，用于连续选中消息的包裹
  const messageSegments = useMemo(() => {
    const segments: Array<{ selected: boolean; items: typeof groupedMessages }> = []

    for (const [key, groupMessages] of groupedMessages) {
      const groupAskId = groupMessages[0]?.askId || groupMessages[0]?.id || ''
      const selected = isEditMode && selectedGroupIds.includes(groupAskId)

      const lastSeg = segments[segments.length - 1]
      if (lastSeg && lastSeg.selected === selected) {
        lastSeg.items.push([key, groupMessages])
      } else {
        segments.push({ selected, items: [[key, groupMessages]] })
      }
    }

    return segments
  }, [groupedMessages, isEditMode, selectedGroupIds])

  const renderMessageSegments = () => {
    const result: React.ReactNode[] = []

    for (const seg of messageSegments) {
      const content = seg.items.map(([key, groupMessages]) => {
        const firstMsg = groupMessages[0]
        const segment = firstMsg ? isMessageInSegment(firstMsg.id) : undefined
        const isFirst = firstMsg ? !!isMessageFirstInSegment(firstMsg.id) : false
        const lastMsg = groupMessages[groupMessages.length - 1]
        const isLast = lastMsg ? !!isMessageLastInSegment(lastMsg.id) : false

        return (
          <div key={key} style={{ position: 'relative' }}>
            {segment && (
              <TopicSegmentLine
                segment={segment}
                isFirst={isFirst}
                isLast={isLast}
                messageCount={isFirst ? segment.messageIds.length : undefined}
              />
            )}
            <MessageGroup
              messages={groupMessages}
              topic={topic}
              registerMessageElement={registerMessageElement}
              isEditMode={isEditMode}
              onGroupClick={handleGroupClick}
            />
          </div>
        )
      })

      if (seg.selected) {
        result.push(<SelectionBlock key={`sel-${result.length}`}>{content}</SelectionBlock>)
      } else {
        result.push(content)
      }
    }

    return result
  }

  return (
    <MessagesContainer
      id="messages"
      className="messages-container"
      ref={scrollContainerRef}
      key={assistant.id}
      onScroll={handleScrollPosition}>
      <NarrowLayout style={{ display: 'flex', flexDirection: 'column-reverse' }}>
        <InfiniteScroll
          dataLength={displayMessages.length}
          next={loadMoreMessages}
          hasMore={hasMore}
          loader={null}
          scrollableTarget="messages"
          inverse
          style={{ overflow: 'visible' }}>
          {isEditMode ? (
            <EditModeContextMenu topicId={topic.id}>
              <ScrollContainer>
                {isLoadingNewer && (
                  <LoaderContainer>
                    <LoadingIcon color="var(--color-text-2)" />
                  </LoaderContainer>
                )}
                {renderMessageSegments()}
                {isLoadingMore && (
                  <LoaderContainer>
                    <LoadingIcon color="var(--color-text-2)" />
                  </LoaderContainer>
                )}
              </ScrollContainer>
            </EditModeContextMenu>
          ) : (
            <ContextMenu>
              <ScrollContainer>
                {isLoadingNewer && (
                  <LoaderContainer>
                    <LoadingIcon color="var(--color-text-2)" />
                  </LoaderContainer>
                )}
                {renderMessageSegments()}
                {isLoadingMore && (
                  <LoaderContainer>
                    <LoadingIcon color="var(--color-text-2)" />
                  </LoaderContainer>
                )}
              </ScrollContainer>
            </ContextMenu>
          )}
        </InfiniteScroll>

        {showPrompt && <Prompt assistant={assistant} key={assistant.prompt} topic={topic} />}
      </NarrowLayout>
      {messageNavigation === 'anchor' && <MessageAnchorLine messages={displayMessages} />}
      {isEditMode && <EditModeActionBar />}
    </MessagesContainer>
  )
}

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
    handleScroll: handleScrollPosition,
    getSavedPosition,
    clearSavedPosition,
    savePosition
  } = useScrollPosition(`topic-${topic.id}`)
  const [viewportState, reduceViewport] = useReducer(messageViewportReducer, null, createMessageViewportState)
  const displayMessages = useMemo(() => viewportState.window?.displayMessages ?? [], [viewportState.window])
  const hasMore = viewportState.window?.hasMoreOlder ?? false
  const hasMoreNewer = viewportState.window?.hasMoreNewer ?? false
  const isLoadingMore = viewportState.loading.older
  const isLoadingNewer = viewportState.loading.newer
  const [isProcessingContext, setIsProcessingContext] = useState(false)

  const { addTopic } = useAssistant(assistant.id)
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const messages = useTopicMessages(topic.id)
  const isTopicLoading = useTopicLoading(topic)
  const { displayCount, clearTopicMessages, deleteMessage, createTopicBranch, editMessage } =
    useMessageOperations(topic)
  const { setTimeoutTimer, clearTimeoutTimer } = useTimer()

  const { isMultiSelectMode, handleSelectMessage } = useChatContext(topic)

  const messageElements = useRef<Map<string, HTMLElement>>(new Map())
  const messagesRef = useRef<Message[]>(messages)
  const previousMessagesRef = useRef<Message[]>(messages)
  const viewportStateRef = useRef(viewportState)
  const viewportCommitWaiterRef = useRef(createViewportCommitWaiter<typeof viewportState>())
  useLayoutEffect(() => {
    viewportStateRef.current = viewportState
    viewportCommitWaiterRef.current.notify(viewportState)
  }, [viewportState])
  const prevTopicIdRef = useRef(topic.id)
  const savedRestoreHandledRef = useRef(false)
  const bootstrapPhaseRef = useRef<BootstrapPhase>('idle')

  const viewportDispatch = reduceViewport

  const waitForNavigationCommit = useCallback((token: MessageViewportNavigationToken, generation: number) => {
    return viewportCommitWaiterRef.current.wait(viewportStateRef.current, (committedState) => {
      if (committedState.navigation.token === token) return true
      if (committedState.navigation.generation > generation) return false
      return null
    })
  }, [])

  const beginScroll = useCallback(
    (mode: Exclude<MessageViewportScrollMode, 'user'>, token: MessageViewportScrollToken) => {
      const initialState = viewportStateRef.current
      const committed = viewportCommitWaiterRef.current.wait(initialState, (committedState) => {
        if (committedState.scrollToken === token && committedState.scrollMode === mode) return true
        if (committedState.topicGeneration !== initialState.topicGeneration) return false
        if (committedState.scrollGeneration > initialState.scrollGeneration + 1) return false
        return null
      })
      viewportDispatch({ type: 'scroll/begin', mode, token })
      return committed
    },
    [viewportDispatch]
  )

  const applyMessageWindow = useCallback(
    (window: MessageWindow) => {
      viewportDispatch({ type: 'window/apply', window })
    },
    [viewportDispatch]
  )

  const isCurrentNavigation = useCallback(
    (token: MessageViewportNavigationToken) => viewportStateRef.current.navigation.token === token,
    []
  )

  const isCurrentLoad = useCallback(
    (direction: MessageViewportLoadDirection, token: MessageViewportLoadToken, topicGeneration: number) => {
      const load = viewportStateRef.current.loads[direction]
      return load.token === token && load.topicGeneration === topicGeneration
    },
    []
  )

  const cancelActiveLoads = useCallback(() => {
    const state = viewportStateRef.current
    for (const direction of ['older', 'newer'] as const) {
      const load = state.loads[direction]
      if (load.active && load.token) {
        viewportDispatch({ type: 'load/cancel', direction, token: load.token, topicGeneration: load.topicGeneration })
      }
    }
  }, [viewportDispatch])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    const viewportCommitWaiter = viewportCommitWaiterRef.current

    return () => {
      viewportCommitWaiter.cancelAll()
      viewportDispatch({ type: 'navigation/cancel' })
      cancelActiveLoads()
    }
  }, [cancelActiveLoads, viewportDispatch])

  const registerMessageElement = useCallback((id: string, element: HTMLElement | null) => {
    if (element) {
      messageElements.current.set(id, element)
    } else {
      messageElements.current.delete(id)
    }
  }, [])

  /**
   * Switch foldSelected for the message group containing the target message.
   * Used by the centralized NAVIGATE_TO_MESSAGE handler to unfold hidden messages.
   * Awaits all editMessage calls so the caller can wait for the UI to update.
   */
  const selectMessageForFold = useCallback(
    async (messageId: string) => {
      const allMessages = messagesRef.current
      const targetMessage = allMessages.find((m) => m.id === messageId)
      if (!targetMessage || !targetMessage.askId || targetMessage.role !== 'assistant') return

      const groupMessages = allMessages.filter((m) => m.role === 'assistant' && m.askId === targetMessage.askId)
      if (groupMessages.length <= 1) return

      await Promise.all(groupMessages.map((m) => editMessage(m.id, { foldSelected: m.id === messageId })))
    },
    [editMessage]
  )

  useEffect(() => {
    // Only bump generation on topic switch, not on every messages change.
    // This prevents selectMessageForFold (which calls editMessage → messages update)
    // from cancelling an in-flight navigation.
    if (prevTopicIdRef.current !== topic.id) {
      prevTopicIdRef.current = topic.id
      savedRestoreHandledRef.current = false
      bootstrapPhaseRef.current = 'idle'
      clearTimeoutTimer('loadMoreMessages')
      clearTimeoutTimer('loadNewerMessages')
      viewportDispatch({ type: 'topic/reset', window: createLatestMessageWindow([], displayCount) })
      return
    }

    // Scenario 1: First load
    if (!viewportStateRef.current.window?.displayMessages.length) {
      applyMessageWindow(createLatestMessageWindow(messages, displayCount))
      return
    }

    // Scenario 2: Reconcile the existing fixed window against the latest
    // message objects. Only a window that previously touched the latest edge
    // follows newly appended messages, retaining its prior group capacity.
    const currentWindow = viewportStateRef.current.window
    if (!currentWindow) return
    const currentDisplayMessages = currentWindow.displayMessages
    const reconciledWindow = reconcileMessageWindow(messages, previousMessagesRef.current, currentWindow)
    const newDisplayMessages = reconciledWindow.displayMessages

    if (!areMessageArraysIdentical(currentDisplayMessages, newDisplayMessages) || currentWindow !== reconciledWindow) {
      applyMessageWindow(reconciledWindow)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, displayCount])

  useEffect(() => {
    previousMessagesRef.current = messages
  }, [messages])

  /**
   * Check the DOM status of a message element.
   * - 'visible': element exists and is displayed
   * - 'hidden': element exists but is hidden (e.g. by fold)
   * - 'missing': element not in DOM (needs loading)
   */
  const checkElement = useCallback((messageId: string): 'visible' | 'hidden' | 'missing' => {
    const el = document.getElementById(`message-${messageId}`)
    if (!el) return 'missing'
    if (window.getComputedStyle(el).display === 'none') return 'hidden'
    return 'visible'
  }, [])

  const settleNavigationDom = useCallback(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
    []
  )

  const cancelNavigationLoadsAndTimers = useCallback(() => {
    clearTimeoutTimer('loadMoreMessages')
    clearTimeoutTimer('loadNewerMessages')
    cancelActiveLoads()
  }, [cancelActiveLoads, clearTimeoutTimer])

  const navigate = useCallback(
    (intent: MessageNavigationIntent) =>
      runMessageNavigationTransaction(intent, {
        begin: (token, targetId, source, alignment) => {
          const generation = viewportStateRef.current.navigation.generation
          const committed = waitForNavigationCommit(token, generation)
          viewportDispatch({ type: 'navigation/begin', token, targetId, source, alignment })
          return committed
        },
        isCurrent: isCurrentNavigation,
        cancelLoadsAndTimers: cancelNavigationLoadsAndTimers,
        resolve: (requestedIntent) => resolveMessageNavigation(messagesRef.current, requestedIntent),
        prepareWindow: (resolved) =>
          chooseNavigationWindow(messagesRef.current, viewportStateRef.current.window, resolved, displayCount),
        applyWindow: (token, window) => {
          const initialState = viewportStateRef.current
          const committed = viewportCommitWaiterRef.current.wait(initialState, (committedState) => {
            if (committedState.navigation.token !== token) return false
            return committedState.window === window ? true : null
          })
          viewportDispatch({ type: 'navigation/apply-window', token, window })
          return committed
        },
        getTargetStatus: checkElement,
        revealTarget: selectMessageForFold,
        settleDom: settleNavigationDom,
        beginProgrammaticScroll: async (token) => {
          viewportDispatch({ type: 'navigation/phase', token, phase: 'scrolling' })
          return beginScroll('programmatic', {})
        },
        scroll: (resolved) => {
          applyColumnReverseScroll(resolved, scrollContainerRef.current, (targetId, alignment) => {
            const target = document.getElementById(`message-${targetId}`)
            if (target) scrollIntoView(target, { behavior: 'auto', block: alignment, container: 'nearest' })
          })
        },
        finish: (token) => viewportDispatch({ type: 'navigation/finish', token }),
        cancel: (token) => viewportDispatch({ type: 'navigation/cancel', token })
      }),
    [
      beginScroll,
      cancelNavigationLoadsAndTimers,
      checkElement,
      displayCount,
      isCurrentNavigation,
      scrollContainerRef,
      selectMessageForFold,
      settleNavigationDom,
      viewportDispatch,
      waitForNavigationCommit
    ]
  )

  /**
   * User-initiated navigate-and-save: runs a navigation transaction and
   * persists the resulting scroll position on success.
   *
   * Only call this from user-initiated navigation entry points
   * (button clicks, keyboard shortcuts, message navigation).
   * Internal triggers (SEND_MESSAGE, NEW_CONTEXT, bootstrap restore)
   * must use `navigate` directly without persistence.
   */
  const navigateAndSave = useCallback(
    (intent: MessageNavigationIntent) => {
      void navigate(intent).then((result) => {
        if (shouldPersistNavigationResult(result)) savePosition()
      })
    },
    [navigate, savePosition]
  )

  // 滚动到指定消息组
  const scrollToGroup = useCallback(
    (askId: string) => {
      navigateAndSave({ kind: 'group', groupId: askId, source: 'group' })
    },
    [navigateAndSave]
  )

  // 已渲染的消息组 id 集合，用于限制键盘选择范围
  const visibleGroupIds = useMemo(() => {
    return new Set(
      displayMessages
        .map((m) => {
          if (m.role === 'assistant') {
            return m.askId ?? m.id
          }
          return m.id
        })
        .filter(Boolean)
    )
  }, [displayMessages])

  // NOTE: 如果设置为平滑滚动会导致滚动条无法跟随生成的新消息保持在底部位置
  const scrollToBottom = useCallback(() => {
    navigateAndSave({ kind: 'bottom', source: 'imperative' })
  }, [navigateAndSave])

  /** Internal auto-scroll without persistence — for SEND_MESSAGE / NEW_CONTEXT. */
  const autoScrollToBottom = useCallback(() => {
    void navigate({ kind: 'bottom', source: 'imperative' })
  }, [navigate])

  const scrollToTop = useCallback(() => {
    navigateAndSave({ kind: 'top', source: 'imperative' })
  }, [navigateAndSave])

  const scrollToMessageById = useCallback(
    (messageId: string) => {
      navigateAndSave({ kind: 'message', targetId: messageId, source: 'imperative' })
    },
    [navigateAndSave]
  )

  const previousUserMessage = useCallback(
    (currentMessageId: string) => {
      const targetId = resolveAdjacentUserMessage(messagesRef.current, currentMessageId, 'older')
      if (targetId) {
        navigateAndSave({ kind: 'message', targetId, source: 'imperative' })
      } else {
        navigateAndSave({ kind: 'top', source: 'imperative' })
      }
    },
    [navigateAndSave]
  )

  const nextUserMessage = useCallback(
    (currentMessageId: string) => {
      const targetId = resolveAdjacentUserMessage(messagesRef.current, currentMessageId, 'newer')
      if (targetId) {
        navigateAndSave({ kind: 'message', targetId, source: 'imperative' })
      } else {
        navigateAndSave({ kind: 'bottom', source: 'imperative' })
      }
    },
    [navigateAndSave]
  )

  useImperativeHandle(ref, () => ({
    scrollToMessageById,
    scrollToBottom,
    scrollToTop,
    previousUserMessage,
    nextUserMessage
  }))

  const clearTopic = useCallback(
    async (data: Topic) => {
      if (data && data.id !== topic.id) {
        await clearTopicMessages(data.id)
        return
      }

      await clearTopicMessages()
      clearTimeoutTimer('loadMoreMessages')
      clearTimeoutTimer('loadNewerMessages')
      viewportDispatch({ type: 'topic/reset', window: createLatestMessageWindow([], displayCount) })
      clearSavedPosition()
    },
    [clearTimeoutTimer, clearTopicMessages, topic.id, clearSavedPosition, displayCount, viewportDispatch]
  )

  useEffect(() => {
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.SEND_MESSAGE, autoScrollToBottom),
      EventEmitter.on(EVENT_NAMES.SCROLL_TO_BOTTOM, scrollToBottom),
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
          const messages = messagesRef.current

          if (messages.length === 0) {
            return
          }

          const lastMessage = last(messages)

          if (lastMessage?.type === 'clear') {
            await deleteMessage(lastMessage.id)
            autoScrollToBottom()
            return
          }

          const { message: clearMessage } = getUserMessage({ assistant, topic, type: 'clear' })
          dispatch(newMessagesActions.addMessage({ topicId: topic.id, message: clearMessage }))
          await saveMessageAndBlocksToDB(topic.id, clearMessage, [])

          autoScrollToBottom()
        } finally {
          setIsProcessingContext(false)
        }
      }),
      EventEmitter.on(EVENT_NAMES.NEW_BRANCH, async (messageId: string) => {
        const newTopic = getDefaultTopic(assistant.id)
        newTopic.name = topic.name
        const currentMessages = messagesRef.current

        const branchEndpoint = getBranchEndpoint(currentMessages, messageId)
        if (branchEndpoint === null) {
          logger.error(`[NEW_BRANCH] Message not found: ${messageId}`)
          return
        }

        addTopic(newTopic)

        const success = await createTopicBranch(topic.id, branchEndpoint, newTopic)

        if (success) {
          setActiveTopic(newTopic)
          void autoRenameTopic(assistant, newTopic.id)
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
      ),
      EventEmitter.on(EVENT_NAMES.NAVIGATE_TO_MESSAGE, async (messageId: string) => {
        const { source, result } = await handlePendingNavigateEvent(topic.id, messageId, {
          getPending: getPendingNavigate,
          clearPending: clearPendingNavigate,
          navigate,
          onDone: () => {
            bootstrapPhaseRef.current = 'done'
          }
        })
        if (shouldPersistNavigationResult(result)) savePosition()
        void source
      })
    ]

    return () => unsubscribes.forEach((unsub) => unsub())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant, dispatch, scrollToBottom, autoScrollToBottom, navigate, savePosition, topic, isProcessingContext])

  /**
   * Unified topic bootstrap: determines the initial navigation intent with strict priority.
   *   matching pending > saved restore > default (latest)
   * Only one transaction is started per mount cycle. A pending that is cancelled is
   * preserved so it can be retried on the next trigger (messages/loading change) without
   * busy-looping. A pending that succeeds or resolves not-found is cleared by expected
   * identity so a newer pending is never consumed by a stale transaction.
   */
  useEffect(() => {
    const decision = resolveBootstrapDecision({
      phase: bootstrapPhaseRef.current,
      isTopicLoading,
      topicId: topic.id,
      pending: getPendingNavigate(),
      savedPosition: savedRestoreHandledRef.current ? null : getSavedPosition(),
      savedRestoreHandled: savedRestoreHandledRef.current
    })

    if (decision.action === 'wait' || decision.action === 'done') {
      if (decision.action === 'done') bootstrapPhaseRef.current = 'done'
      return
    }

    if (decision.action === 'pending') {
      const pending = getPendingNavigate()!
      bootstrapPhaseRef.current = 'pending-in-flight'
      void navigate(decision.intent).then((result) => {
        if (result !== 'cancelled') {
          clearPendingNavigate(pending)
          bootstrapPhaseRef.current = 'done'
          if (shouldPersistNavigationResult(result)) savePosition()
        } else {
          // Pending was cancelled by a newer navigation (user scroll, anchor click, etc.).
          // Mark as done to prevent automatic retry on the next messages change.
          // The pending data is preserved in pendingNavigate for future explicit
          // re-bootstrap via locateToMessage or a new NAVIGATE_TO_MESSAGE event.
          // Deterministic triggers (topic loading completion, new pending identity)
          // are handled by the NAVIGATE_TO_MESSAGE event path or component remount.
          bootstrapPhaseRef.current = 'done'
        }
      })
      return
    }

    // action === 'restore'
    savedRestoreHandledRef.current = true
    bootstrapPhaseRef.current = 'done'
    void navigate(decision.intent)
  }, [isTopicLoading, messages, navigate, savePosition, topic.id, getSavedPosition])

  useEffect(() => {
    void runAsyncFunction(async () => {
      void EventEmitter.emit(EVENT_NAMES.ESTIMATED_TOKEN_COUNT, {
        tokensCount: await estimateHistoryTokens(assistant, messages),
        contextCount: getContextCount(assistant, messages)
      })
    }).then(() => onFirstUpdate?.())
  }, [assistant, messages, onFirstUpdate])

  const loadMoreMessages = useCallback(() => {
    const currentState = viewportStateRef.current
    if (!canHandleUserViewportScroll(currentState) || !currentState.window?.hasMoreOlder || currentState.loading.older)
      return

    const loadToken = {}
    const topicGeneration = currentState.topicGeneration
    viewportDispatch({ type: 'load/start', direction: 'older', token: loadToken })

    const container = scrollContainerRef.current
    const anchor = findFirstVisibleMessage(container, messageElements.current)

    setTimeoutTimer(
      'loadMoreMessages',
      () => {
        if (!isCurrentLoad('older', loadToken, topicGeneration)) return
        const allMessages = messagesRef.current
        const currentWindow = viewportStateRef.current.window
        if (!currentWindow) {
          viewportDispatch({ type: 'load/cancel', direction: 'older', token: loadToken, topicGeneration })
          return
        }
        const olderWindow = expandMessageWindowOlder(allMessages, currentWindow, LOAD_MORE_COUNT)

        viewportDispatch({
          type: 'load/finish',
          direction: 'older',
          token: loadToken,
          topicGeneration,
          window: olderWindow
        })

        if (anchor) {
          requestAnimationFrame(async () => {
            if (!isCurrentLoad('older', loadToken, topicGeneration)) return
            if (container && anchor.element && anchor.element.isConnected) {
              const newRect = anchor.element.getBoundingClientRect()
              const delta = newRect.top - anchor.rect.top
              if (Math.abs(delta) > 1) {
                const scrollToken = {}
                if (!(await beginScroll('anchoring', scrollToken))) return
                if (!isCurrentLoad('older', loadToken, topicGeneration) || !anchor.element.isConnected) {
                  viewportDispatch({ type: 'scroll/end', token: scrollToken })
                  return
                }
                container.scrollTop += delta
                requestAnimationFrame(() => {
                  viewportDispatch({ type: 'scroll/end', token: scrollToken })
                })
              }
            }
          })
        }
      },
      50
    )
  }, [beginScroll, isCurrentLoad, setTimeoutTimer, scrollContainerRef, viewportDispatch])

  const loadNewerMessages = useCallback(() => {
    const currentState = viewportStateRef.current
    if (!canHandleUserViewportScroll(currentState) || !currentState.window?.hasMoreNewer || currentState.loading.newer)
      return

    const loadToken = {}
    const topicGeneration = currentState.topicGeneration
    viewportDispatch({ type: 'load/start', direction: 'newer', token: loadToken })

    const container = scrollContainerRef.current
    const anchor = findFirstVisibleMessage(container, messageElements.current)

    setTimeoutTimer(
      'loadNewerMessages',
      () => {
        if (!isCurrentLoad('newer', loadToken, topicGeneration)) return
        const allMessages = messagesRef.current
        const currentWindow = viewportStateRef.current.window
        if (!currentWindow) {
          viewportDispatch({ type: 'load/cancel', direction: 'newer', token: loadToken, topicGeneration })
          return
        }
        const newerWindow = expandMessageWindowNewer(allMessages, currentWindow, LOAD_MORE_COUNT)

        viewportDispatch({
          type: 'load/finish',
          direction: 'newer',
          token: loadToken,
          topicGeneration,
          window: newerWindow
        })

        if (anchor) {
          requestAnimationFrame(async () => {
            if (!isCurrentLoad('newer', loadToken, topicGeneration)) return
            if (container && anchor.element && anchor.element.isConnected) {
              const newRect = anchor.element.getBoundingClientRect()
              const delta = newRect.top - anchor.rect.top
              if (Math.abs(delta) > 1) {
                const scrollToken = {}
                if (!(await beginScroll('anchoring', scrollToken))) return
                if (!isCurrentLoad('newer', loadToken, topicGeneration) || !anchor.element.isConnected) {
                  viewportDispatch({ type: 'scroll/end', token: scrollToken })
                  return
                }
                container.scrollTop += delta
                requestAnimationFrame(() => {
                  viewportDispatch({ type: 'scroll/end', token: scrollToken })
                })
              }
            }
          })
        }
      },
      50
    )
  }, [beginScroll, isCurrentLoad, setTimeoutTimer, scrollContainerRef, viewportDispatch])

  const handleScroll = useCallback(() => {
    const currentState = viewportStateRef.current
    if (!canHandleUserViewportScroll(currentState)) return

    handleScrollPosition()

    const container = scrollContainerRef.current
    if (container && hasMoreNewer && !isLoadingNewer && !isLoadingMore) {
      // In column-reverse layout, bottom is scrollTop ≈ 0 (or small negative values)
      // Scrolling toward older messages increases scrollTop (positive direction)
      const distanceFromBottom = Math.abs(container.scrollTop)
      if (distanceFromBottom < 150) {
        loadNewerMessages()
      }
    }
  }, [handleScrollPosition, hasMoreNewer, isLoadingNewer, isLoadingMore, loadNewerMessages, scrollContainerRef])

  useShortcut('copy_last_message', () => {
    const lastMessage = last(messages)
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

  return (
    <EditModeProvider topicId={topic.id} scrollToGroup={scrollToGroup} visibleGroupIds={visibleGroupIds}>
      <MessagesContent
        assistant={assistant}
        topic={topic}
        scrollContainerRef={scrollContainerRef}
        handleScrollPosition={handleScroll}
        displayMessages={displayMessages}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        isLoadingNewer={isLoadingNewer}
        loadMoreMessages={loadMoreMessages}
        registerMessageElement={registerMessageElement}
      />
      <SelectionBox
        isMultiSelectMode={isMultiSelectMode}
        scrollContainerRef={scrollContainerRef}
        messageElements={messageElements.current}
        handleSelectMessage={handleSelectMessage}
      />
    </EditModeProvider>
  )
}

const areMessageArraysIdentical = (left: Message[], right: Message[]): boolean =>
  left.length === right.length && left.every((message, index) => message === right[index])

const LoaderContainer = styled.div`
  display: flex;
  justify-content: center;
  padding: 10px;
  width: 100%;
  background: var(--color-background);
  pointer-events: none;
`

const SelectionBlock = styled.div`
  display: flex;
  flex-direction: column-reverse;
  box-shadow: 0 0 0 1.5px var(--color-primary);
  border-radius: 10px;
`

export default Messages
