import { loggerService } from '@logger'
import ContextMenu from '@renderer/components/ContextMenu'
import { LoadingIcon } from '@renderer/components/Icons'
import { INITIAL_MESSAGES_COUNT, LOAD_MORE_COUNT, SCROLL_CONTEXT_COUNT } from '@renderer/config/constant'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useMessageOperations, useTopicMessages } from '@renderer/hooks/useMessageOperations'
import useScrollPosition from '@renderer/hooks/useScrollPosition'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTimer } from '@renderer/hooks/useTimer'
import { autoRenameTopic } from '@renderer/hooks/useTopic'
import SelectionBox from '@renderer/pages/home/Messages/SelectionBox'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { getContextCount, getGroupedMessages, getUserMessage } from '@renderer/services/MessagesService'
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
  const { showPrompt, messageNavigation } = useSettings()
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const messages = useTopicMessages(topic.id)
  const { displayCount, clearTopicMessages, deleteMessage, createTopicBranch } = useMessageOperations(topic)
  const { setTimeoutTimer } = useTimer()

  const { isMultiSelectMode, handleSelectMessage } = useChatContext(topic)

  const messageElements = useRef<Map<string, HTMLElement>>(new Map())
  const messagesRef = useRef<Message[]>(messages)
  const jumpTargetRef = useRef<string | null>(null)
  const lastDisplayMessagesRef = useRef<Message[]>([])

  // On mount (topic switch), check if we need to restore to a specific message
  useEffect(() => {
    const saved = getSavedPosition()
    if (saved?.anchorId) {
      // Message-based restoration: set jumpTargetRef for Scenario 1
      jumpTargetRef.current = saved.anchorId
    } else if (saved?.scrollTop) {
      // Pixel-based fallback (old format data or no anchor available)
      // Schedule after initial message load so container has content
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

  const registerMessageElement = useCallback((id: string, element: HTMLElement | null) => {
    if (element) {
      messageElements.current.set(id, element)
    } else {
      messageElements.current.delete(id)
    }
  }, [])

  const checkBoundaries = useCallback(() => {
    const current = lastDisplayMessagesRef.current
    if (current.length === 0 || messages.length === 0) return { hasOlder: false, hasNewer: false }

    const newestInWindow = current[0] // newest in window (first in reverse-ordered array)
    const oldestInWindow = current[current.length - 1] // oldest in window
    const newestInArray = messages[messages.length - 1]
    const oldestInArray = messages[0]

    return {
      hasOlder: oldestInWindow?.id !== oldestInArray?.id,
      hasNewer: newestInWindow?.id !== newestInArray?.id
    }
  }, [messages])

  useEffect(() => {
    // Scenario 1: Jump target (deep navigation / topic switch restore)
    if (jumpTargetRef.current) {
      const targetId = jumpTargetRef.current
      jumpTargetRef.current = null
      const startIndex = computeStartIndex(messages, targetId, SCROLL_CONTEXT_COUNT)
      const newDisplayMessages = computeDisplayMessages(messages, startIndex, startIndex + INITIAL_MESSAGES_COUNT)
      setDisplayMessages(newDisplayMessages)
      lastDisplayMessagesRef.current = newDisplayMessages
      const { hasOlder, hasNewer } = checkBoundaries()
      setHasMore(hasOlder)
      setHasMoreNewer(hasNewer)

      // Scroll to target message after render
      requestAnimationFrame(() => {
        setTimeout(() => {
          const el = document.getElementById(`message-${targetId}`)
          if (el) {
            scrollIntoView(el, { behavior: 'auto', block: 'start', container: 'nearest' })
          }
        }, 50)
      })
      return
    }

    // Scenario 2: First load
    if (lastDisplayMessagesRef.current.length === 0) {
      const newDisplayMessages = computeDisplayMessages(messages, 0, displayCount)
      setDisplayMessages(newDisplayMessages)
      lastDisplayMessagesRef.current = newDisplayMessages
      const { hasOlder, hasNewer } = checkBoundaries()
      setHasMore(hasOlder)
      setHasMoreNewer(hasNewer)
      return
    }

    // Scenario 3: Messages content changed (edit/delete/etc) - incremental update
    const earliestLoadedId = lastDisplayMessagesRef.current[lastDisplayMessagesRef.current.length - 1]?.id
    const earliestIndex = messages.findIndex((m) => m.id === earliestLoadedId)

    if (earliestIndex === -1) {
      // Earliest loaded message was deleted, need full recalc
      const newDisplayMessages = computeDisplayMessages(messages, 0, displayCount)
      setDisplayMessages(newDisplayMessages)
      lastDisplayMessagesRef.current = newDisplayMessages
      const { hasOlder, hasNewer } = checkBoundaries()
      setHasMore(hasOlder)
      setHasMoreNewer(hasNewer)
    } else {
      // Keep window position, rebuild from earliest to end
      const newDisplayMessages: Message[] = []
      for (let i = messages.length - 1; i >= earliestIndex; i--) {
        newDisplayMessages.push(messages[i])
      }
      setDisplayMessages(newDisplayMessages)
      lastDisplayMessagesRef.current = newDisplayMessages
      const { hasOlder, hasNewer } = checkBoundaries()
      setHasMore(hasOlder)
      setHasMoreNewer(hasNewer)
    }
  }, [messages, displayCount, checkBoundaries])

  // NOTE: 如果设置为平滑滚动会导致滚动条无法跟随生成的新消息保持在底部位置
  const scrollToBottom = useCallback(() => {
    // Check if newest message is in the window
    const current = lastDisplayMessagesRef.current
    const newestInWindow = current[0]
    const newestInArray = messages[messages.length - 1]

    if (newestInWindow?.id !== newestInArray?.id) {
      // Reset window to include newest messages
      const newDisplayMessages = computeDisplayMessages(messages, 0, INITIAL_MESSAGES_COUNT)
      setDisplayMessages(newDisplayMessages)
      lastDisplayMessagesRef.current = newDisplayMessages
      const { hasOlder, hasNewer } = checkBoundaries()
      setHasMore(hasOlder)
      setHasMoreNewer(hasNewer)
    }

    if (scrollContainerRef.current) {
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({ top: 0 })
        }
      })
    }
  }, [scrollContainerRef, messages, checkBoundaries])

  const scrollToMessageById = useCallback(
    (messageId: string) => {
      // Check if message is in current loading window
      const el = document.getElementById(`message-${messageId}`)
      if (el) {
        scrollIntoView(el, { behavior: 'smooth', block: 'start', container: 'nearest' })
        return
      }

      // Not in window, compute jump directly (no jumpTargetRef)
      const startIndex = computeStartIndex(messages, messageId, SCROLL_CONTEXT_COUNT)
      const newDisplayMessages = computeDisplayMessages(messages, startIndex, startIndex + INITIAL_MESSAGES_COUNT)
      setDisplayMessages(newDisplayMessages)
      lastDisplayMessagesRef.current = newDisplayMessages
      const { hasOlder, hasNewer } = checkBoundaries()
      setHasMore(hasOlder)
      setHasMoreNewer(hasNewer)

      // Scroll after render
      requestAnimationFrame(() => {
        setTimeout(() => {
          const targetEl = document.getElementById(`message-${messageId}`)
          if (targetEl) {
            scrollIntoView(targetEl, { behavior: 'auto', block: 'start', container: 'nearest' })
          }
        }, 50)
      })
    },
    [messages, checkBoundaries]
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

        // 1. Add the new topic to Redux store FIRST
        addTopic(newTopic)

        // 2. Call the thunk to clone messages and update DB
        const success = await createTopicBranch(topic.id, currentMessages.length - index, newTopic)

        if (success) {
          // 3. Set the new topic as active
          setActiveTopic(newTopic)
          // 4. Trigger auto-rename for the new topic
          void autoRenameTopic(assistant, newTopic.id)
        } else {
          // Optional: Handle cloning failure (e.g., show an error message)
          // You might want to remove the added topic if cloning fails
          // removeTopic(newTopic.id); // Assuming you have a removeTopic function
          logger.error(`[NEW_BRANCH] Failed to create topic branch for topic ${newTopic.id}`)
          window.toast.error(t('message.branch.error')) // Example error message
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
        contextCount: getContextCount(assistant, messages)
      })
    }).then(() => onFirstUpdate?.())
  }, [assistant, messages, onFirstUpdate])

  const loadMoreMessages = useCallback(() => {
    if (!hasMore || isLoadingMore) return

    setIsLoadingMore(true)

    // Capture anchor before DOM changes
    const container = scrollContainerRef.current
    const anchor = findFirstVisibleMessage(container, messageElements.current)

    setTimeoutTimer(
      'loadMoreMessages',
      () => {
        // Find the oldest loaded message and load messages before it
        const currentDisplay = lastDisplayMessagesRef.current
        const oldestInWindow = currentDisplay[currentDisplay.length - 1]
        const oldestIndex = messages.findIndex((m) => m.id === oldestInWindow?.id)

        if (oldestIndex <= 0) {
          setIsLoadingMore(false)
          return
        }

        const startIndex = messages.length - oldestIndex
        const newMessages = computeDisplayMessages(messages, startIndex, LOAD_MORE_COUNT)

        setDisplayMessages((prev) => {
          const merged = [...prev, ...newMessages]
          lastDisplayMessagesRef.current = merged
          return merged
        })
        const { hasOlder, hasNewer } = checkBoundaries()
        setHasMore(hasOlder)
        setHasMoreNewer(hasNewer)
        setIsLoadingMore(false)

        // Restore scroll position after re-render
        if (anchor) {
          requestAnimationFrame(() => {
            if (container && anchor.element && anchor.element.isConnected) {
              const newRect = anchor.element.getBoundingClientRect()
              const delta = newRect.top - anchor.rect.top
              if (Math.abs(delta) > 1) {
                container.scrollTop += delta
              }
            }
          })
        }
      },
      50
    )
  }, [hasMore, isLoadingMore, messages, setTimeoutTimer, scrollContainerRef, checkBoundaries])

  const loadNewerMessages = useCallback(() => {
    if (!hasMoreNewer || isLoadingNewer) return

    setIsLoadingNewer(true)

    // Capture anchor before DOM changes
    const container = scrollContainerRef.current
    const anchor = findFirstVisibleMessage(container, messageElements.current)

    setTimeoutTimer(
      'loadNewerMessages',
      () => {
        // Find the newest loaded message
        const currentDisplay = lastDisplayMessagesRef.current
        const newestInWindow = currentDisplay[0]
        const newestIndex = messages.findIndex((m) => m.id === newestInWindow?.id)

        if (newestIndex < 0 || newestIndex >= messages.length - 1) {
          setIsLoadingNewer(false)
          return
        }

        // Load messages newer than the current newest
        const countToLoad = Math.min(LOAD_MORE_COUNT, messages.length - 1 - newestIndex)
        const newMessages: Message[] = []
        const upperBound = newestIndex + countToLoad
        for (let i = upperBound; i > newestIndex; i--) {
          newMessages.push(messages[i])
        }

        setDisplayMessages((prev) => {
          const merged = [...newMessages, ...prev] // Prepend newer messages
          lastDisplayMessagesRef.current = merged
          return merged
        })
        const { hasOlder, hasNewer } = checkBoundaries()
        setHasMore(hasOlder)
        setHasMoreNewer(hasNewer)
        setIsLoadingNewer(false)

        // Restore scroll position after re-render
        if (anchor) {
          requestAnimationFrame(() => {
            if (container && anchor.element && anchor.element.isConnected) {
              const newRect = anchor.element.getBoundingClientRect()
              const delta = newRect.top - anchor.rect.top
              if (Math.abs(delta) > 1) {
                container.scrollTop += delta
              }
            }
          })
        }
      },
      50
    )
  }, [hasMoreNewer, isLoadingNewer, messages, setTimeoutTimer, scrollContainerRef, checkBoundaries])

  const handleScroll = useCallback(() => {
    handleScrollPosition()

    // Check if near bottom for loading newer messages
    // In column-reverse, scrollTop=0 is the bottom
    const container = scrollContainerRef.current
    if (container && hasMoreNewer && !isLoadingNewer && !isLoadingMore) {
      if (container.scrollTop < 150) {
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

  return (
    <MessagesContainer
      id="messages"
      className="messages-container"
      ref={scrollContainerRef}
      key={assistant.id}
      onScroll={handleScroll}>
      <NarrowLayout style={{ display: 'flex', flexDirection: 'column-reverse' }}>
        <InfiniteScroll
          dataLength={displayMessages.length}
          next={loadMoreMessages}
          hasMore={hasMore}
          loader={null}
          scrollableTarget="messages"
          inverse
          style={{ overflow: 'visible' }}>
          <ContextMenu>
            <ScrollContainer>
              {isLoadingNewer && (
                <LoaderContainer>
                  <LoadingIcon color="var(--color-text-2)" />
                </LoaderContainer>
              )}
              {groupedMessages.map(([key, groupMessages]) => (
                <MessageGroup
                  key={key}
                  messages={groupMessages}
                  topic={topic}
                  registerMessageElement={registerMessageElement}
                />
              ))}
              {isLoadingMore && (
                <LoaderContainer>
                  <LoadingIcon color="var(--color-text-2)" />
                </LoaderContainer>
              )}
            </ScrollContainer>
          </ContextMenu>
        </InfiniteScroll>

        {showPrompt && <Prompt assistant={assistant} key={assistant.prompt} topic={topic} />}
      </NarrowLayout>
      {messageNavigation === 'anchor' && (
        <MessageAnchorLine messages={displayMessages} scrollToMessageById={scrollToMessageById} />
      )}
      <SelectionBox
        isMultiSelectMode={isMultiSelectMode}
        scrollContainerRef={scrollContainerRef}
        messageElements={messageElements.current}
        handleSelectMessage={handleSelectMessage}
      />
    </MessagesContainer>
  )
}

const computeDisplayMessages = (messages: Message[], startIndex: number, displayCount: number) => {
  // 如果剩余消息数量小于 displayCount，直接返回所有剩余消息的倒序切片
  if (messages.length - startIndex <= displayCount) {
    const result: Message[] = []
    for (let i = messages.length - 1 - startIndex; i >= 0; i--) {
      result.push(messages[i])
    }
    return result
  }
  const userIdSet = new Set() // 用户消息 id 集合
  const assistantIdSet = new Set() // 助手消息 askId 集合
  const displayMessages: Message[] = []

  // 处理单条消息的函数
  const processMessage = (message: Message) => {
    if (!message) return

    const idSet = message.role === 'user' ? userIdSet : assistantIdSet
    const messageId = message.role === 'user' ? message.id : message.askId

    if (!idSet.has(messageId)) {
      idSet.add(messageId)
      displayMessages.push(message)
      return
    }
    // 如果是相同 askId 的助手消息，也要显示
    displayMessages.push(message)
  }

  // 直接在原数组上倒序遍历，跳过前 startIndex 个，避免全量拷贝和 reverse()
  for (let i = messages.length - 1 - startIndex; i >= 0 && userIdSet.size + assistantIdSet.size < displayCount; i--) {
    processMessage(messages[i])
  }

  return displayMessages
}

const computeStartIndex = (messages: Message[], targetMessageId: string, contextCount: number): number => {
  const targetIndex = messages.findIndex((m) => m.id === targetMessageId)
  if (targetIndex === -1) return 0
  const startIndex = Math.max(0, messages.length - 1 - targetIndex - contextCount)
  return startIndex
}

const LoaderContainer = styled.div`
  display: flex;
  justify-content: center;
  padding: 10px;
  width: 100%;
  background: var(--color-background);
  pointer-events: none;
`

export default Messages
