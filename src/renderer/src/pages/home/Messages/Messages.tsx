import { loggerService } from '@logger'
import EditModeActionBar from '@renderer/components/EditModeActionBar'
import { LoadingIcon } from '@renderer/components/Icons'
import { LOAD_MORE_COUNT } from '@renderer/config/constant'
import { EditModeProvider, useEditMode } from '@renderer/context/EditModeContext'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useClipboardKeyboard } from '@renderer/hooks/useClipboardKeyboard'
import { useMessageActionController } from '@renderer/hooks/useMessageActionController'
import { useMessageOperations, useTopicLoading, useTopicMessages } from '@renderer/hooks/useMessageOperations'
import useScrollPosition from '@renderer/hooks/useScrollPosition'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTimer } from '@renderer/hooks/useTimer'
import { autoRenameTopic } from '@renderer/hooks/useTopic'
import { useTopicSegments } from '@renderer/hooks/useTopicSegments'
import { useTopicTransition } from '@renderer/hooks/useTopicTransition'
import { findFirstVisibleMessage } from '@renderer/pages/home/Messages/domVisibility'
import { branchFromAnchorMessage } from '@renderer/pages/home/Messages/messageBranch'
import type { MessageViewportGroup } from '@renderer/pages/home/Messages/messageGroups'
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
import { projectMessageViewportGroups } from '@renderer/pages/home/Messages/messageViewportProjection'
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
  clampWindowCount,
  createLatestMessageWindow,
  expandMessageWindowNewer,
  expandMessageWindowOlder,
  getLatestWindowCompleteness,
  mergeWindowIntoTopic,
  type MessageWindow,
  reconcileMessageWindow
} from '@renderer/pages/home/Messages/messageWindow'
import SelectionBox from '@renderer/pages/home/Messages/SelectionBox'
import { buildGroupList, ensureTopicAnchorEstablished, inheritAnchorForBranch } from '@renderer/services/anchorService'
import { getAssistantSettings, getDefaultTopic } from '@renderer/services/AssistantService'
import type { computeContextInfo } from '@renderer/services/contextInfoService'
import { ensureOrdinaryTopicOwnership } from '@renderer/services/db/topicTrashLifecycle'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { clearPendingNavigate, getPendingNavigate } from '@renderer/services/MessagesService'
import {
  currentPhaseCorrelation,
  recordPhaseDurationForCorrelation,
  recordPhaseEndpoint
} from '@renderer/services/phaseTimingDiagnostics'
import {
  captureDeletionGeneration,
  getDeletionGeneration,
  isDeletionStale,
  subscribeDeletionGeneration
} from '@renderer/services/topicDeletionInvalidation'
import { isValidWindowResponse, isWindowCovering } from '@renderer/services/windowCoverage'
import store, { useAppDispatch } from '@renderer/store'
import { messageBlocksSelectors, updateOneBlock, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import { updateMessageAndBlocksThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant, Topic } from '@renderer/types'
import type { MessageBlock } from '@renderer/types/newMessage'
import { type Message, MessageBlockType } from '@renderer/types/newMessage'
import {
  captureScrollableAsBlob,
  captureScrollableAsDataURL,
  removeSpecialCharactersForFileName
} from '@renderer/utils'
import { scrollIntoView } from '@renderer/utils/dom'
import { updateCodeBlock } from '@renderer/utils/markdown'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { isTextLikeBlock } from '@renderer/utils/messageUtils/is'
import { runTopicWindowRead } from '@renderer/utils/windowReadQueue'
import type { FetchMessagesWindowRequest, FetchMessagesWindowResponse } from '@shared/chatDb'
import { last } from 'lodash'
import {
  Fragment,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef
} from 'react'
import { useTranslation } from 'react-i18next'
import InfiniteScroll from 'react-infinite-scroll-component'
import styled from 'styled-components'

import { AnchorGroupProvider } from './anchorGroupContext'
import MessageContextMenu from './MessageContextMenu'
import MessageGroup from './MessageGroup'
import { buildRenderLayers, buildRenderSegments, deriveStableGroupId } from './messageRenderLayers'
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
  /** Shared context projection computed once at Chat level (Phase 2B).
   *  Messages consumes boundaryMessageId and anchorGroupKey from this result. */
  sharedContextInfo: ReturnType<typeof computeContextInfo>
}

export interface MessagesHandle {
  scrollToMessageById: (messageId: string) => void
  scrollToBottom: () => void
  scrollToTop: () => void
  scrollToContextBoundary: () => void
  previousUserMessage: (currentMessageId: string) => void
  nextUserMessage: (currentMessageId: string) => void
}

const logger = loggerService.withContext('Messages')

interface MessagesContentProps {
  assistant: Assistant
  topic: Topic
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  handleScrollPosition: () => void
  displayMessages: Message[]
  displayGroups: MessageViewportGroup[]
  contextBoundaryMessageId: string | null
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
  displayGroups,
  contextBoundaryMessageId,
  hasMore,
  isLoadingMore,
  isLoadingNewer,
  loadMoreMessages,
  registerMessageElement
}) => {
  const { t } = useTranslation()

  const { isEnabled: isEditMode, selectedGroupIds, handleGroupClick } = useEditMode()
  const { isMessageFirstInSegment, isMessageLastInSegment, isMessageInSegment } = useTopicSegments(topic.id)
  useClipboardKeyboard()

  // Canonical viewport projection (S6.2a): displayGroups are precomputed
  // canonical groups (consecutive assistant messages sharing a non-empty askId
  // form one group; all other messages are singleton groups). Projection is
  // one-to-one (no cross-run merge/split), newest group first (column-reverse
  // outer), oldest message first within each group, viewport-local indices
  // (0 = newest in displayMessages), and canonical keys (group.key) with
  // stable entity-derived Fragment keys.
  const groupedMessages = useMemo(() => {
    const active = currentPhaseCorrelation()
    const startedAt = active ? performance.now() : 0
    const result = projectMessageViewportGroups(displayMessages, displayGroups)
    if (active && displayMessages.length > 0) {
      recordPhaseDurationForCorrelation(
        active.correlationId,
        active.path,
        active.path === 'echo' ? 'echo.visibleGroupModel' : 'topic.visibleGroupModel',
        performance.now() - startedAt
      )
    }
    return result
  }, [displayGroups, displayMessages])

  // S3.3: Stable render layers — edit-mode segmentation runs first,
  // each segment is then classified live/history, then contiguous runs of
  // the same kind are merged into layer runs. Selection segments are never
  // split at a history/live boundary; a mixed segment is live if any group is live.
  const messageSegments = useMemo(
    () => buildRenderSegments(groupedMessages, isEditMode, selectedGroupIds),
    [groupedMessages, isEditMode, selectedGroupIds]
  )

  const layerRuns = useMemo(() => buildRenderLayers(messageSegments), [messageSegments])

  // Context window boundary: find the legacy projected group key where the boundary message renders.
  // The legacy key is retained for context-divider semantics while stable entity-derived
  // keys are used for React reconciliation (LOCK-S3.3-007).
  const contextDividerGroupKey = useMemo(() => {
    if (!contextBoundaryMessageId) return null
    for (const [key, groupMessages] of groupedMessages) {
      if (groupMessages.some((m) => m.id === contextBoundaryMessageId)) {
        return key
      }
    }
    // Boundary message not in the current display window — don't show a divider
    return null
  }, [groupedMessages, contextBoundaryMessageId])

  const renderMessageSegments = () => {
    const result: React.ReactNode[] = []

    // LOCK-S3.3-FIX-003: no outer React key whose identity changes with layer
    // membership/composition. Groups/selection blocks are stable entity-derived
    // siblings so overlapping history DOM survives live updates, live→history
    // transitions, and viewport expansion. Layer kind/run identity is exposed
    // only via data-* on existing elements (LOCK-S3.3-FIX-004).
    for (const layer of layerRuns) {
      for (const seg of layer.segments) {
        const kind = seg.isLive ? 'live' : 'history'
        const content = seg.items.map(([legacyKey, groupMessages]) => {
          const firstMsg = groupMessages[0]
          const segment = firstMsg ? isMessageInSegment(firstMsg.id) : undefined
          const isFirst = firstMsg ? !!isMessageFirstInSegment(firstMsg.id) : false
          const lastMsg = groupMessages[groupMessages.length - 1]
          const isLast = lastMsg ? !!isMessageLastInSegment(lastMsg.id) : false
          const stableGroupId = deriveStableGroupId(groupMessages as readonly Message[])

          return (
            <Fragment key={stableGroupId}>
              <div
                style={{ position: 'relative' }}
                data-layer-kind={kind}
                data-stable-group-id={stableGroupId}
                data-layer-run-id={layer.stableLayerId}>
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
              {/* Divider uses the retained legacy projected key for semantics;
                  reconciliation uses stableGroupId above. */}
              {legacyKey === contextDividerGroupKey && (
                <ContextWindowDivider data-context-boundary data-testid="context-boundary">
                  <ContextWindowDividerLine />
                  <ContextWindowDividerText>{t('chat.context_window_start')}</ContextWindowDividerText>
                  <ContextWindowDividerLine />
                </ContextWindowDivider>
              )}
            </Fragment>
          )
        })

        if (seg.selected) {
          result.push(
            <SelectionBlock
              key={seg.stableSegmentId}
              data-layer-kind={kind}
              data-stable-segment-id={seg.stableSegmentId}
              data-layer-run-id={layer.stableLayerId}>
              {content}
            </SelectionBlock>
          )
        } else {
          result.push(...content)
        }
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
      <div style={{ display: 'flex', flexDirection: 'column-reverse' }}>
        <InfiniteScroll
          dataLength={displayMessages.length}
          next={loadMoreMessages}
          hasMore={hasMore}
          loader={null}
          scrollableTarget="messages"
          inverse
          style={{ overflow: 'visible' }}>
          <MessageContextMenu topicId={topic.id}>
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
          </MessageContextMenu>
        </InfiniteScroll>

        {/* Prompts always render; the persisted showPrompt setting is inert. */}
        <Prompt assistant={assistant} key={assistant.prompt} topic={topic} />
      </div>
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
  onFirstUpdate,
  sharedContextInfo
}: MessagesProps & { ref?: React.RefObject<MessagesHandle | null> }) => {
  const {
    containerRef: scrollContainerRef,
    handleScroll: handleScrollPosition,
    getSavedPosition,
    savePosition
  } = useScrollPosition(`topic-${topic.id}`)
  const [viewportState, reduceViewport] = useReducer(messageViewportReducer, null, createMessageViewportState)
  const displayMessages = useMemo(() => viewportState.window?.displayMessages ?? [], [viewportState.window])
  const displayGroups = useMemo(() => viewportState.window?.displayGroups ?? [], [viewportState.window])
  const hasMore = viewportState.window?.hasMoreOlder ?? false
  const hasMoreNewer = viewportState.window?.hasMoreNewer ?? false
  const isLoadingMore = viewportState.loading.older
  const isLoadingNewer = viewportState.loading.newer

  const { addTopic, updateAssistantSettings } = useAssistant(assistant.id)
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const messages = useTopicMessages(topic.id)
  const isTopicLoading = useTopicLoading(topic)
  const { displayCount, createTopicBranchByAnchor } = useMessageOperations(topic)
  const { selectAnswer } = useMessageActionController()
  const { setTimeoutTimer, clearTimeoutTimer } = useTimer()
  const phaseAtRender = currentPhaseCorrelation()
  const phaseRenderStartedAt = phaseAtRender ? performance.now() : 0

  const { isMultiSelectMode, handleSelectMessage } = useChatContext(topic)

  const messageElements = useRef<Map<string, HTMLElement>>(new Map())
  const messagesRef = useRef<Message[]>(messages)
  const previousMessagesRef = useRef<Message[]>(messages)
  const viewportStateRef = useRef(viewportState)
  // S6.1: per-topic last window cache for coverage checks (fail-closed, generation-owned)
  const windowCacheRef = useRef<Map<string, FetchMessagesWindowResponse>>(new Map())
  const viewportCommitWaiterRef = useRef(createViewportCommitWaiter<typeof viewportState>())
  /** PERF-101: per-correlation one-shot guard for topic.messagesMount.
   *  The useLayoutEffect dependency array includes phaseAtRender (a new
   *  object reference on every render when phase is active) and
   *  phaseRenderStartedAt (performance.now() on every render), causing
   *  the effect to fire more than once per topic window application.
   *  This ref tracks the last correlationId for which messagesMount was
   *  recorded; duplicate records for the same correlation are skipped. */
  const messagesMountCorrelationRef = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    viewportStateRef.current = viewportState
    viewportCommitWaiterRef.current.notify(viewportState)
  }, [viewportState])
  // S6.1: clear per-topic window cache on topic change / generation reset
  useEffect(() => {
    windowCacheRef.current.clear()
  }, [topic.id, viewportState.topicGeneration])
  const savedRestoreHandledRef = useRef(false)
  const bootstrapPhaseRef = useRef<BootstrapPhase>('idle')
  // S3.1 Blocker 4 correction: onFirstUpdateFiredRef must be declared before
  // useTopicTransition so the resetOnFirstUpdate callback can reference it.
  const onFirstUpdateFiredRef = useRef(false)

  // S3.1 Blocker 1 correction: viewportDispatch must be declared before
  // useTopicTransition consumes it, avoiding TDZ (temporal dead zone).
  const viewportDispatch = reduceViewport

  // S3.1: transition epoch — incremented on every topic transition (including
  // A→B→A revisits) so async completion guards can reject stale callbacks even
  // when the same topic ID reappears. A closure-captured topic.id guard alone
  // fails for A→B→A because the old closure's topic.id matches the revisited
  // topic.id.
  const transitionEpochRef = useRef(0)

  // Deletion epoch subscription — synchronously invalidate the mounted viewport
  // projection for this topic when authoritative hard deletion advances.
  // Clears the per-topic window cache, cancels pending timers/commit waiters,
  // and resets the local viewport window to an empty valid state while
  // advancing navigation/topic generations so stale local callbacks cannot
  // re-publish deleted content. Per-topic only; unrelated topics untouched.
  // Soft delete never bumps; failure preserves. Timers/waiters use existing
  // seams: clearTimeoutTimer for loadMoreMessages/loadNewerMessages and
  // viewportCommitWaiterRef.cancelAll for pending navigation commits.
  // Residual: if a timer callback already entered the queue before clear,
  // its generation/captured-deletion checks still discard before publication.
  useEffect(() => {
    const topicIdAtSubscribe = topic.id
    // Current-state-safe invalidation: if deletion already occurred before
    // subscription (generation nonzero), synchronously invalidate the local
    // viewport projection so no stale window is ever rendered. Otherwise
    // subscribe and re-check immediately around registration. Callback is
    // idempotent (topic/reset, cache delete, timer clear).
    const invalidate = () => {
      windowCacheRef.current.delete(topicIdAtSubscribe)
      clearTimeoutTimer('loadMoreMessages')
      clearTimeoutTimer('loadNewerMessages')
      viewportCommitWaiterRef.current.cancelAll()
      viewportDispatch({ type: 'topic/reset' })
    }
    if (getDeletionGeneration(topicIdAtSubscribe) !== 0) {
      invalidate()
      return subscribeDeletionGeneration(topicIdAtSubscribe, () => {
        invalidate()
      })
    }
    const unsub = subscribeDeletionGeneration(topicIdAtSubscribe, () => {
      invalidate()
    })
    // Re-check immediately after registration for race between check and subscribe
    if (getDeletionGeneration(topicIdAtSubscribe) !== 0) {
      invalidate()
    }
    return unsub
  }, [topic.id, clearTimeoutTimer, viewportDispatch])

  // S3.1: Explicit topic transition coordinator. Detects topic prop changes
  // and orchestrates deterministic cleanup: save old-topic scroll position,
  // viewport reset (generation advance, stale rejection), timer clearing,
  // bootstrap phase reset, and saved-restore flag reset. The component
  // remains mounted across topic changes — no key-driven remount.
  // S3.2: saveOldTopicScrollPosition is called explicitly before topic/reset
  // so the old topic's scroll is snapshotted to the old key before any
  // transition state changes.
  useTopicTransition({
    topicId: topic.id,
    viewportDispatch,
    resetBootstrapPhase: () => {
      bootstrapPhaseRef.current = 'idle'
    },
    clearTimers: () => {
      clearTimeoutTimer('loadMoreMessages')
      clearTimeoutTimer('loadNewerMessages')
    },
    resetSavedRestore: () => {
      savedRestoreHandledRef.current = false
    },
    resetOnFirstUpdate: () => {
      onFirstUpdateFiredRef.current = false
    },
    transitionEpochRef,
    saveOldTopicScrollPosition: savePosition
  })

  // Unified context info: boundary message ID, context count, and the single
  // resolved anchor from the same pipeline that ConversationService uses to
  // prepare messages for the model.
  // Phase 2B: This is now the shared projection computed once at Chat level.
  const contextInfo = sharedContextInfo
  const contextBoundaryMessageId = contextInfo.boundaryMessageId
  const anchorGroupKey = contextInfo.anchorGroupKey

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

  useLayoutEffect(() => {
    if (phaseAtRender?.path === 'topic-cache-miss' || phaseAtRender?.path === 'topic-cache-hit') {
      // PERF-101 one-shot guard: only record once per correlation.
      if (messagesMountCorrelationRef.current !== phaseAtRender.correlationId) {
        messagesMountCorrelationRef.current = phaseAtRender.correlationId
        recordPhaseDurationForCorrelation(
          phaseAtRender.correlationId,
          phaseAtRender.path,
          'topic.messagesMount',
          performance.now() - phaseRenderStartedAt
        )
      }
    }
  }, [phaseAtRender, phaseRenderStartedAt])

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
   * Event-time resolution via controller — explicit IDs only; no ref-derived
   * group array. Preserves imperative navigation/scroll exactly.
   *
   * PERF-100: ONE logical selection = ONE atomic Main SQLite command + ONE
   * plural Redux commit + exactly one updateTopicUpdatedAt dispatch.
   */
  const selectMessageForFold = useCallback(
    async (messageId: string) => {
      await selectAnswer({ topicId: topic.id, messageId })
    },
    [selectAnswer, topic.id]
  )

  useEffect(() => {
    // S3.1: Topic change detection is now owned by useTopicTransition.
    // This effect handles only window application for the current topic:
    //   Scenario 1: First load (empty viewport → apply latest window)
    //   Scenario 2: Reconcile existing window against updated messages

    // Scenario 1: First load — authoritative completeness retained from validated latest response
    if (!viewportStateRef.current.window?.displayMessages.length) {
      const active = currentPhaseCorrelation()
      const startedAt = active ? performance.now() : 0
      const completeness = getLatestWindowCompleteness(topic.id)
      const authoritative =
        completeness !== undefined
          ? { hasMoreBefore: completeness.hasMoreBefore, hasMoreAfter: completeness.hasMoreAfter }
          : undefined
      applyMessageWindow(createLatestMessageWindow(messages, displayCount, authoritative))
      if (active) {
        recordPhaseDurationForCorrelation(
          active.correlationId,
          active.path,
          active.path === 'echo' ? 'echo.windowCreate' : 'topic.windowApply',
          performance.now() - startedAt
        )
      }
      return
    }

    // Scenario 2: Reconcile the existing fixed window against the latest
    // message objects. Only a window that previously touched the latest edge
    // follows newly appended messages, retaining its prior group capacity.
    const currentWindow = viewportStateRef.current.window
    if (!currentWindow) return
    const currentDisplayMessages = currentWindow.displayMessages
    const active = currentPhaseCorrelation()
    const startedAt = active ? performance.now() : 0
    const reconciledWindow = reconcileMessageWindow(messages, previousMessagesRef.current, currentWindow)
    if (active) {
      recordPhaseDurationForCorrelation(
        active.correlationId,
        active.path,
        active.path === 'echo' ? 'echo.windowReconcile' : 'topic.windowReconcile',
        performance.now() - startedAt
      )
    }
    const newDisplayMessages = reconciledWindow.displayMessages

    if (!areMessageArraysIdentical(currentDisplayMessages, newDisplayMessages) || currentWindow !== reconciledWindow) {
      applyMessageWindow(reconciledWindow)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, displayCount])

  useEffect(() => {
    if (displayMessages.length === 0) return
    const active = currentPhaseCorrelation()
    if (active) recordPhaseEndpoint(active.path === 'echo' ? 'echo.domEndpoint' : 'topic.domEndpoint')
  }, [displayMessages])

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
   * Internal triggers (SEND_MESSAGE, bootstrap restore)
   * must use `navigate` directly without persistence.
   */
  const navigateAndSave = useCallback(
    (intent: MessageNavigationIntent) => {
      // S3.1 Blocker 2 correction: capture the transition epoch at invocation
      // so a topic change during the async navigation suppresses persistence.
      // Without this, savePosition would write to the new topic's scroll key,
      // overwriting its position with stale data from the previous topic.
      const saveEpoch = transitionEpochRef.current
      void navigate(intent).then((result) => {
        if (transitionEpochRef.current !== saveEpoch) return
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
    return new Set(displayMessages.map((m) => (m.role === 'assistant' ? (m.askId ?? m.id) : m.id)).filter(Boolean))
  }, [displayMessages])

  // NOTE: 如果设置为平滑滚动会导致滚动条无法跟随生成的新消息保持在底部位置
  const scrollToBottom = useCallback(() => {
    navigateAndSave({ kind: 'bottom', source: 'imperative' })
  }, [navigateAndSave])

  /** Internal auto-scroll without persistence — for SEND_MESSAGE. */
  const autoScrollToBottom = useCallback(() => {
    void navigate({ kind: 'bottom', source: 'imperative' })
  }, [navigate])

  const scrollToTop = useCallback(() => {
    navigateAndSave({ kind: 'top', source: 'imperative' })
  }, [navigateAndSave])

  const scrollToContextBoundary = useCallback(() => {
    if (contextBoundaryMessageId) {
      void navigate({ kind: 'message', targetId: contextBoundaryMessageId, source: 'imperative', alignment: 'start' })
    } else {
      // No boundary exists — fall through to topic oldest
      void navigate({ kind: 'top', source: 'imperative' })
    }
  }, [navigate, contextBoundaryMessageId])

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
    scrollToContextBoundary,
    previousUserMessage,
    nextUserMessage
  }))

  useEffect(() => {
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.SEND_MESSAGE, autoScrollToBottom),
      EventEmitter.on(EVENT_NAMES.SCROLL_TO_BOTTOM, scrollToBottom),
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
      EventEmitter.on(EVENT_NAMES.NEW_BRANCH, async (messageId: string) => {
        const newTopic = getDefaultTopic(assistant.id)
        newTopic.name = topic.name

        try {
          // The branch topic must exist in SQLite with its
          // assistantId before it is exposed to Redux via addTopic below.
          await ensureOrdinaryTopicOwnership(newTopic.id, assistant.id, newTopic.name)
        } catch (error) {
          logger.error('Failed to establish SQLite ownership for branch topic', error as Error)
          return
        }

        await branchFromAnchorMessage(messagesRef.current, messageId, {
          createBranchByAnchor: async (anchorId) => {
            addTopic(newTopic)
            return await createTopicBranchByAnchor(topic.id, anchorId, newTopic)
          },
          onMessageNotFound: () => {
            logger.error(`[NEW_BRANCH] Message not found: ${messageId}`)
          },
          onSuccess: () => {
            setActiveTopic(newTopic)
            void Promise.resolve(autoRenameTopic(assistant, newTopic.id)).catch((error: unknown) =>
              logger.error('autoRenameTopic failed', error as Error)
            )
            // Branch inheritance (docs/context-window.md §9): the new branch
            // deterministically inherits the parent topic's persisted anchor
            // by position (group-list index transfer), never by recomputing
            // from `contextCount`. An out-of-range parent position clamps to
            // the branch's last available group (nearest available
            // predecessor). Only the persisted anchor map is manipulated; the
            // branch topic's resolved anchor projection is derived by
            // computeContextInfo on every render.
            const assistantSettings = getAssistantSettings(assistant)
            const sourceAnchor = assistantSettings.contextWindowAnchor?.[topic.id]

            try {
              const sourceState = store.getState()
              const sourceMessageIds = sourceState.messages.messageIdsByTopic[topic.id] || []
              const sourceEntities = sourceState.messages.entities
              const sourceGroupList = buildGroupList(sourceMessageIds, (id) => sourceEntities[id])
              const newMessageIds = sourceState.messages.messageIdsByTopic[newTopic.id] || []
              const newEntities = sourceState.messages.entities
              const newGroupList = buildGroupList(newMessageIds, (id) => newEntities[id])

              const inheritedAnchor = inheritAnchorForBranch(sourceAnchor, sourceGroupList, newGroupList)
              if (inheritedAnchor) {
                // Persist the inherited branch anchor FIRST (synchronous Redux
                // dispatch) so the establishment pass below resolves it.
                updateAssistantSettings({
                  contextWindowAnchor: {
                    ...assistantSettings.contextWindowAnchor,
                    [newTopic.id]: inheritedAnchor
                  }
                })
              }

              // A non-empty branch that could not inherit (missing/invalid
              // source anchor) must still receive a persisted anchor
              // immediately: establish at the default window position.
              // Empty branches and branches with a just-inherited valid
              // anchor are idempotent no-ops (docs/context-window.md §10).
              void ensureTopicAnchorEstablished(dispatch, store.getState, assistant.id, newTopic.id)
            } catch (error) {
              logger.error('[NEW_BRANCH] Failed to inherit context window anchor', error as Error)
            }

            window.toast.success(t('chat.message.new.branch.created'))
          },
          onFailure: () => {
            logger.error(`[NEW_BRANCH] Failed to create topic branch for topic ${newTopic.id}`)
            window.toast.error(t('message.branch.error'))
          }
        })
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

              // Persist FIRST (SQLite via atomic thunk), THEN update Redux.
              // If persistence fails, Redux is untouched — editor can retry.
              // consumeFileCleanupResult is consumed inside updateMessageAndBlocksThunk
              // when blockIdsToDelete are non-empty; for block-only upserts the cleanup
              // result is empty and consumed trivially.
              const cleanup = await dispatch(
                updateMessageAndBlocksThunk(topic.id, { id: msgBlock.messageId }, [updatedBlock])
              )
              // Consume FileCleanupResult exactly once at the caller.
              await consumeFileCleanupResult(cleanup)

              // Redux AFTER successful SQLite persistence
              dispatch(updateOneBlock({ id: msgBlockId, changes: { content: updatedRaw } }))

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
        // S3.1: Capture epoch for stale-completion rejection. The viewport
        // token invalidation from topic/reset already protects navigate(),
        // but this adds defense in depth for the post-navigation persistence.
        const navEpoch = transitionEpochRef.current
        const { source, result } = await handlePendingNavigateEvent(topic.id, messageId, {
          getPending: getPendingNavigate,
          // S3.1 Blocker 1 correction: epoch-guard the clear so a stale
          // matched event completion cannot consume a current-transition
          // pending identity.
          clearPending: (expected) => {
            if (transitionEpochRef.current !== navEpoch) return false
            return clearPendingNavigate(expected)
          },
          navigate,
          onDone: () => {
            if (transitionEpochRef.current !== navEpoch) return
            bootstrapPhaseRef.current = 'done'
          }
        })
        if (transitionEpochRef.current !== navEpoch) {
          void source
          return
        }
        if (shouldPersistNavigationResult(result)) savePosition()
        void source
      })
    ]

    return () => unsubscribes.forEach((unsub) => unsub())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant, dispatch, scrollToBottom, autoScrollToBottom, navigate, savePosition, topic])

  /**
   * Unified topic bootstrap: determines the initial navigation intent with strict priority.
   *   matching pending > saved restore > default (latest)
   * Only one transaction is started per mount cycle.
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
      // S3.1 Blocker 1 correction: capture the transition epoch at bootstrap
      // start. If the topic changes before the async navigation completes (even
      // to the same topic ID — A→B→A), the stale completion is rejected.
      const bootstrapEpoch = transitionEpochRef.current
      void navigate(decision.intent).then((result) => {
        if (transitionEpochRef.current !== bootstrapEpoch) return
        if (result !== 'cancelled') {
          clearPendingNavigate(pending)
          bootstrapPhaseRef.current = 'done'
          if (shouldPersistNavigationResult(result)) savePosition()
        } else {
          bootstrapPhaseRef.current = 'done'
        }
      })
      return
    }

    // action === 'restore'
    savedRestoreHandledRef.current = true
    bootstrapPhaseRef.current = 'done'
    // S3.1 Blocker 1 correction: capture the transition epoch for the restore
    // navigation so a stale completion does not persist under the wrong epoch.
    const restoreEpoch = transitionEpochRef.current
    void navigate(decision.intent).then((result) => {
      if (transitionEpochRef.current !== restoreEpoch) return
      if (shouldPersistNavigationResult(result)) savePosition()
    })
  }, [isTopicLoading, messages, navigate, savePosition, topic.id, getSavedPosition])

  // S3.1 Blocker 4: onFirstUpdate fires once per topic, not once ever.
  // useTopicTransition resets onFirstUpdateFiredRef via resetOnFirstUpdate
  // when the topic prop changes, allowing the effect to fire again for
  // the new topic. topic.id is a dependency so the effect re-runs after
  // the useLayoutEffect flag reset, letting the ref check see false.
  useEffect(() => {
    if (!onFirstUpdateFiredRef.current) {
      onFirstUpdateFiredRef.current = true
      onFirstUpdate?.()
    }
  }, [contextInfo, onFirstUpdate, topic.id])

  const loadMoreMessages = useCallback(() => {
    const currentState = viewportStateRef.current
    if (!canHandleUserViewportScroll(currentState) || !currentState.window?.hasMoreOlder || currentState.loading.older)
      return

    const anchorId = currentState.window?.oldestMessageId
    if (!anchorId) {
      logger.warn('[loadMoreMessages] missing stable anchor for R-03 around')
      return
    }

    const loadToken = {}
    const topicGeneration = currentState.topicGeneration
    const topicIdAtStart = topic.id
    const deletionGenAtStart = captureDeletionGeneration(topicIdAtStart)
    const residentGenAtStart = (store.getState() as any)?.residentRegistry?.entries?.[topicIdAtStart]
      ?.applicabilityGeneration as number | undefined
    const capturedResidentGen = residentGenAtStart ?? 0
    viewportDispatch({ type: 'load/start', direction: 'older', token: loadToken })

    const container = scrollContainerRef.current
    const anchor = findFirstVisibleMessage(container, messageElements.current)

    const before = clampWindowCount(LOAD_MORE_COUNT)
    const after = 1
    const request: FetchMessagesWindowRequest = {
      kind: 'around',
      topicId: topicIdAtStart,
      anchorMessageId: anchorId,
      before,
      after
    }

    // S6.1 coverage check — fail-closed: only reuse cached window if it fully covers the request for current topic/generation
    // Topic-deletion epoch check at local join boundary: discarding cached window if deleted during lifetime
    if (isDeletionStale(topicIdAtStart, deletionGenAtStart)) {
      windowCacheRef.current.delete(topicIdAtStart)
    }
    const cachedWindow = windowCacheRef.current.get(topicIdAtStart)
    if (cachedWindow && isWindowCovering(cachedWindow, request, topicIdAtStart)) {
      logger.silly('[loadMoreMessages] coverage hit, still fetching for authoritative window' as never)
    }

    setTimeoutTimer(
      'loadMoreMessages',
      async () => {
        if (!isCurrentLoad('older', loadToken, topicGeneration)) return
        try {
          const { dbService } = await import('@renderer/services/db')
          // Phase 5 bounded slice: same-topic window reads are FIFO-serialized
          // via runTopicWindowRead (bootstrap latest + around pagination share
          // the per-topic queue). All existing stale-discard guards below
          // (topic/generation/deletion/isCurrentLoad) are unchanged — the
          // serializer only orders execution of the IPC read.
          const response = await runTopicWindowRead(topicIdAtStart, request.kind, () =>
            dbService.fetchMessagesWindow(request)
          )

          // stale discard — topic changed, generation advanced, or deleted during fetch, or resident generation advanced
          if (topic.id !== topicIdAtStart) {
            viewportDispatch({ type: 'load/cancel', direction: 'older', token: loadToken, topicGeneration })
            return
          }
          if (viewportStateRef.current.topicGeneration !== topicGeneration) {
            viewportDispatch({ type: 'load/cancel', direction: 'older', token: loadToken, topicGeneration })
            return
          }
          if (isDeletionStale(topicIdAtStart, deletionGenAtStart)) {
            viewportDispatch({ type: 'load/cancel', direction: 'older', token: loadToken, topicGeneration })
            return
          }
          const currentResidentGen = (store.getState() as any)?.residentRegistry?.entries?.[topicIdAtStart]
            ?.applicabilityGeneration as number | undefined
          if ((currentResidentGen ?? 0) !== capturedResidentGen) {
            viewportDispatch({ type: 'load/cancel', direction: 'older', token: loadToken, topicGeneration })
            return
          }
          if (!isCurrentLoad('older', loadToken, topicGeneration)) return

          if (!isValidWindowResponse(request, response as unknown as FetchMessagesWindowResponse)) {
            logger.error(
              '[loadMoreMessages] malformed window response, fail-closed',
              response.window as unknown as Error
            )
            viewportDispatch({ type: 'load/cancel', direction: 'older', token: loadToken, topicGeneration })
            return
          }
          if (response.window.topicId !== topicIdAtStart || response.window.kind !== 'around') {
            logger.error('[loadMoreMessages] window topic/kind mismatch, fail-closed')
            viewportDispatch({ type: 'load/cancel', direction: 'older', token: loadToken, topicGeneration })
            return
          }

          // atomic staged publication: validate first, then merge
          windowCacheRef.current.set(topicIdAtStart, response as unknown as FetchMessagesWindowResponse)
          const blocks = response.blocks as unknown as MessageBlock[]
          const incoming = response.messages as unknown as Message[]
          const existing = messagesRef.current
          const merged = mergeWindowIntoTopic(existing, incoming, anchorId)

          if (blocks.length > 0) {
            dispatch(upsertManyBlocks(blocks))
          }
          // install merged ordered list as single Redux transition
          dispatch(newMessagesActions.messagesReceived({ topicId: topicIdAtStart, messages: merged }))

          const currentWindow = viewportStateRef.current.window
          if (!currentWindow) {
            viewportDispatch({ type: 'load/cancel', direction: 'older', token: loadToken, topicGeneration })
            return
          }
          const olderWindow = expandMessageWindowOlder(merged, currentWindow, LOAD_MORE_COUNT, {
            hasMoreBefore: response.window.hasMoreBefore,
            hasMoreAfter: currentWindow.hasMoreNewer
          })

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
        } catch (err) {
          logger.error('[loadMoreMessages] window fetch failed, fail-closed', err as Error)
          if (isCurrentLoad('older', loadToken, topicGeneration)) {
            viewportDispatch({ type: 'load/cancel', direction: 'older', token: loadToken, topicGeneration })
          }
        }
      },
      50
    )
  }, [beginScroll, dispatch, isCurrentLoad, setTimeoutTimer, scrollContainerRef, topic.id, viewportDispatch])

  const loadNewerMessages = useCallback(() => {
    const currentState = viewportStateRef.current
    if (!canHandleUserViewportScroll(currentState) || !currentState.window?.hasMoreNewer || currentState.loading.newer)
      return

    const anchorId = currentState.window?.newestMessageId
    if (!anchorId) {
      logger.warn('[loadNewerMessages] missing stable anchor for R-03 around')
      return
    }

    const loadToken = {}
    const topicGeneration = currentState.topicGeneration
    const topicIdAtStart = topic.id
    const deletionGenAtStart = captureDeletionGeneration(topicIdAtStart)
    const residentGenAtStart = (store.getState() as any)?.residentRegistry?.entries?.[topicIdAtStart]
      ?.applicabilityGeneration as number | undefined
    const capturedResidentGen = residentGenAtStart ?? 0
    viewportDispatch({ type: 'load/start', direction: 'newer', token: loadToken })

    const container = scrollContainerRef.current
    const anchor = findFirstVisibleMessage(container, messageElements.current)

    const before = 1
    const after = clampWindowCount(LOAD_MORE_COUNT)
    const request: FetchMessagesWindowRequest = {
      kind: 'around',
      topicId: topicIdAtStart,
      anchorMessageId: anchorId,
      before,
      after
    }

    if (isDeletionStale(topicIdAtStart, deletionGenAtStart)) {
      windowCacheRef.current.delete(topicIdAtStart)
    }
    const cachedWindow = windowCacheRef.current.get(topicIdAtStart)
    if (cachedWindow && isWindowCovering(cachedWindow, request, topicIdAtStart)) {
      logger.silly('[loadNewerMessages] coverage hit' as never)
    }

    setTimeoutTimer(
      'loadNewerMessages',
      async () => {
        if (!isCurrentLoad('newer', loadToken, topicGeneration)) return
        try {
          const { dbService } = await import('@renderer/services/db')
          // Phase 5 bounded slice: same-topic window reads are FIFO-serialized
          // via runTopicWindowRead (bootstrap latest + around pagination share
          // the per-topic queue). All existing stale-discard guards below
          // (topic/generation/deletion/isCurrentLoad) are unchanged — the
          // serializer only orders execution of the IPC read.
          const response = await runTopicWindowRead(topicIdAtStart, request.kind, () =>
            dbService.fetchMessagesWindow(request)
          )

          if (topic.id !== topicIdAtStart) {
            viewportDispatch({ type: 'load/cancel', direction: 'newer', token: loadToken, topicGeneration })
            return
          }
          if (viewportStateRef.current.topicGeneration !== topicGeneration) {
            viewportDispatch({ type: 'load/cancel', direction: 'newer', token: loadToken, topicGeneration })
            return
          }
          if (isDeletionStale(topicIdAtStart, deletionGenAtStart)) {
            viewportDispatch({ type: 'load/cancel', direction: 'newer', token: loadToken, topicGeneration })
            return
          }
          const currentResidentGen = (store.getState() as any)?.residentRegistry?.entries?.[topicIdAtStart]
            ?.applicabilityGeneration as number | undefined
          if ((currentResidentGen ?? 0) !== capturedResidentGen) {
            viewportDispatch({ type: 'load/cancel', direction: 'newer', token: loadToken, topicGeneration })
            return
          }
          if (!isCurrentLoad('newer', loadToken, topicGeneration)) return

          if (!isValidWindowResponse(request, response as unknown as FetchMessagesWindowResponse)) {
            logger.error(
              '[loadNewerMessages] malformed window response, fail-closed',
              response.window as unknown as Error
            )
            viewportDispatch({ type: 'load/cancel', direction: 'newer', token: loadToken, topicGeneration })
            return
          }
          if (response.window.topicId !== topicIdAtStart || response.window.kind !== 'around') {
            viewportDispatch({ type: 'load/cancel', direction: 'newer', token: loadToken, topicGeneration })
            return
          }

          windowCacheRef.current.set(topicIdAtStart, response as unknown as FetchMessagesWindowResponse)
          const blocks = response.blocks as unknown as MessageBlock[]
          const incoming = response.messages as unknown as Message[]
          const existing = messagesRef.current
          const merged = mergeWindowIntoTopic(existing, incoming, anchorId)

          if (blocks.length > 0) {
            dispatch(upsertManyBlocks(blocks))
          }
          dispatch(newMessagesActions.messagesReceived({ topicId: topicIdAtStart, messages: merged }))

          const currentWindow = viewportStateRef.current.window
          if (!currentWindow) {
            viewportDispatch({ type: 'load/cancel', direction: 'newer', token: loadToken, topicGeneration })
            return
          }
          const newerWindow = expandMessageWindowNewer(merged, currentWindow, LOAD_MORE_COUNT, {
            hasMoreBefore: currentWindow.hasMoreOlder,
            hasMoreAfter: response.window.hasMoreAfter
          })

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
        } catch (err) {
          logger.error('[loadNewerMessages] window fetch failed, fail-closed', err as Error)
          if (isCurrentLoad('newer', loadToken, topicGeneration)) {
            viewportDispatch({ type: 'load/cancel', direction: 'newer', token: loadToken, topicGeneration })
          }
        }
      },
      50
    )
  }, [beginScroll, dispatch, isCurrentLoad, setTimeoutTimer, scrollContainerRef, topic.id, viewportDispatch])

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
    const lastUserMessage = messagesRef.current.findLast((m) => m.role === 'user')
    if (lastUserMessage) {
      void EventEmitter.emit(EVENT_NAMES.EDIT_MESSAGE, lastUserMessage.id)
    }
  })

  useEffect(() => {
    requestAnimationFrame(() => {
      onComponentUpdate?.()
    })
    // LOCK-2A-007: the domEndpoint record is written exclusively by the
    // displayMessages effect above — this component-update effect does NOT
    // write a domEndpoint record. The two effects serve different purposes:
    // displayMessages is the real non-empty visible subtree boundary used
    // by the E2E endpoint; onComponentUpdate is a general component update
    // signal that may fire independently.
  }, [onComponentUpdate])

  return (
    <EditModeProvider topicId={topic.id} scrollToGroup={scrollToGroup} visibleGroupIds={visibleGroupIds}>
      <AnchorGroupProvider anchorGroupKey={anchorGroupKey}>
        <MessagesContent
          assistant={assistant}
          topic={topic}
          scrollContainerRef={scrollContainerRef}
          handleScrollPosition={handleScroll}
          displayMessages={displayMessages}
          displayGroups={displayGroups}
          contextBoundaryMessageId={contextBoundaryMessageId}
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
      </AnchorGroupProvider>
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
