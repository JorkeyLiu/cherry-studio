import { loggerService } from '@logger'
import type { ContentSearchRef } from '@renderer/components/ContentSearch'
import { ContentSearch } from '@renderer/components/ContentSearch'
import { HStack } from '@renderer/components/Layout'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup'
import { QuickPanelProvider } from '@renderer/components/QuickPanel'
import ResizableHandle from '@renderer/components/ResizableHandle'
import { isEmbeddingModel, isRerankModel, isWebSearchModel } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useTopicMessages, useTopicReferencedBlocks } from '@renderer/hooks/useMessageOperations'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowTopics } from '@renderer/hooks/useStore'
import { useTimer } from '@renderer/hooks/useTimer'
import { computeContextInfo } from '@renderer/services/contextInfoService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { currentPhaseCorrelation, recordPhaseDurationForCorrelation } from '@renderer/services/phaseTimingDiagnostics'
import { useAppDispatch } from '@renderer/store'
import { setTopicListWidth } from '@renderer/store/settings'
import type { Assistant, Model, Topic } from '@renderer/types'
import { Flex } from 'antd'
import { debounce } from 'lodash'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import React, { useMemo, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import ChatNavbar from './components/ChatNavBar'
import Inputbar from './Inputbar/Inputbar'
import ChatNavigation from './Messages/ChatNavigation'
import Messages, { type MessagesHandle } from './Messages/Messages'
import Tabs from './Tabs'

const logger = loggerService.withContext('Chat')

interface Props {
  assistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  setActiveAssistant: (assistant: Assistant) => void
}

const Chat: FC<Props> = (props) => {
  const { assistant, updateAssistant, updateTopic } = useAssistant(props.assistant.id)
  const { t } = useTranslation()
  // LOCK-105: message style is always bubble; messageNavigation is a boolean
  // off/on toggle for the conversation navigation buttons.
  const { messageNavigation } = useSettings()
  const { showTopics } = useShowTopics()
  const dispatch = useAppDispatch()

  const mainRef = React.useRef<HTMLDivElement>(null)
  const contentSearchRef = React.useRef<ContentSearchRef>(null)
  const messagesRef = React.useRef<MessagesHandle>(null)
  const [filterIncludeUser, setFilterIncludeUser] = useState(false)

  const { setTimeoutTimer } = useTimer()

  // --- Shared context projection (Phase 2B) ---
  // Both Messages and Inputbar previously computed computeContextInfo independently
  // with identical inputs. This single memo computes once for the shared
  // [topic messages, topic blocks, assistant, topic id] identity and provides
  // all fields needed by both consumers. ConversationService/baseCallbacks
  // calls remain independent.
  //
  // The topic-blocks dependency exists because computeContextInfo reads message
  // blocks through block-dependent filters (filterEmptyMessages /
  // filterErrorOnlyMessagesWithRelated): a block-only Redux update (updateOneBlock)
  // can change the projection without changing the topic message array.
  // useTopicReferencedBlocks subscribes only to active-topic referenced blocks
  // (selectMessageBlocksByIds + shallowEqual), so unrelated block commits do
  // not invalidate this projection.
  //
  // PERF_PHASE_ATTR: the active correlation path selects the single honest stage
  // for the one shared computation — echo.sharedContextInfo on the echo path and
  // topic.contextInfo on topic-switch paths. No second computeContextInfo call is
  // ever made for diagnostics; outside measurement mode this wraps nothing.
  const topicMessages = useTopicMessages(props.activeTopic.id)
  const topicBlocks = useTopicReferencedBlocks(props.activeTopic.id)
  const sharedContextInfo = useMemo(() => {
    const active = currentPhaseCorrelation()
    const startedAt = active ? performance.now() : 0
    const result = computeContextInfo(topicMessages, assistant, props.activeTopic.id)
    if (active && topicMessages.length > 0) {
      recordPhaseDurationForCorrelation(
        active.correlationId,
        active.path,
        active.path === 'echo' ? 'echo.sharedContextInfo' : 'topic.contextInfo',
        performance.now() - startedAt
      )
    }
    return result
  }, [topicMessages, topicBlocks, assistant, props.activeTopic.id])

  useHotkeys('esc', () => {
    contentSearchRef.current?.disable()
  })

  useShortcut('search_message_in_chat', () => {
    try {
      const selectedText = window.getSelection()?.toString().trim()
      contentSearchRef.current?.enable(selectedText)
    } catch (error) {
      logger.error('Error enabling content search:', error as Error)
    }
  })

  useShortcut('rename_topic', async () => {
    const topic = props.activeTopic
    if (!topic) return

    void EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)

    const name = await PromptPopup.show({
      title: t('chat.topics.edit.title'),
      message: '',
      defaultValue: topic.name || '',
      extraNode: <div style={{ color: 'var(--color-text-3)', marginTop: 8 }}>{t('chat.topics.edit.title_tip')}</div>
    })
    if (name && topic.name !== name) {
      const updatedTopic = { ...topic, name, isNameManuallyEdited: true }
      try {
        // Phase 5.2B: SQLite persists before Redux (LOCK-528).
        await updateTopic(updatedTopic as Topic)
      } catch (error) {
        logger.error('Failed to persist renamed topic', error as Error)
      }
    }
  })

  useShortcut('select_model', async () => {
    const modelFilter = (m: Model) => !isEmbeddingModel(m) && !isRerankModel(m)
    const selectedModel = await SelectChatModelPopup.show({
      model: assistant?.model,
      filter: modelFilter
    })
    if (selectedModel) {
      const enabledWebSearch = isWebSearchModel(selectedModel)
      updateAssistant({
        model: selectedModel,
        enableWebSearch: enabledWebSearch && assistant.enableWebSearch
      })
    }
  })

  const contentSearchFilter: NodeFilter = {
    acceptNode(node) {
      const container = node.parentElement?.closest('.message-content-container')
      if (!container) return NodeFilter.FILTER_REJECT

      const message = container.closest('.message')
      if (!message) return NodeFilter.FILTER_REJECT

      if (filterIncludeUser) {
        return NodeFilter.FILTER_ACCEPT
      }
      if (message.classList.contains('message-assistant')) {
        return NodeFilter.FILTER_ACCEPT
      }
      return NodeFilter.FILTER_REJECT
    }
  }

  const userOutlinedItemClickHandler = () => {
    setFilterIncludeUser(!filterIncludeUser)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeoutTimer(
          'userOutlinedItemClickHandler',
          () => {
            contentSearchRef.current?.search()
            contentSearchRef.current?.focus()
          },
          0
        )
      })
    })
  }

  let firstUpdateCompleted = false
  const firstUpdateOrNoFirstUpdateHandler = debounce(() => {
    contentSearchRef.current?.silentSearch()
  }, 10)

  const messagesComponentUpdateHandler = () => {
    if (firstUpdateCompleted) {
      firstUpdateOrNoFirstUpdateHandler()
    }
  }

  const messagesComponentFirstUpdateHandler = () => {
    setTimeoutTimer('messagesComponentFirstUpdateHandler', () => (firstUpdateCompleted = true), 300)
    firstUpdateOrNoFirstUpdateHandler()
  }

  const mainHeight = 'calc(100vh - var(--navbar-height))'

  return (
    // LOCK-105: message style is always bubble.
    <Container id="chat" className="bubble">
      <HStack>
        <motion.div
          layout
          transition={{ duration: 0.3, ease: 'easeInOut' }}
          style={{ flex: 1, display: 'flex', minWidth: 0, overflow: 'hidden' }}>
          <Main
            ref={mainRef}
            id="chat-main"
            vertical
            flex={1}
            justify="space-between"
            style={{ height: mainHeight, width: '100%' }}>
            <QuickPanelProvider>
              <ChatNavbar activeAssistant={props.assistant} />
              <div
                className="flex flex-1 flex-col justify-between"
                style={{ height: `calc(${mainHeight} - var(--navbar-height))` }}>
                <Messages
                  ref={messagesRef}
                  assistant={assistant}
                  topic={props.activeTopic}
                  setActiveTopic={props.setActiveTopic}
                  onComponentUpdate={messagesComponentUpdateHandler}
                  onFirstUpdate={messagesComponentFirstUpdateHandler}
                  sharedContextInfo={sharedContextInfo}
                />
                <ContentSearch
                  ref={contentSearchRef}
                  searchTarget={mainRef as React.RefObject<HTMLElement>}
                  filter={contentSearchFilter}
                  includeUser={filterIncludeUser}
                  onIncludeUserChange={userOutlinedItemClickHandler}
                />
                {messageNavigation && (
                  <ChatNavigation
                    containerId="messages"
                    scrollToMessageById={(id) => messagesRef.current?.scrollToMessageById(id)}
                    scrollToTop={() => messagesRef.current?.scrollToTop()}
                    scrollToContextBoundary={() => messagesRef.current?.scrollToContextBoundary()}
                    scrollToBottom={() => messagesRef.current?.scrollToBottom()}
                    previousUserMessage={(id) => messagesRef.current?.previousUserMessage(id)}
                    nextUserMessage={(id) => messagesRef.current?.nextUserMessage(id)}
                  />
                )}
                <Inputbar
                  assistant={assistant}
                  setActiveTopic={props.setActiveTopic}
                  topic={props.activeTopic}
                  sharedContextInfo={sharedContextInfo}
                />
              </div>
            </QuickPanelProvider>
          </Main>
        </motion.div>
        {showTopics && (
          <ResizableHandle
            cssVar="--topic-list-width"
            onResizeEnd={(width) => dispatch(setTopicListWidth(width))}
            side="right"
          />
        )}
        <AnimatePresence initial={false}>
          {showTopics && (
            <motion.div
              key="right-tabs"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 'var(--topic-list-width, 275px)', opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              style={{
                overflow: 'hidden'
              }}>
              <Tabs
                activeAssistant={assistant}
                activeTopic={props.activeTopic}
                setActiveAssistant={props.setActiveAssistant}
                setActiveTopic={props.setActiveTopic}
                position="right"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </HStack>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--navbar-height));
  flex: 1;
  overflow: hidden;
`

const Main = styled(Flex)`
  height: calc(100vh - var(--navbar-height));
  transform: translateZ(0);
  position: relative;
`

export default Chat
