import { loggerService } from '@logger'
import type { ContentSearchLocatedMatch, ContentSearchRef } from '@renderer/components/ContentSearch'
import { ContentSearch } from '@renderer/components/ContentSearch'
import { HStack } from '@renderer/components/Layout'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup'
import ResizableHandle from '@renderer/components/ResizableHandle'
import { importSettingsPage } from '@renderer/components/routeImporters'
import { useRouteIdlePreload } from '@renderer/components/useRouteIdlePreload'
import { isEmbeddingModel, isRerankModel } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useContextPresentation, usePresentationTopicMessages } from '@renderer/hooks/useContextPresentation'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowTopics } from '@renderer/hooks/useStore'
import { useTimer } from '@renderer/hooks/useTimer'
import { sidebarDragMax } from '@renderer/pages/home/Messages/pairedGroupSizing'
import { usePairedReadingMin } from '@renderer/pages/home/Messages/pairedReadingMinContext'
import { anchorKeyForRoute } from '@renderer/services/anchorService'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setTopicListWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '@renderer/store/settings'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { Assistant, Model, Topic } from '@renderer/types'
import { Flex } from 'antd'
import { debounce } from 'lodash'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import React, { useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { ChatBranchCatalogProvider } from './ChatBranchCatalog'
import { ChatRouteStructureProvider, useChatRouteStructure } from './ChatRouteStructure'
import ChatNavbar from './components/ChatNavBar'
import Inputbar from './Inputbar/Inputbar'
import ConversationNavigation from './Messages/ConversationNavigation'
import { NAV_GUTTER_WIDTH_PX } from './Messages/MessageOutline'
import Messages, { type MessagesHandle, type ReadingAnchorReport } from './Messages/Messages'
import Tabs from './Tabs'

const logger = loggerService.withContext('Chat')

interface Props {
  assistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  setActiveAssistant: (assistant: Assistant) => void
  chatColumnMin?: number
}

const Chat: FC<Props> = (props) => {
  const { assistant, updateAssistant, updateTopic } = useAssistant(props.assistant.id)
  const { t } = useTranslation()
  // LOCK-105: message style is always bubble; messageNavigation is a boolean
  // off/on toggle for the conversation navigation list.
  const { messageNavigation } = useSettings()
  const { showTopics } = useShowTopics()
  const dispatch = useAppDispatch()
  const assistantsWidth = useAppSelector((s) => s.settings.assistantsWidth)
  const showAssistants = useAppSelector((s) => s.settings.showAssistants)
  const chatColumnMin = props.chatColumnMin ?? 0
  // Live window width shared with the home layout: the fixed-window budget must
  // follow real resize events, not a render-time snapshot.
  const { windowWidth: liveWindowWidth } = usePairedReadingMin()

  const mainRef = React.useRef<HTMLDivElement>(null)
  const contentSearchRef = React.useRef<ContentSearchRef>(null)
  const messagesRef = React.useRef<MessagesHandle>(null)
  // Gutter-strip wheel: the nav gutter below is this row's own padding (only
  // while the navigator is mounted), so a wheel parked over the strip
  // (outside the rail's halo) lands on this host instead of the chat
  // scroller. Forward it to #messages so the strip keeps the scroll behavior
  // the full-width message boxes used to give it. Wheels bubbling up from
  // message content already scrolled natively and are left alone (target
  // check), so nothing scrolls twice. Pinch-zoom gestures are never
  // forwarded; line/page wheel modes are normalized to pixels (16px per
  // line, one viewport per page) and both axes are forwarded.
  const handleNavGutterWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.ctrlKey || event.metaKey) return
    const scroller = event.currentTarget.querySelector('#messages')
    if (!scroller) return
    let { deltaX, deltaY } = event
    if (event.deltaMode === 1) {
      deltaX *= 16
      deltaY *= 16
    } else if (event.deltaMode === 2) {
      deltaX *= scroller.clientHeight
      deltaY *= scroller.clientHeight
    }
    scroller.scrollBy({ left: deltaX, top: deltaY })
  }
  const [filterIncludeUser, setFilterIncludeUser] = useState(false)
  const [readingAnchor, setReadingAnchor] = useState<ReadingAnchorReport | null>(null)
  // S3.5: ContentSearch is parent-owned lazy activation — zero instance before invocation.
  const [isContentSearchActive, setIsContentSearchActive] = useState(false)
  const [pendingSearchText, setPendingSearchText] = useState<string | undefined>(undefined)
  const isSearchActiveRef = React.useRef(isContentSearchActive)
  React.useEffect(() => {
    isSearchActiveRef.current = isContentSearchActive
  }, [isContentSearchActive])

  const firstUpdateCompletedRef = React.useRef(false)
  const [chatStableForIdlePreload, setChatStableForIdlePreload] = useState(false)
  const userToggleRaf1Ref = React.useRef<number | null>(null)
  const userToggleRaf2Ref = React.useRef<number | null>(null)
  const { setTimeoutTimer, clearTimeoutTimer } = useTimer()

  // Reset first-update stability when the real topic id changes; cancel any
  // pending first-update timer. First mount is not a switch, so it never
  // clears. Layout timing matters: Messages fires onFirstUpdate in a passive
  // effect, so this parent reset runs first (layout before passive) — a real
  // switch clears the previous topic timer before the new topic schedules
  // its own, instead of dropping the just-scheduled timer.
  const prevTopicIdForStableResetRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (prevTopicIdForStableResetRef.current === null) {
      prevTopicIdForStableResetRef.current = props.activeTopic.id
      return
    }
    if (prevTopicIdForStableResetRef.current === props.activeTopic.id) {
      return
    }
    prevTopicIdForStableResetRef.current = props.activeTopic.id
    firstUpdateCompletedRef.current = false
    setChatStableForIdlePreload(false)
    // Clear pending firstUpdate timer if any (owned via useTimer)
    clearTimeoutTimer('messagesComponentFirstUpdateHandler')
  }, [props.activeTopic.id, clearTimeoutTimer])

  // Single-level idle preload: only the Settings JS module, scheduled in a
  // cancellable browser idle task after the existing first-update stability
  // window. Never mounts Settings, never touches Redux/bootstrap, never
  // blocks the startup path; unmount or topic switch cancels a pending task.
  useRouteIdlePreload(importSettingsPage, chatStableForIdlePreload)

  // --- Shared context projection (Chat-scoped, route B) ---
  // Single accepted model for one route: identity (topic/route/anchor) plus
  // the accepted full closure snapshot composed with the execution-owned
  // overlay. Bodies come from the closure's own block snapshot — never from
  // ordinary `messageBlocks` hydration (that write path is exited). The same
  // accepted snapshot decides counts/highlight/divider/token estimate, and
  // follows the active execution body while streaming. A cold/pending route
  // stays authority-pending (no viewport-count authority); an empty or
  // anchorless route uses the legitimate bounded fallback. Identity
  // fail-closed: a retained projection for another topic/route/anchor never
  // displays. Leaving the route releases the UI-held snapshot (unsubscribe)
  // without terminating the execution; terminal handoff runs on new accepted
  // closures, retaining the accepted projection when revalidation fails.
  // ConversationService/baseCallbacks calls remain independent.
  // Route-scoped anchor key: branch routes anchor under their own route key
  // (anchorKeyForRoute returns the plain topicId for the main route).
  const activeBranchId = useAppSelector((state) => selectActiveBranchId(state, props.activeTopic.id))
  const anchorRouteKey = anchorKeyForRoute(props.activeTopic.id, activeBranchId)
  const anchorGroupKey = getAssistantSettings(assistant).contextWindowAnchor?.[anchorRouteKey]?.groupKey ?? null
  const topicMessages = usePresentationTopicMessages(props.activeTopic.id)
  // Only the shared context derivation crosses this boundary; its explicit
  // blockSnapshot remains paired with the messages used for token estimation.
  const contextPresentation = useContextPresentation({
    topicId: props.activeTopic.id,
    anchorGroupKey,
    branchId: activeBranchId,
    topicMessages,
    assistant
  })
  const { sharedContextInfo } = contextPresentation
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
      updateAssistant({
        model: selectedModel
      })
    }
  })

  /**
   * Search-scope filter. Memoized on its only dependency: ContentSearch keys
   * its search routine on this prop, and a per-render object identity would
   * re-run the committed query on every Chat render (each viewport update),
   * resetting the located match back to the first hit and re-positioning the
   * viewport. Stable identity keeps one query = one committed match set.
   */
  const contentSearchFilter: NodeFilter = React.useMemo(
    () => ({
      acceptNode(node: Node) {
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
    }),
    [filterIncludeUser]
  )

  /**
   * Chat-owned match positioning for the Cmd/Ctrl+F search.
   *
   * `#chat-main` is the search target but `#messages` is the scroll owner, and
   * the reading position belongs to the Messages viewport authority — a generic
   * element scroll lands on the wrong owner and the route keeper reverts it on
   * the next layout pass. Messages therefore positions the match through its own
   * explicit navigation transaction, landing on the exact matched text and
   * adopting its row as the reading anchor.
   *
   * The whole located match is forwarded (range, owning element and the search
   * panel covering the viewport), because only Messages can measure the live
   * container and exclude the panel. A match with no owning message row (or no
   * live Messages handle) keeps the generic ContentSearch scroll.
   */
  const locateContentSearchMatch = React.useCallback((match: ContentSearchLocatedMatch): boolean => {
    const messages = messagesRef.current
    if (!messages) return false
    return messages.scrollToSearchMatch(match)
  }, [])

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
        setChatStableForIdlePreload(true)
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
            {/* ONE branch catalog request per topic for the chat surface: the
                navbar's selector, the flow's fork dividers and the navigation
                list all project the same Redux catalog. */}
            <ChatBranchCatalogProvider topicId={props.activeTopic.id}>
              {/* Viewport scope is owned by HomePage (single provider above Navbar/Tabs/Chat). */}
              <ChatNavbar
                activeAssistant={props.assistant}
                activeTopic={props.activeTopic}
                setActiveTopic={props.setActiveTopic}
              />
              <div
                className="flex flex-1 flex-col justify-between"
                style={{ height: `calc(${mainHeight} - var(--navbar-height))` }}>
                <ChatRouteStructureProvider topicId={props.activeTopic.id}>
                  {/*
                     Nav/content layer boundary (single contract, no per-component
                     z-fix). While the navigator is mounted the message column is
                     offset by the nav gutter as this row's own padding, so no
                     message box ever covers the rail strip; the overlay nav sorts
                     before the column with no layer of its own while collapsed, so
                     sibling order paints all ordinary content above it (overlapping
                     pixels hit the message, only the exposed rail hovers) and its
                     expanded panel rises above content by its own rule. The gutter
                     strip belongs to this host's box (below the overlay), with
                     wheel forwarded so the strip keeps scrolling the chat. With
                     navigation off there is no padding and no forwarder: native
                     content width is restored and no dead indent remains.
                   */}
                  <div
                    style={{
                      position: 'relative',
                      display: 'flex',
                      flex: 1,
                      minHeight: 0,
                      paddingLeft: messageNavigation ? NAV_GUTTER_WIDTH_PX : 0
                    }}
                    onWheel={messageNavigation ? handleNavGutterWheel : undefined}>
                    {messageNavigation && (
                      <RouteScopedConversationNavigation
                        topicId={props.activeTopic.id}
                        readingAnchor={readingAnchor}
                        onNavigate={(id) => messagesRef.current?.scrollToMessageById(id)}
                        contextBoundaryMessageId={sharedContextInfo.boundaryMessageId ?? null}
                      />
                    )}
                    <Messages
                      ref={messagesRef}
                      assistant={assistant}
                      topic={props.activeTopic}
                      setActiveTopic={props.setActiveTopic}
                      onComponentUpdate={messagesComponentUpdateHandler}
                      onFirstUpdate={messagesComponentFirstUpdateHandler}
                      sharedContextInfo={sharedContextInfo}
                      onReadingAnchor={setReadingAnchor}
                    />
                  </div>
                  {isContentSearchActive && (
                    <ContentSearch
                      ref={contentSearchRef}
                      searchTarget={mainRef as React.RefObject<HTMLElement>}
                      filter={contentSearchFilter}
                      includeUser={filterIncludeUser}
                      onIncludeUserChange={userOutlinedItemClickHandler}
                      initialText={pendingSearchText}
                      onLocateMatch={locateContentSearchMatch}
                      onClose={disableContentSearch}
                    />
                  )}
                  <Inputbar
                    assistant={assistant}
                    setActiveTopic={props.setActiveTopic}
                    topic={props.activeTopic}
                    sharedContextInfo={sharedContextInfo}
                  />
                </ChatRouteStructureProvider>
              </div>
            </ChatBranchCatalogProvider>
          </Main>
        </motion.div>
        {showTopics &&
          (() => {
            const leftVisible = showAssistants ? assistantsWidth : 0
            const winW = liveWindowWidth
            // Same chat-budget clamp as the left panel: a fixed window is never
            // squeezed below the reading minimum by widening the topic list.
            const rightMax = winW > 0 ? sidebarDragMax(winW, leftVisible, chatColumnMin) : SIDEBAR_MAX_WIDTH
            return (
              <ResizableHandle
                cssVar="--topic-list-width"
                minWidth={SIDEBAR_MIN_WIDTH}
                maxWidth={rightMax}
                onResizeEnd={(width) => dispatch(setTopicListWidth(width))}
                side="right"
              />
            )
          })()}
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

/**
 * Navigation wiring for the chat surface: the surface owns ONE route structure
 * read (`ChatRouteStructureProvider`), so the outline receives that provider's
 * accepted segment projection instead of issuing a second structural read for
 * the same route. Mounted only inside the provider.
 */
const RouteScopedConversationNavigation: FC<{
  topicId: string
  readingAnchor: ReadingAnchorReport | null
  onNavigate: (messageId: string) => void
  contextBoundaryMessageId: string | null
}> = ({ topicId, readingAnchor, onNavigate, contextBoundaryMessageId }) => {
  const { segments } = useChatRouteStructure()
  return (
    <ConversationNavigation
      topicId={topicId}
      readingAnchor={readingAnchor}
      onNavigate={onNavigate}
      segments={segments}
      contextBoundaryMessageId={contextBoundaryMessageId}
    />
  )
}

export default Chat
