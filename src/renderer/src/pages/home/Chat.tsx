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
import { useContextClosure } from '@renderer/hooks/useContextClosure'
import { useTopicMessages, useTopicReferencedBlocks } from '@renderer/hooks/useMessageOperations'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowTopics } from '@renderer/hooks/useStore'
import { useTimer } from '@renderer/hooks/useTimer'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import { computeClosureFingerprint, getFreshValidatedClosure } from '@renderer/services/contextClosure'
import { computeContextInfo } from '@renderer/services/contextInfoService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { currentPhaseCorrelation, recordPhaseDurationForCorrelation } from '@renderer/services/phaseTimingDiagnostics'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { selectMessageBlocksByIds } from '@renderer/store/messageBlock'
import { setTopicListWidth } from '@renderer/store/settings'
import type { Assistant, Model, Topic } from '@renderer/types'
import { Flex } from 'antd'
import { debounce } from 'lodash'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import React, { useMemo, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'
import { shallowEqual } from 'react-redux'
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
  // S3.5: ContentSearch is parent-owned lazy activation — zero instance before invocation.
  const [isContentSearchActive, setIsContentSearchActive] = useState(false)
  const [pendingSearchText, setPendingSearchText] = useState<string | undefined>(undefined)
  const isSearchActiveRef = React.useRef(isContentSearchActive)
  React.useEffect(() => {
    isSearchActiveRef.current = isContentSearchActive
  }, [isContentSearchActive])

  const firstUpdateCompletedRef = React.useRef(false)
  const userToggleRaf1Ref = React.useRef<number | null>(null)
  const userToggleRaf2Ref = React.useRef<number | null>(null)
  const { setTimeoutTimer, clearTimeoutTimer } = useTimer()

  // Reset first-update flag when topic switches; cancel any pending first-update debounce/timer.
  React.useEffect(() => {
    firstUpdateCompletedRef.current = false
    // Clear pending firstUpdate timer if any (owned via useTimer)
    clearTimeoutTimer('messagesComponentFirstUpdateHandler')
  }, [props.activeTopic.id, clearTimeoutTimer])

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
  const anchorGroupKey = getAssistantSettings(assistant).contextWindowAnchor?.[props.activeTopic.id]?.groupKey ?? null
  const { closure } = useContextClosure(props.activeTopic.id, anchorGroupKey)
  // R-06: closure-sourced rows feed shared computeContextInfo when fresh; viewport remains for viewport groups.
  // Centralized helper combines structural + anchor + full-closure freshness (generation + fingerprint); fail-closed to viewport.
  const currentFingerprint = useMemo(() => computeClosureFingerprint(topicMessages as any), [topicMessages])
  const contextClosureMessages = useMemo(() => {
    void closure // keep hook subscription; actual freshness is gated via centralized helper reading cache
    const fresh = getFreshValidatedClosure(props.activeTopic.id, anchorGroupKey, currentFingerprint)
    if (fresh) return fresh.messages as any
    return null
  }, [props.activeTopic.id, anchorGroupKey, currentFingerprint, closure])
  const contextSourceMessages = contextClosureMessages ?? topicMessages
  // Subscribe to closure-referenced blocks when closure is active so filterEmptyMessages invalidation covers closure blocks
  const closureBlockIds = useMemo(
    () => (contextClosureMessages ? contextClosureMessages.flatMap((m: any) => (m.blocks ?? []) as string[]) : []),
    [contextClosureMessages]
  )
  const closureBlocks = useAppSelector((state) => selectMessageBlocksByIds(state, closureBlockIds), shallowEqual)
  // Use closure blocks for memo invalidation when closure active; otherwise use viewport blocks
  const activeBlocksForContext = contextClosureMessages ? closureBlocks : topicBlocks
  const sharedContextInfo = useMemo(() => {
    const active = currentPhaseCorrelation()
    const startedAt = active ? performance.now() : 0
    const result = computeContextInfo(contextSourceMessages, assistant, props.activeTopic.id)
    if (active && contextSourceMessages.length > 0) {
      recordPhaseDurationForCorrelation(
        active.correlationId,
        active.path,
        active.path === 'echo' ? 'echo.sharedContextInfo' : 'topic.contextInfo',
        performance.now() - startedAt
      )
    }
    return result
  }, [contextSourceMessages, activeBlocksForContext, assistant, props.activeTopic.id])

  const enableContentSearch = React.useCallback((initialText?: string) => {
    if (isSearchActiveRef.current) {
      // Already mounted — forward imperatively without losing focus/text.
      contentSearchRef.current?.enable(initialText)
    } else {
      setPendingSearchText(initialText)
      isSearchActiveRef.current = true
      setIsContentSearchActive(true)
    }
  }, [])

  const disableContentSearch = React.useCallback(() => {
    if (isSearchActiveRef.current) {
      // Clear any queued initial text and unmount. ContentSearch also clears highlights on unmount.
      setPendingSearchText(undefined)
      try {
        ;(globalThis as any).CSS?.highlights?.clear?.()
      } catch {}
      isSearchActiveRef.current = false
      setIsContentSearchActive(false)
    } else {
      try {
        ;(globalThis as any).CSS?.highlights?.clear?.()
      } catch {}
    }
  }, [])

  useHotkeys('esc', () => {
    disableContentSearch()
  })

  useShortcut('search_message_in_chat', () => {
    try {
      const selectedText = window.getSelection()?.toString().trim()
      enableContentSearch(selectedText)
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

  const userOutlinedItemClickHandler = React.useCallback(() => {
    setFilterIncludeUser((prev) => !prev)
    if (userToggleRaf1Ref.current != null) cancelAnimationFrame(userToggleRaf1Ref.current)
    if (userToggleRaf2Ref.current != null) cancelAnimationFrame(userToggleRaf2Ref.current)
    userToggleRaf1Ref.current = requestAnimationFrame(() => {
      userToggleRaf2Ref.current = requestAnimationFrame(() => {
        setTimeoutTimer(
          'userOutlinedItemClickHandler',
          () => {
            // S3.5: Only invoke search when the lazy search is active; otherwise this would implicitly mount it.
            if (!isSearchActiveRef.current) return
            if (!contentSearchRef.current) return
            contentSearchRef.current.search()
            contentSearchRef.current.focus()
          },
          0
        )
      })
    })
  }, [setTimeoutTimer])

  const firstUpdateOrNoFirstUpdateHandler = React.useMemo(
    () =>
      debounce(() => {
        if (!isSearchActiveRef.current) return
        if (!contentSearchRef.current) return
        contentSearchRef.current.silentSearch()
      }, 10),
    []
  )

  React.useEffect(() => {
    return () => {
      firstUpdateOrNoFirstUpdateHandler.cancel()
      if (userToggleRaf1Ref.current != null) cancelAnimationFrame(userToggleRaf1Ref.current)
      if (userToggleRaf2Ref.current != null) cancelAnimationFrame(userToggleRaf2Ref.current)
      clearTimeoutTimer('userOutlinedItemClickHandler')
      clearTimeoutTimer('messagesComponentFirstUpdateHandler')
    }
  }, [firstUpdateOrNoFirstUpdateHandler, clearTimeoutTimer])

  const messagesComponentUpdateHandler = React.useCallback(() => {
    if (firstUpdateCompletedRef.current) {
      firstUpdateOrNoFirstUpdateHandler()
    }
  }, [firstUpdateOrNoFirstUpdateHandler])

  const messagesComponentFirstUpdateHandler = React.useCallback(() => {
    setTimeoutTimer(
      'messagesComponentFirstUpdateHandler',
      () => {
        firstUpdateCompletedRef.current = true
      },
      300
    )
    firstUpdateOrNoFirstUpdateHandler()
  }, [firstUpdateOrNoFirstUpdateHandler, setTimeoutTimer])

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
                {isContentSearchActive && (
                  <ContentSearch
                    ref={contentSearchRef}
                    searchTarget={mainRef as React.RefObject<HTMLElement>}
                    filter={contentSearchFilter}
                    includeUser={filterIncludeUser}
                    onIncludeUserChange={userOutlinedItemClickHandler}
                    initialText={pendingSearchText}
                    onClose={disableContentSearch}
                  />
                )}
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
