import { loggerService } from '@logger'
import ContextMenu from '@renderer/components/ContextMenu'
import EditModeActionBar from '@renderer/components/EditModeActionBar'
import EditModeContextMenu from '@renderer/components/EditModeContextMenu'
import { LoadingIcon } from '@renderer/components/Icons'
import { INITIAL_MESSAGES_COUNT, LOAD_MORE_COUNT, SCROLL_CONTEXT_COUNT } from '@renderer/config/constant'
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
import SelectionBox from '@renderer/pages/home/Messages/SelectionBox'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import {
  clearPendingNavigate,
  getContextCount,
  getGroupedMessages,
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
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import InfiniteScroll from 'react-infinite-scroll-component'
import styled from 'styled-components'

import MessageAnchorLine from './MessageAnchorLine'
import MessageGroup from './MessageGroup'
import NarrowLayout from './NarrowLayout'
import Prompt from './Prompt'
import { MessagesContainer, ScrollContainer } from './shared'
import TopicSegmentLine from './TopicSegmentLine'

interface MessagesProps {
  assistant: Assistant
  topic: Topic
  setActiveTopic: (topic: Topic) => void
  onComponentUpdate?(): void
  onFirstUpdate?(): void
}

export interface MessagesHandle {
  scrollToMessageById: (messageId: string) => void
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
const SAVED_RESTORE_VISUALLY_OLDER_GROUPS = 10
const SAVED_RESTORE_VISUALLY_NEWER_GROUPS = 19

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

  // NOTE: 因为displayMessages是倒序的，所以得到的groupedMessages每个group内部也是倒序的，需要再倒一遍
  const groupedMessages = useMemo(() => {
    const grouped = Object.entries(getGroupedMessages(displayMessages))
    const newGrouped: {
      [key: string]: (Message & {
        index: number
      })[]
    } = {}
    grouped.forEach(([key, group]) => {
      newGrouped[key] = group.toReversed()
    })
    return Object.entries(newGrouped)
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
    clearSavedPosition
  } = useScrollPosition(`topic-${topic.id}`)
  const [displayMessages, setDisplayMessages] = useState<Message[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [hasMoreNewer, setHasMoreNewer] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [isLoadingNewer, setIsLoadingNewer] = useState(false)
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
  const jumpTargetRef = useRef<string | null>(null)
  const lastDisplayMessagesRef = useRef<Message[]>([])
  const selectMessageForFoldRef = useRef<(messageId: string) => Promise<void>>(() => Promise.resolve())
  const navigateGenerationRef = useRef(0)
  const prevTopicIdRef = useRef(topic.id)
  const isProgrammaticScrollRef = useRef(false)
  const handleNavigateToMessageRef = useRef<
    (messageId: string, options?: { generation?: number; windowPrepared?: boolean }) => Promise<void>
  >(async () => {})

  // On mount (topic switch), check if we need to restore to a specific message
  useEffect(() => {
    const saved = getSavedPosition()
    if (saved?.isAtBottom) {
      // Bottom state: initialize window with latest messages, then scrollToBottom after DOM commit
      const newDisplayMessages = computeDisplayMessages(messages, 0, INITIAL_MESSAGES_COUNT)
      setDisplayMessages(newDisplayMessages)
      lastDisplayMessagesRef.current = newDisplayMessages
      setHasMore(messages.length > INITIAL_MESSAGES_COUNT)
      setHasMoreNewer(false)
      requestAnimationFrame(() => {
        scrollToBottom()
      })
      return
    } else if (saved?.anchorId) {
      jumpTargetRef.current = saved.anchorId
    } else if (saved?.scrollTop !== undefined) {
      // Use !== undefined (not truthiness) because scrollTop can be 0
      requestAnimationFrame(() => {
        setTimeout(() => {
          scrollContainerRef.current?.scrollTo({ top: saved.scrollTop })
        }, 100)
      })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    const navigateGeneration = navigateGenerationRef

    return () => {
      navigateGeneration.current++
    }
  }, [])

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
    selectMessageForFoldRef.current = selectMessageForFold
  }, [selectMessageForFold])

  useEffect(() => {
    // Only bump generation on topic switch, not on every messages change.
    // This prevents selectMessageForFold (which calls editMessage → messages update)
    // from cancelling an in-flight navigation.
    if (prevTopicIdRef.current !== topic.id) {
      prevTopicIdRef.current = topic.id
      navigateGenerationRef.current++
    }

    // Scenario 1: Jump target (deep navigation / topic switch restore)
    if (jumpTargetRef.current) {
      const targetId = jumpTargetRef.current
      const targetExists = messages.some((message) => message.id === targetId)

      if (!targetExists) {
        // Keep the saved target pending while topic messages load. A subsequent
        // messages update re-runs this effect without a polling timer.
        if (isTopicLoading) return

        jumpTargetRef.current = null

        // Loading completed with an empty topic. Clear the stale target so the
        // normal empty-state initialization is no longer blocked.
        if (messages.length === 0) {
          if (lastDisplayMessagesRef.current.length > 0) {
            lastDisplayMessagesRef.current = []
            setDisplayMessages([])
          }
          setHasMore(false)
          setHasMoreNewer(false)
          return
        }

        // The saved target no longer belongs to the loaded topic. Fall back to
        // the normal latest-message initialization instead of leaving it empty.
        const latestMessages = computeDisplayMessages(messages, 0, displayCount)
        setDisplayMessages(latestMessages)
        lastDisplayMessagesRef.current = latestMessages
        setHasMore(latestMessages.at(-1)?.id !== messages[0]?.id)
        setHasMoreNewer(false)
        return
      }

      const generation = ++navigateGenerationRef.current
      const newDisplayMessages = computeSavedRestoreDisplayWindow(
        messages,
        targetId,
        SAVED_RESTORE_VISUALLY_OLDER_GROUPS,
        SAVED_RESTORE_VISUALLY_NEWER_GROUPS
      )
      const newestInWindow = newDisplayMessages[0]
      const oldestInWindow = newDisplayMessages[newDisplayMessages.length - 1]

      setDisplayMessages(newDisplayMessages)
      lastDisplayMessagesRef.current = newDisplayMessages
      setHasMore(oldestInWindow?.id !== messages[0]?.id)
      setHasMoreNewer(newestInWindow?.id !== messages.at(-1)?.id)
      jumpTargetRef.current = null

      // Wait for the target window to commit before revealing and positioning the message.
      requestAnimationFrame(() => {
        if (generation !== navigateGenerationRef.current) return
        void handleNavigateToMessageRef.current(targetId, { generation, windowPrepared: true })
      })
      return
    }

    // Scenario 2: First load
    if (lastDisplayMessagesRef.current.length === 0) {
      const newDisplayMessages = computeDisplayMessages(messages, 0, displayCount)
      setDisplayMessages(newDisplayMessages)
      lastDisplayMessagesRef.current = newDisplayMessages
      const { hasOlder, hasNewer } = getDisplayWindowBoundaries(messages, newDisplayMessages)
      setHasMore(hasOlder)
      setHasMoreNewer(hasNewer)
      return
    }

    // Scenario 3: Reconcile the existing fixed window against the latest
    // message objects. Only a window that previously touched the latest edge
    // follows newly appended messages, retaining its prior group capacity.
    const currentDisplayMessages = lastDisplayMessagesRef.current
    const reconciledMessages = reconcileDisplayWindow(messages, previousMessagesRef.current, currentDisplayMessages)
    const newDisplayMessages =
      reconciledMessages.length > 0 ? reconciledMessages : computeDisplayMessages(messages, 0, displayCount)
    const { hasOlder, hasNewer } = getDisplayWindowBoundaries(messages, newDisplayMessages)

    lastDisplayMessagesRef.current = newDisplayMessages
    if (!areMessageArraysIdentical(currentDisplayMessages, newDisplayMessages)) {
      setDisplayMessages(newDisplayMessages)
    }
    setHasMore(hasOlder)
    setHasMoreNewer(hasNewer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, displayCount, isTopicLoading])

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

  type NavigatePrepareResult = 'ready-existing' | 'ready-loaded' | false

  /**
   * Ensure the target message is rendered and visible in the DOM.
   * Prepares a unified navigation window for missing messages.
   * Handles fold switching for hidden messages.
   * Does NOT scroll — scrolling is handled by `handleNavigateToMessage`.
   */
  const scrollToTargetMessage = useCallback(
    async (messageId: string, generation: number, windowPrepared = false): Promise<NavigatePrepareResult> => {
      const allMessages = messagesRef.current

      // 1. Check if the message exists in this topic's messages
      if (!allMessages.some((m) => m.id === messageId)) {
        logger.warn(`[scrollToTargetMessage] Message ${messageId} not found in topic messages`)
        return false
      }

      // 2. Check if the target message is already rendered in DOM
      const initialStatus = checkElement(messageId)

      if (initialStatus === 'visible') return windowPrepared ? 'ready-loaded' : 'ready-existing'

      if (initialStatus === 'hidden') {
        await selectMessageForFoldRef.current(messageId)
        if (generation !== navigateGenerationRef.current) return false
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve())
          })
        })
        if (generation !== navigateGenerationRef.current) return false
        return checkElement(messageId) === 'visible' ? (windowPrepared ? 'ready-loaded' : 'ready-existing') : false
      }

      // Scenario 1 already committed the target window; never replace it a second time.
      if (windowPrepared) return false

      // 3. status === 'missing': Prepare the unified navigation window around the target
      // Compute a new window centered on the target message
      const startIndex = computeStartIndex(allMessages, messageId, SCROLL_CONTEXT_COUNT)
      const newDisplayMessages = computeDisplayMessages(allMessages, startIndex, INITIAL_MESSAGES_COUNT)
      setDisplayMessages(newDisplayMessages)
      lastDisplayMessagesRef.current = newDisplayMessages
      const { hasOlder, hasNewer } = getDisplayWindowBoundaries(allMessages, newDisplayMessages)
      setHasMore(hasOlder)
      setHasMoreNewer(hasNewer)

      // Wait for React to re-render
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve())
        })
      })
      if (generation !== navigateGenerationRef.current) return false

      // Check if the target message is now ready
      const status = checkElement(messageId)
      if (status === 'visible') return 'ready-loaded'

      if (status === 'hidden') {
        await selectMessageForFoldRef.current(messageId)
        if (generation !== navigateGenerationRef.current) return false
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve())
          })
        })
        if (generation !== navigateGenerationRef.current) return false
        return checkElement(messageId) === 'visible' ? 'ready-loaded' : false
      }

      return false
    },
    [checkElement]
  )

  /**
   * Centralized navigation handler for NAVIGATE_TO_MESSAGE events.
   * Ensures the target message is rendered (with fold handling), then scrolls to it.
   * Uses generation tracking to cancel stale navigations.
   */
  const handleNavigateToMessage = useCallback(
    async (messageId: string, options?: { generation?: number; windowPrepared?: boolean }) => {
      if (!options?.windowPrepared) {
        jumpTargetRef.current = null
        clearTimeoutTimer('pendingNavigate')
      }

      const generation = options?.generation ?? ++navigateGenerationRef.current
      if (generation !== navigateGenerationRef.current) return

      // Cancel any pending loadMore/loadNewer timers to prevent them from
      // overwriting the window reset that navigation is about to perform.
      clearTimeoutTimer('loadMoreMessages')
      clearTimeoutTimer('loadNewerMessages')
      setIsLoadingMore(false)
      setIsLoadingNewer(false)

      // 1. Ensure message is rendered in DOM (handles loading + fold switching)
      const ready = await scrollToTargetMessage(messageId, generation, options?.windowPrepared)
      if (!ready) return
      if (generation !== navigateGenerationRef.current) return

      // 2. Wait one extra frame for fold-related DOM updates to settle
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve())
      })
      if (generation !== navigateGenerationRef.current) return

      // 3. Scroll to the element with consistent behavior
      if (checkElement(messageId) !== 'visible') return

      const targetEl = document.getElementById(`message-${messageId}`)
      if (targetEl) {
        const behavior = ready === 'ready-loaded' ? 'auto' : 'smooth'
        isProgrammaticScrollRef.current = true
        scrollIntoView(targetEl, { behavior, block: 'start', container: 'nearest' })
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false
        })
      }
    },
    [checkElement, clearTimeoutTimer, scrollToTargetMessage]
  )

  useEffect(() => {
    handleNavigateToMessageRef.current = handleNavigateToMessage
  }, [handleNavigateToMessage])

  // 滚动到指定消息组
  const scrollToGroup = useCallback(
    async (askId: string) => {
      const allMessages = messagesRef.current
      const targetMessage = allMessages.find((m) => m.askId === askId || m.id === askId)
      if (targetMessage) {
        await handleNavigateToMessage(targetMessage.id)
      }
    },
    [handleNavigateToMessage]
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
    const current = lastDisplayMessagesRef.current
    const newestInWindow = current[0]
    const newestInArray = messages[messages.length - 1]

    if (newestInWindow?.id !== newestInArray?.id) {
      const newDisplayMessages = computeDisplayMessages(messages, 0, INITIAL_MESSAGES_COUNT)
      setDisplayMessages(newDisplayMessages)
      lastDisplayMessagesRef.current = newDisplayMessages
      const { hasOlder, hasNewer } = getDisplayWindowBoundaries(messages, newDisplayMessages)
      setHasMore(hasOlder)
      setHasMoreNewer(hasNewer)
    }

    if (scrollContainerRef.current) {
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          isProgrammaticScrollRef.current = true
          scrollContainerRef.current.scrollTo({ top: 0 })
          requestAnimationFrame(() => {
            isProgrammaticScrollRef.current = false
          })
        }
      })
    }
  }, [scrollContainerRef, messages])

  const scrollToMessageById = useCallback(
    (messageId: string) => {
      void handleNavigateToMessage(messageId)
    },
    [handleNavigateToMessage]
  )

  useImperativeHandle(ref, () => ({
    scrollToMessageById
  }))

  const clearTopic = useCallback(
    async (data: Topic) => {
      if (data && data.id !== topic.id) {
        await clearTopicMessages(data.id)
        return
      }

      await clearTopicMessages()
      setDisplayMessages([])
      lastDisplayMessagesRef.current = []
      setHasMoreNewer(false)
      setIsLoadingNewer(false)
      clearSavedPosition()
    },
    [clearTopicMessages, topic.id, clearSavedPosition]
  )

  useEffect(() => {
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.SEND_MESSAGE, scrollToBottom),
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

        addTopic(newTopic)

        const success = await createTopicBranch(topic.id, currentMessages.length - index, newTopic)

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
        if (!messagesRef.current.some((m) => m.id === messageId)) {
          return
        }
        clearPendingNavigate()
        await handleNavigateToMessage(messageId)
      })
    ]

    return () => unsubscribes.forEach((unsub) => unsub())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant, dispatch, scrollToBottom, handleNavigateToMessage, topic, isProcessingContext])

  // Check for pending cross-topic navigation on mount
  useEffect(() => {
    const pending = getPendingNavigate()
    if (!pending || pending.topicId !== topic.id) return

    const MAX_NAVIGATE_RETRIES = 50
    const generation = navigateGenerationRef.current
    let retryCount = 0

    const tryNavigate = () => {
      if (generation !== navigateGenerationRef.current) return
      if (messagesRef.current.some((m) => m.id === pending.messageId)) {
        clearPendingNavigate()
        void handleNavigateToMessage(pending.messageId)
      } else if (retryCount < MAX_NAVIGATE_RETRIES) {
        retryCount++
        setTimeoutTimer('pendingNavigate', tryNavigate, 100)
      } else {
        logger.warn('Pending navigate timed out after 5s', {
          messageId: pending.messageId,
          topicId: pending.topicId
        })
        clearPendingNavigate()
      }
    }

    requestAnimationFrame(() => {
      if (generation === navigateGenerationRef.current) tryNavigate()
    })

    return () => {
      clearTimeoutTimer('pendingNavigate')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void runAsyncFunction(async () => {
      void EventEmitter.emit(EVENT_NAMES.ESTIMATED_TOKEN_COUNT, {
        tokensCount: await estimateHistoryTokens(assistant, messages),
        contextCount: getContextCount(assistant, messages)
      })
    }).then(() => onFirstUpdate?.())
  }, [assistant, messages, onFirstUpdate])

  const loadMoreMessages = useCallback(() => {
    if (!hasMore || isLoadingMore) return

    setIsLoadingMore(true)

    const container = scrollContainerRef.current
    const anchor = findFirstVisibleMessage(container, messageElements.current)

    setTimeoutTimer(
      'loadMoreMessages',
      () => {
        const allMessages = messagesRef.current
        const currentDisplay = lastDisplayMessagesRef.current
        const oldestInWindow = currentDisplay[currentDisplay.length - 1]
        const oldestIndex = allMessages.findIndex((m) => m.id === oldestInWindow?.id)

        if (oldestIndex <= 0) {
          setIsLoadingMore(false)
          setHasMore(false)
          return
        }

        const startIndex = allMessages.length - oldestIndex
        const newMessages = computeDisplayMessages(allMessages, startIndex, LOAD_MORE_COUNT)
        const merged = [...currentDisplay, ...newMessages]
        const newestInMerged = merged[0]
        const oldestInMerged = merged[merged.length - 1]
        const newestInArray = allMessages[allMessages.length - 1]
        const oldestInArray = allMessages[0]

        lastDisplayMessagesRef.current = merged
        setDisplayMessages(merged)
        setHasMore(oldestInMerged?.id !== oldestInArray?.id)
        setHasMoreNewer(newestInMerged?.id !== newestInArray?.id)
        setIsLoadingMore(false)

        if (anchor) {
          requestAnimationFrame(() => {
            if (container && anchor.element && anchor.element.isConnected) {
              const newRect = anchor.element.getBoundingClientRect()
              const delta = newRect.top - anchor.rect.top
              if (Math.abs(delta) > 1) {
                isProgrammaticScrollRef.current = true
                container.scrollTop += delta
                requestAnimationFrame(() => {
                  isProgrammaticScrollRef.current = false
                })
              }
            }
          })
        }
      },
      50
    )
  }, [hasMore, isLoadingMore, setTimeoutTimer, scrollContainerRef])

  const loadNewerMessages = useCallback(() => {
    if (!hasMoreNewer || isLoadingNewer) return

    setIsLoadingNewer(true)

    const container = scrollContainerRef.current
    const anchor = findFirstVisibleMessage(container, messageElements.current)

    setTimeoutTimer(
      'loadNewerMessages',
      () => {
        const allMessages = messagesRef.current
        const currentDisplay = lastDisplayMessagesRef.current
        const newestInWindow = currentDisplay[0]
        const newestIndex = allMessages.findIndex((m) => m.id === newestInWindow?.id)

        if (newestIndex < 0 || newestIndex >= allMessages.length - 1) {
          setIsLoadingNewer(false)
          setHasMoreNewer(false)
          return
        }

        const newMessages: Message[] = []
        let upperBound = newestIndex
        let groupCount = 0
        let previousGroupKey: string | null = null

        for (let i = newestIndex + 1; i < allMessages.length; i++) {
          const groupKey = getDisplayGroupKey(allMessages[i])
          if (groupKey !== previousGroupKey) {
            if (groupCount === LOAD_MORE_COUNT) break
            groupCount++
            previousGroupKey = groupKey
          }
          upperBound = i
        }

        for (let i = upperBound; i > newestIndex; i--) {
          newMessages.push(allMessages[i])
        }

        const merged = [...newMessages, ...currentDisplay]
        const newestInMerged = merged[0]
        const oldestInMerged = merged[merged.length - 1]
        const newestInArray = allMessages[allMessages.length - 1]
        const oldestInArray = allMessages[0]

        lastDisplayMessagesRef.current = merged
        setDisplayMessages(merged)
        setHasMore(oldestInMerged?.id !== oldestInArray?.id)
        setHasMoreNewer(newestInMerged?.id !== newestInArray?.id)
        setIsLoadingNewer(false)

        if (anchor) {
          requestAnimationFrame(() => {
            if (container && anchor.element && anchor.element.isConnected) {
              const newRect = anchor.element.getBoundingClientRect()
              const delta = newRect.top - anchor.rect.top
              if (Math.abs(delta) > 1) {
                isProgrammaticScrollRef.current = true
                container.scrollTop += delta
                requestAnimationFrame(() => {
                  isProgrammaticScrollRef.current = false
                })
              }
            }
          })
        }
      },
      50
    )
  }, [hasMoreNewer, isLoadingNewer, setTimeoutTimer, scrollContainerRef])

  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return

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

const computeDisplayMessages = (messages: Message[], startIndex: number, displayCount: number) => {
  let newestSourceIndex = messages.length - 1 - startIndex
  const startingGroupKey = messages[newestSourceIndex] ? getDisplayGroupKey(messages[newestSourceIndex]) : null

  while (
    newestSourceIndex < messages.length - 1 &&
    getDisplayGroupKey(messages[newestSourceIndex + 1]) === startingGroupKey
  ) {
    newestSourceIndex++
  }

  if (messages.length - startIndex <= displayCount) {
    const result: Message[] = []
    for (let i = newestSourceIndex; i >= 0; i--) {
      result.push(messages[i])
    }
    return result
  }
  const displayMessages: Message[] = []
  let groupCount = 0
  let previousGroupKey: string | null = null

  for (let i = newestSourceIndex; i >= 0; i--) {
    const message = messages[i]
    const groupKey = getDisplayGroupKey(message)

    if (groupKey !== previousGroupKey) {
      if (groupCount === displayCount) break
      groupCount++
      previousGroupKey = groupKey
    }
    displayMessages.push(message)
  }

  return displayMessages
}

const computeStartIndex = (messages: Message[], targetMessageId: string, contextCount: number): number => {
  const targetIndex = messages.findIndex((m) => m.id === targetMessageId)
  if (targetIndex === -1) return 0
  const startIndex = Math.max(0, messages.length - 1 - targetIndex - contextCount)
  return startIndex
}

const getDisplayGroupKey = (message: Message): string =>
  message.role === 'assistant' && message.askId ? `assistant${message.askId}` : `${message.role}${message.id}`

const countDisplayGroups = (messages: Message[]): number => {
  let count = 0
  let previousKey: string | null = null

  for (const message of messages) {
    const key = getDisplayGroupKey(message)
    if (key !== previousKey) {
      count++
      previousKey = key
    }
  }

  return count
}

const trimDisplayWindowToGroupCapacity = (messages: Message[], groupCapacity: number): Message[] => {
  if (groupCapacity <= 0) return []

  let groupCount = 0
  let previousKey: string | null = null
  let endIndex = 0

  for (const message of messages) {
    const key = getDisplayGroupKey(message)
    if (key !== previousKey) {
      if (groupCount === groupCapacity) break
      groupCount++
      previousKey = key
    }
    endIndex++
  }

  return endIndex === messages.length ? messages : messages.slice(0, endIndex)
}

/**
 * Refreshes message objects without changing a historical window's IDs. A
 * window that touched the previous latest edge follows appended messages while
 * retaining its prior group capacity.
 */
const reconcileDisplayWindow = (
  messages: Message[],
  previousMessages: Message[],
  currentDisplayMessages: Message[]
): Message[] => {
  const latestById = new Map(messages.map((message) => [message.id, message]))
  const reconciled = currentDisplayMessages.flatMap((message) => {
    const latestMessage = latestById.get(message.id)
    return latestMessage ? [latestMessage] : []
  })
  const wasAtLatestEdge = currentDisplayMessages[0]?.id === previousMessages.at(-1)?.id

  if (!wasAtLatestEdge || reconciled.length === 0) return reconciled

  const newestReconciledIndex = messages.findIndex((message) => message.id === reconciled[0]?.id)
  if (newestReconciledIndex === -1 || newestReconciledIndex === messages.length - 1) return reconciled

  const currentIds = new Set(reconciled.map((message) => message.id))
  const appendedMessages: Message[] = []
  for (let index = messages.length - 1; index > newestReconciledIndex; index--) {
    const message = messages[index]
    if (!currentIds.has(message.id)) appendedMessages.push(message)
  }

  if (appendedMessages.length === 0) return reconciled

  const groupCapacity = countDisplayGroups(currentDisplayMessages)
  return trimDisplayWindowToGroupCapacity([...appendedMessages, ...reconciled], groupCapacity)
}

const getDisplayWindowBoundaries = (
  messages: Message[],
  displayMessages: Message[]
): { hasOlder: boolean; hasNewer: boolean } => {
  if (messages.length === 0 || displayMessages.length === 0) return { hasOlder: false, hasNewer: false }

  return {
    hasOlder: displayMessages.at(-1)?.id !== messages[0]?.id,
    hasNewer: displayMessages[0]?.id !== messages.at(-1)?.id
  }
}

const areMessageArraysIdentical = (left: Message[], right: Message[]): boolean =>
  left.length === right.length && left.every((message, index) => message === right[index])

/**
 * Builds a saved-position window in visual chronology: older groups above the
 * target group and newer groups below it. Messages remain chronological while
 * selecting the window, then are reversed for the column-reverse display.
 *
 * A display group is one user message or one consecutive assistant askId group,
 * matching getGroupedMessages and computeDisplayMessages counting semantics.
 */
const computeSavedRestoreDisplayWindow = (
  messages: Message[],
  targetMessageId: string,
  visuallyOlderGroupCount: number,
  visuallyNewerGroupCount: number
): Message[] => {
  const groups: Message[][] = []

  for (const message of messages) {
    const groupKey = getDisplayGroupKey(message)
    const previousGroup = groups.at(-1)
    const previousMessage = previousGroup?.at(-1)
    const previousGroupKey = previousMessage ? getDisplayGroupKey(previousMessage) : null

    if (previousGroup && previousGroupKey === groupKey) {
      previousGroup.push(message)
    } else {
      groups.push([message])
    }
  }

  const targetGroupIndex = groups.findIndex((group) => group.some((message) => message.id === targetMessageId))
  if (targetGroupIndex === -1) return []

  const desiredGroupCount = visuallyOlderGroupCount + 1 + visuallyNewerGroupCount
  let visuallyOldestGroupIndex = Math.max(0, targetGroupIndex - visuallyOlderGroupCount)
  let visuallyNewestGroupIndexExclusive = Math.min(groups.length, targetGroupIndex + visuallyNewerGroupCount + 1)

  const missingGroups = desiredGroupCount - (visuallyNewestGroupIndexExclusive - visuallyOldestGroupIndex)
  if (missingGroups > 0) {
    const additionalOlderGroups = Math.min(visuallyOldestGroupIndex, missingGroups)
    visuallyOldestGroupIndex -= additionalOlderGroups
    visuallyNewestGroupIndexExclusive = Math.min(
      groups.length,
      visuallyNewestGroupIndexExclusive + missingGroups - additionalOlderGroups
    )
  }

  return groups.slice(visuallyOldestGroupIndex, visuallyNewestGroupIndexExclusive).flat().toReversed()
}

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
