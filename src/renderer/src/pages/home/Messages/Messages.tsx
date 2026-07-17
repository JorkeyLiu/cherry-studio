import { loggerService } from '@logger'
import ContextMenu from '@renderer/components/ContextMenu'
import EditModeActionBar from '@renderer/components/EditModeActionBar'
import EditModeContextMenu from '@renderer/components/EditModeContextMenu'
import { LoadingIcon } from '@renderer/components/Icons'
import { LOAD_MORE_COUNT } from '@renderer/config/constant'
import { EditModeProvider, useEditMode } from '@renderer/context/EditModeContext'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useClipboardKeyboard } from '@renderer/hooks/useClipboardKeyboard'
import { useMessageOperations, useTopicMessages } from '@renderer/hooks/useMessageOperations'
import useScrollPosition from '@renderer/hooks/useScrollPosition'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTimer } from '@renderer/hooks/useTimer'
import { autoRenameTopic } from '@renderer/hooks/useTopic'
import { useTopicSegments } from '@renderer/hooks/useTopicSegments'
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
import { updateCodeBlock } from '@renderer/utils/markdown'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { isTextLikeBlock } from '@renderer/utils/messageUtils/is'
import { last } from 'lodash'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import InfiniteScroll from 'react-infinite-scroll-component'
import styled from 'styled-components'

import MessageAnchorLine from './MessageAnchorLine'
import MessageGroup from './MessageGroup'
import NarrowLayout from './NarrowLayout'
import Prompt from './Prompt'
import { MessagesContainer, ScrollContainer } from './shared'
import TopicSegmentLine from './TopicSegmentLine'
import TopicSegmentNavigation from './TopicSegmentNavigation'

interface MessagesProps {
  assistant: Assistant
  topic: Topic
  setActiveTopic: (topic: Topic) => void
  onComponentUpdate?(): void
  onFirstUpdate?(): void
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
  loadMoreMessages,
  registerMessageElement
}) => {
  const { showPrompt, messageNavigation } = useSettings()

  const { isEnabled: isEditMode, selectedGroupIds, handleGroupClick } = useEditMode()
  const { isMessageFirstInSegment, isMessageLastInSegment, isMessageInSegment, segmentsForTopic } = useTopicSegments(
    topic.id
  )
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
        // Check if any message in this group belongs to a topic segment
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
      {segmentsForTopic.length > 0 && <TopicSegmentNavigation topicId={topic.id} />}
      {isEditMode && <EditModeActionBar />}
    </MessagesContainer>
  )
}

const Messages: React.FC<MessagesProps> = ({ assistant, topic, setActiveTopic, onComponentUpdate, onFirstUpdate }) => {
  const { containerRef: scrollContainerRef, handleScroll: handleScrollPosition } = useScrollPosition(
    `topic-${topic.id}`
  )
  const [displayMessages, setDisplayMessages] = useState<Message[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [isProcessingContext, setIsProcessingContext] = useState(false)

  const { addTopic } = useAssistant(assistant.id)
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const messages = useTopicMessages(topic.id)
  const { displayCount, clearTopicMessages, deleteMessage, createTopicBranch } = useMessageOperations(topic)
  const { setTimeoutTimer } = useTimer()

  // 滚动到指定消息组
  const scrollToGroup = useCallback((askId: string) => {
    const element = document.getElementById(`message-group-${askId}`)
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [])

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

  const messageElements = useRef<Map<string, HTMLElement>>(new Map())
  const messagesRef = useRef<Message[]>(messages)

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

  useEffect(() => {
    const newDisplayMessages = computeDisplayMessages(messages, 0, displayCount)
    setDisplayMessages(newDisplayMessages)
    setHasMore(messages.length > displayCount)
  }, [messages, displayCount])

  // NOTE: 如果设置为平滑滚动会导致滚动条无法跟随生成的新消息保持在底部位置
  const scrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({ top: 0 })
        }
      })
    }
  }, [scrollContainerRef])

  const clearTopic = useCallback(
    async (data: Topic) => {
      if (data && data.id !== topic.id) {
        await clearTopicMessages(data.id)
        return
      }

      await clearTopicMessages()
      setDisplayMessages([])
    },
    [clearTopicMessages, topic.id]
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
        contextCount: getContextCount(assistant, messages)
      })
    }).then(() => onFirstUpdate?.())
  }, [assistant, messages, onFirstUpdate])

  const loadMoreMessages = useCallback(() => {
    if (!hasMore || isLoadingMore) return

    setIsLoadingMore(true)
    setTimeoutTimer(
      'loadMoreMessages',
      () => {
        const currentLength = displayMessages.length
        const newMessages = computeDisplayMessages(messages, currentLength, LOAD_MORE_COUNT)

        setDisplayMessages((prev) => [...prev, ...newMessages])
        setHasMore(currentLength + LOAD_MORE_COUNT < messages.length)
        setIsLoadingMore(false)
      },
      300
    )
  }, [displayMessages.length, hasMore, isLoadingMore, messages, setTimeoutTimer])

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
        handleScrollPosition={handleScrollPosition}
        displayMessages={displayMessages}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        loadMoreMessages={loadMoreMessages}
        registerMessageElement={registerMessageElement}
      />
    </EditModeProvider>
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
    const message = messages[i]
    processMessage(message)
  }

  return displayMessages
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
