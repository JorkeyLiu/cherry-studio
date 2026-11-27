import { loggerService } from '@logger'
import type { ContentSearchLocatedMatch, ContentSearchRef } from '@renderer/components/ContentSearch'
import { ContentSearch } from '@renderer/components/ContentSearch'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup'
import { importSettingsPage } from '@renderer/components/routeImporters'
import { useRouteIdlePreload } from '@renderer/components/useRouteIdlePreload'
import { isMac } from '@renderer/config/constant'
import { isEmbeddingModel, isRerankModel } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useContextClosure } from '@renderer/hooks/useContextClosure'
import { useFullscreen } from '@renderer/hooks/useFullscreen'
import { useLoadedTopicMessages, useLoadedTopicReferencedBlocks } from '@renderer/hooks/useMessageOperations'
import { useRouteScopedSegments } from '@renderer/hooks/useRouteScopedSegments'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTimer } from '@renderer/hooks/useTimer'
import { anchorKeyForRoute } from '@renderer/services/anchorService'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import { isAcceptedClosureForRoute } from '@renderer/services/contextClosure'
import { resolveSharedContextInfo } from '@renderer/services/contextInfoService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { useAppSelector } from '@renderer/store'
import { selectMessageBlocksByIds } from '@renderer/store/messageBlock'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { Assistant, Model, Topic } from '@renderer/types'
import { Flex } from 'antd'
import { debounce } from 'lodash'
import { motion } from 'motion/react'
import type { FC } from 'react'
import React, { useMemo, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'
import { shallowEqual } from 'react-redux'
import styled from 'styled-components'

import ChatNavbar from './components/ChatNavBar'
import Inputbar from './Inputbar/Inputbar'
import {
  COMPOSER_OVERLAY_HEIGHT_VAR,
  COMPOSER_TAIL_INSET_VAR,
  resolveComposerTailInset,
  useComposerOverlayHeight
} from './Messages/composerOverlayGeometry'
import ConversationNavigation from './Messages/ConversationNavigation'
import { NAV_GUTTER_WIDTH_PX } from './Messages/MessageOutline'
import Messages, { type MessagesHandle, type ReadingAnchorReport } from './Messages/Messages'

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

  const mainRef = React.useRef<HTMLDivElement>(null)
  const contentSearchRef = React.useRef<ContentSearchRef>(null)
  const messagesRef = React.useRef<MessagesHandle>(null)
  const composerRef = React.useRef<HTMLDivElement>(null)
  // Floating composer overlay: single measured border-box height (layout-phase
  // first measure + ResizeObserver updates; local state only, never Redux).
  // The tail inset (measured height + existing control band) is published as
  // local CSS vars on the canvas below; scroll padding reads the same vars.
  const composerOverlayHeight = useComposerOverlayHeight(composerRef)
  const composerTailInset = resolveComposerTailInset(composerOverlayHeight)
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
  // useLoadedTopicReferencedBlocks subscribes only to active-topic referenced blocks
  // (selectMessageBlocksByIds + shallowEqual), so unrelated block commits do
  // not invalidate this projection.
  // Bounded loaded projection: resident topic only; the `?? []` fallback is
  // memoized so the shared-projection memo keeps a stable identity while the
  // topic is non-resident (`undefined` stays at the API boundary).
  const loadedTopicMessages = useLoadedTopicMessages(props.activeTopic.id)
  const topicMessages = useMemo(() => (loadedTopicMessages ?? []) as any, [loadedTopicMessages])
  const topicBlocks = useLoadedTopicReferencedBlocks(props.activeTopic.id)
  // Route-scoped anchor key: branch routes anchor under their own route key
  // (anchorKeyForRoute returns the plain topicId for the main route).
  const activeBranchId = useAppSelector((state) => selectActiveBranchId(state, props.activeTopic.id))
  const anchorRouteKey = anchorKeyForRoute(props.activeTopic.id, activeBranchId)
  const anchorGroupKey = getAssistantSettings(assistant).contextWindowAnchor?.[anchorRouteKey]?.groupKey ?? null
  const { closure: acceptedClosure } = useContextClosure(props.activeTopic.id, anchorGroupKey, activeBranchId)
  // Root regression correction: UI context is the atomically ACCEPTED
  // complete-route projection from the hook. For the SAME topic/route/anchor,
  // ordinary streamed text/status updates (which bump strict cache generation
  // every chunk) NEVER clear this — the hook retains it while background
  // revalidation runs and commits the full result in one coherent step.
  // Identity fail-closed here too: a retained projection for a different
  // topic/anchor never displays (no previous-route counts/divider). Strict
  // cache freshness (`getFreshValidatedClosure`) is intentionally NOT
  // consulted for display; it remains the gate for cache reads/requests only.
  // Route isolation is enforced by the hook's route-key identity
  // (closureKeyForRoute); the acceptance helper below checks topic/anchor
  // structural identity only and takes no branch param.
  const freshClosure = useMemo(() => {
    if (!acceptedClosure) return null
    if (!isAcceptedClosureForRoute(acceptedClosure, props.activeTopic.id, anchorGroupKey)) {
      return null
    }
    return acceptedClosure
  }, [acceptedClosure, props.activeTopic.id, anchorGroupKey])
  // Subscribe to closure-referenced blocks when closure is active so filterEmptyMessages invalidation covers closure blocks
  const closureBlockIds = useMemo(
    () => (freshClosure ? freshClosure.messages.flatMap((m: any) => (m.blocks ?? []) as string[]) : []),
    [freshClosure]
  )
  const closureBlocks = useAppSelector((state) => selectMessageBlocksByIds(state, closureBlockIds), shallowEqual)
  // Use closure blocks for memo invalidation when closure active; otherwise use viewport blocks
  const activeBlocksForContext = freshClosure ? closureBlocks : topicBlocks
  const sharedContextInfo = useMemo(() => {
    // LOCK-001/003: authoritative closure supplies anchorGroupKey, boundaryMessageId and contextCount {current:selectedTurnCount,max:totalTurnCount} when fresh; persisted-anchor miss renders authority-pending (no viewport counts); only anchorless (empty/uninitialized) uses the bounded fallback
    // Ordinary preexisting derivation: accepted retain alone solves the blank
    // flicker. No id-only reference freeze here — same-ID updated blocks or
    // new Message instances must flow through so the token-estimate input
    // never references stale history. The scalar estimate updates via content
    // reads; it is never zeroed per chunk.
    const result = resolveSharedContextInfo(
      topicMessages,
      assistant,
      props.activeTopic.id,
      freshClosure as any,
      activeBranchId
    )
    return result
  }, [freshClosure, topicMessages, activeBlocksForContext, assistant, props.activeTopic.id, activeBranchId])
  // Route-scoped group segments for the navigator's C spines: the same
  // route-local projection the drawer and message flow consume. The outline
  // maps members onto its own rows, so the nav never re-derives membership.
  const { segments: routeSegments } = useRouteScopedSegments(props.activeTopic.id)
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

  const isFullscreen = useFullscreen()
  // Single source for the overlay band height: the mac traffic-light strip
  // (titlebar-area) outside fullscreen, navbar-height everywhere else.
  // Published as --chat-band on #chat-main so the overlay titlebar root,
  // the fade and the message top safe area derive from the same value.
  // max() keeps a reliable 30px floor: a missing or zero
  // env(titlebar-area-height) never collapses the band (or the sidebar
  // band synced to the same expression).
  const chatBand = !isMac || isFullscreen ? 'var(--navbar-height)' : 'max(30px, env(titlebar-area-height, 30px))'

  return (
    // LOCK-105: message style is always bubble.
    <Container id="chat" className="bubble">
      <ChatRow>
        <motion.div
          layout
          transition={{ duration: 0.3, ease: 'easeInOut' }}
          style={{ flex: 1, display: 'flex', minWidth: 0, minHeight: 0, alignSelf: 'stretch', overflow: 'hidden' }}>
          <Main
            ref={mainRef}
            id="chat-main"
            vertical
            flex={1}
            justify="space-between"
            style={{ width: '100%', '--chat-band': chatBand } as React.CSSProperties}>
            {/* Viewport scope is owned by HomePage (single provider above WorkspaceSidebar/Chat). */}
            <ChatCanvas
              style={
                {
                  [COMPOSER_OVERLAY_HEIGHT_VAR]: `${composerOverlayHeight}px`,
                  [COMPOSER_TAIL_INSET_VAR]: `${composerTailInset}px`
                } as React.CSSProperties
              }>
              <MessagePlane>
                {/*
                   Message/composer plane boundary (single contract, no per-component
                   z-fix). MessagePlane fills the canvas; ComposerPlane floats above it.
                   While the navigator is mounted the message column is offset by the
                   nav gutter as this row's own padding, so no message box ever covers
                   the rail strip; the overlay nav sorts
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
                    <ConversationNavigation
                      topicId={props.activeTopic.id}
                      readingAnchor={readingAnchor}
                      onNavigate={(id) => messagesRef.current?.scrollToMessageById(id)}
                      segments={routeSegments}
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
              </MessagePlane>
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
              <ComposerPlane ref={composerRef}>
                <Inputbar
                  assistant={assistant}
                  setActiveTopic={props.setActiveTopic}
                  topic={props.activeTopic}
                  sharedContextInfo={sharedContextInfo}
                />
              </ComposerPlane>
            </ChatCanvas>
            {/* Overlay titlebar: last sibling above the canvas so no later
            content region can cover its blank-pixel drag hits. Wraps no
            message or composer content; the drag range stays the band. */}
            <ChatNavbar
              activeAssistant={assistant}
              activeTopic={props.activeTopic}
              setActiveTopic={props.setActiveTopic}
            />
          </Main>
        </motion.div>
      </ChatRow>
    </Container>
  )
}

const Container = styled.div`
   display: flex;
   flex-direction: column;
   flex: 1;
   min-height: 0;
   min-width: 0;
   overflow: hidden;
 `
/**
 * The single height-constrained row of the chat column: explicit stretch
 * replaces the ambiguous shared HStack (which defaults to
 * align-items: flex-start and lets children size to content, pushing the
 * composer out of the window). Every level keeps min-height/min-width: 0 so
 * #messages stays the only scroller.
 */
const ChatRow = styled.div`
   display: flex;
   flex: 1;
   flex-direction: row;
   align-items: stretch;
   min-height: 0;
   min-width: 0;
   overflow: hidden;
 `

const Main = styled(Flex)`
   flex: 1;
   min-height: 0;
   min-width: 0;
   position: relative;
 `

// The two planes inside the canvas. MessagePlane fills the whole canvas and
// owns the message column (navigator + Messages); ComposerPlane floats over
// its bottom and owns the measured composer box. Plane z (1 below 2) is the
// only order that matters here: every internal message z (labels 1000, nav
// 999/expanded 1001, drawer 1004/1005) keeps its relative order but paints
// below the composer, with no per-component fix. Neither plane declares a
// drag region: they were never inside a drag header, and the overlay
// titlebar stays the canvas's sibling above.
const MessagePlane = styled.div`
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
`

const ComposerPlane = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
`

/**
 * The single positioning content plane of the chat column: the sibling the
 * overlay titlebar (ChatNavBar) floats above. One isolation boundary here
 * keeps overlay/message/nav/composer paint order local to this canvas, so
 * nothing inside #messages needs its own context or z-index fix.
 */
const ChatCanvas = styled.div`
   position: relative;
   z-index: 0;
   isolation: isolate;
   display: flex;
   flex: 1;
   flex-direction: column;
   justify-content: space-between;
   min-height: 0;
   min-width: 0;
 `

export default Chat
