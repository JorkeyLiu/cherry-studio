import { loggerService } from '@logger'
import EditModeActionBar from '@renderer/components/EditModeActionBar'
import { LoadingIcon } from '@renderer/components/Icons'
import { LOAD_MORE_COUNT } from '@renderer/config/constant'
import { EditModeProvider, useEditMode } from '@renderer/context/EditModeContext'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useClipboardKeyboard } from '@renderer/hooks/useClipboardKeyboard'
import { useMessageActionController } from '@renderer/hooks/useMessageActionController'
import { useLoadedTopicMessages, useMessageOperations, useTopicLoading } from '@renderer/hooks/useMessageOperations'
import useScrollPosition, { holdProgrammaticScrollOwnership } from '@renderer/hooks/useScrollPosition'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTimer } from '@renderer/hooks/useTimer'
import { autoRenameTopic } from '@renderer/hooks/useTopic'
import { useTopicSegments } from '@renderer/hooks/useTopicSegments'
import { useTopicTransition } from '@renderer/hooks/useTopicTransition'
import {
  COLUMN_REVERSE_NEWER_PREFETCH_PX,
  distanceFromBottom
} from '@renderer/pages/home/Messages/columnReverseGeometry'
import { findFirstVisibleMessage, findViewportTopAnchorWithOffset } from '@renderer/pages/home/Messages/domVisibility'
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
import { ensureMessageLoaded } from '@renderer/pages/home/Messages/messageNavigationLoader'
import {
  createPendingOlderIntent,
  decidePendingOlderReplay,
  isStillAtOldestEdge,
  type PendingOlderEdgeIntent,
  shouldQueueOlderIntent
} from '@renderer/pages/home/Messages/messagePaginationIntent'
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
import { ensureTopicAnchorEstablished } from '@renderer/services/anchorService'
import { getAssistantSettings, getDefaultTopic } from '@renderer/services/AssistantService'
import type { computeContextInfo } from '@renderer/services/contextInfoService'
import { dbService } from '@renderer/services/db/DbService'
import { ensureOrdinaryTopicOwnership } from '@renderer/services/db/topicTrashLifecycle'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { clearPendingNavigate, getPendingNavigate } from '@renderer/services/MessagesService'
import {
  captureResidentGeneration,
  shouldDiscardPaginationForResident
} from '@renderer/services/paginationResidentGuard'
import {
  currentPhaseCorrelation,
  recordPhaseDurationForCorrelation,
  recordPhaseEndpoint
} from '@renderer/services/phaseTimingDiagnostics'
import { handleScrollSnapshotCleared } from '@renderer/services/scrollSnapshotCache'
import {
  captureDeletionGeneration,
  getDeletionGeneration,
  isDeletionStale,
  subscribeDeletionGeneration
} from '@renderer/services/topicDeletionInvalidation'
import { isValidWindowResponse, isWindowCovering } from '@renderer/services/windowCoverage'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import { withClosureTopics } from '@renderer/store/closureOwnership'
import { messageBlocksSelectors, updateOneBlock, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectLoadedMessagesForTopic } from '@renderer/store/newMessage'
import {
  loadRouteMessagesThunk,
  loadRouteWindowWithFallback,
  updateMessageAndBlocksThunk
} from '@renderer/store/thunk/messageThunk'
import {
  activeBranchSet,
  deletionFallbackConsumed,
  selectActiveBranchId,
  selectDeletionFallbackIntent
} from '@renderer/store/topicBranch'
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
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import InfiniteScroll from 'react-infinite-scroll-component'
import styled from 'styled-components'

import { AnchorGroupProvider } from './anchorGroupContext'
import {
  buildDividerKey,
  captureDividerOffset,
  decideDividerRestoreTarget,
  dividerRowTestId,
  type DividerSwitchInfo,
  findAnchorsWithChildren,
  ForkDivider
} from './BranchDividers'
/**
 * Loaded-route tracking uses the tagged `LoadedRouteState` from
 * `messageWindow` (renderer-local, no persistence): `{ route, loadFailed }`.
 * The double-failed signal is the explicit boolean, never a magic branchId
 * string, so it can never collide with a real route key.
 */
import MessageContextMenu from './MessageContextMenu'
import { renderEditFlowNodes } from './messageEditSelectionLayout'
import { buildMessageFlowNodes, resolveContextDividerGroupKey } from './messageFlowNodes'
import MessageGroup from './MessageGroup'
import { NAVIGATION_VISUALLY_NEWER_GROUPS, NAVIGATION_VISUALLY_OLDER_GROUPS } from './messageNavigation'
import { buildRenderLayers, buildRenderSegments } from './messageRenderLayers'
import { useCrossMessageSelectionGuard, useEditModeNativeSelectionSuppression } from './messageSelectionGuard'
import {
  buildRouteViewport,
  chooseRouteWindowRequest,
  claimLoadedRoute,
  decideDividerDoubleFailureRecovery,
  decideExternalDoubleFailureRecovery,
  initLoadedRouteState,
  isLoadedRouteCurrent,
  markLoadedRouteFailed
} from './messageWindow'
import {
  armStabilizerSuppress,
  createStabilizerScrollSuppress,
  isRestoreTargetValid,
  isSelfInducedStabilizerScroll,
  runBoundedPositionStabilizer,
  shouldCancelStabilizerForKeyDown,
  type StabilizerHandle
} from './positionStabilizer'
import Prompt from './Prompt'
import {
  type ActiveRestoreAnchor,
  createDividerRestoreAnchor,
  createMessageRestoreAnchor,
  decidePaginationCompensation,
  type PreferredRestoreAnchorSnapshot,
  shouldStartPaginationStabilizer,
  snapshotRestoreAnchor
} from './routeRestoreAnchor'
import { MessagesContainer, MessagesWrapper, ScrollContainer } from './shared'
import TopicSegmentLine from './TopicSegmentLine'
import { requestTopicBranches, useBranchTree } from './useBranchTree'
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
  registerMessageElement: (messageId: string, element: HTMLElement | null) => void
  /**
   * Fork-divider route switch (divider-visual-anchor navigation, never bottom).
   * `branchId` null = parent/original route at the fork, non-null = child
   * branch. The topic stays fixed; only the active route changes.
   * `info` carries the clicked divider's stable identity
   * (anchor + parent) and its synchronously captured pixel offset relative to
   * `#messages` top — the reliable visual invariant for this switch.
   */
  onSelectRoute: (branchId: string | null, anchorMessageId: string, info?: DividerSwitchInfo) => void
  /** Genuine user input (wheel/touch/pointer) while a stabilizer may be active. */
  onStabilizerUserInput?: () => void
  /** Keyboard scroll pre-cancel (Arrow/PageUp/PageDown/Home/End/Space, inputs excluded). */
  onStabilizerKeyDown?: (e: React.KeyboardEvent) => void
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
  registerMessageElement,
  onSelectRoute,
  onStabilizerUserInput,
  onStabilizerKeyDown
}) => {
  const { t } = useTranslation()

  const { isEnabled: isEditMode, selectedGroupIds, handleGroupClick } = useEditMode()
  const { isMessageFirstInSegment, isMessageLastInSegment, isMessageInSegment } = useTopicSegments(topic.id)
  useClipboardKeyboard()
  // Boundary-aware native selection: ordinary within-message selection is
  // preserved; cross-message native ranges are cleared. In edit mode native
  // text selection inside messages is suppressed (selection-only semantics).
  useCrossMessageSelectionGuard()
  useEditModeNativeSelectionSuppression(isEditMode, scrollContainerRef)

  // Branch fork dividers for the active route: catalog for the logical
  // topic, breadcrumb path, and direct children across the addressed route
  // grouped by anchor. Sidebar stays flat logical topics.
  const activeBranchId = useAppSelector((state) => selectActiveBranchId(state, topic.id))
  const branchTree = useBranchTree(topic.id, activeBranchId)
  const forkAnchorIds = useMemo(
    () => findAnchorsWithChildren(displayMessages, branchTree.childrenByAnchor),
    [displayMessages, branchTree.childrenByAnchor]
  )
  const topicDisplayName = topic.name && topic.name.length > 0 ? topic.name : topic.id

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
  const contextDividerGroupKey = useMemo(
    () => resolveContextDividerGroupKey(groupedMessages, contextBoundaryMessageId),
    [groupedMessages, contextBoundaryMessageId]
  )

  const renderMessageSegments = () => {
    // Mounted message flow in newest→oldest render order: turn bodies and
    // independent boundary nodes as siblings. Turn runs are grouped
    // downstream in renderEditFlowNodes with boundary flush, so a boundary
    // always splits turns (even same askId) and stays outside turn click
    // capture — liveness stays on the child body nodes.
    // Flow-node construction (group order, fork/context placement, stable
    // identity, askIds, selection, layer identity) is the production builder
    // in messageFlowNodes; only the React pixels are supplied here.
    const nodes = buildMessageFlowNodes({
      layerRuns,
      contextDividerGroupKey,
      forkAnchorIds,
      childrenByAnchor: branchTree.childrenByAnchor,
      branchPath: branchTree.path,
      branches: branchTree.branches,
      topicDisplayName,
      isMessageInSegment,
      isMessageFirstInSegment,
      isMessageLastInSegment,
      renderForkBoundary: ({ anchorMessageId, taken, children, parentBranchId, parentLabel }) => (
        <ForkDivider
          topicId={topic.id}
          anchorMessageId={anchorMessageId}
          taken={taken}
          children={children}
          parentBranchId={parentBranchId}
          parentLabel={parentLabel}
          activeBranchId={activeBranchId}
          countLabel={t('chat.topics.branch.children_here', { count: children.length })}
          onSelectRoute={onSelectRoute}
        />
      ),
      renderBody: ({ kind, stableGroupId, layerRunId, segment, isFirst, isLast, groupMessages }) => (
        <div
          style={{ position: 'relative' }}
          data-layer-kind={kind}
          data-stable-group-id={stableGroupId}
          data-layer-run-id={layerRunId}>
          {segment && (
            <TopicSegmentLine
              segment={segment}
              isFirst={isFirst}
              isLast={isLast}
              messageCount={isFirst ? segment.messageCount : undefined}
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
      ),
      renderContextBoundary: (legacyKey) => (
        <ContextWindowDivider data-context-boundary data-testid="context-boundary" data-context-legacy-key={legacyKey}>
          <ContextWindowDividerLine />
          <ContextWindowDividerText>{t('chat.context_window_start')}</ContextWindowDividerText>
          <ContextWindowDividerLine />
        </ContextWindowDivider>
      )
    })

    // Turn runs group adjacent mounted bodies of one Q&A turn under a
    // single interaction container with boundary flush; selected
    // contiguous ranges keep one atomic outline that wraps interior
    // boundaries — see renderEditFlowNodes.
    return renderEditFlowNodes({ nodes, isEditMode, onTurnClick: handleGroupClick })
  }

  return (
    <MessagesWrapper>
      {isEditMode && <EditModeActionBar />}
      <MessagesContainer
        id="messages"
        className="messages-container"
        ref={scrollContainerRef}
        onScroll={handleScrollPosition}
        onWheel={onStabilizerUserInput}
        onTouchStart={onStabilizerUserInput}
        onPointerDown={onStabilizerUserInput}
        onKeyDown={onStabilizerKeyDown}>
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
      </MessagesContainer>
    </MessagesWrapper>
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
  // Active route of this logical topic (null = main route). Switching
  // branches never changes the active topic, sidebar selection, or topic
  // ordering — only this route plus the loaded/viewport projection.
  // Declared before the scroll hook so the route-keyed snapshot key can
  // include it.
  const activeBranchId = useAppSelector((state) => selectActiveBranchId(state, topic.id))
  // One-shot deletion-fallback intent (branch subtree removal with active
  // fallback). Consumed exactly once by the deletion effect below with an
  // explicit `latest` reload; never the generic snapshot-around path.
  const deletionFallbackIntent = useAppSelector((state) => selectDeletionFallbackIntent(state, topic.id))
  // Route-keyed scroll snapshots: each branch route keeps its own browsing
  // position under `topic-<id>::<branch|main>`. The legacy topic-only key
  // (`topic-<id>`) is the main-route fallback when no route snapshot exists.
  const {
    containerRef: scrollContainerRef,
    handleScroll: handleScrollPosition,
    getSavedPosition,
    savePosition
  } = useScrollPosition(`topic-${topic.id}::${activeBranchId ?? 'main'}`)
  const getRouteSavedPosition = getSavedPosition
  const getLegacyMainSavedPosition = useCallback(() => {
    try {
      const saved = window.keyv.get(`scroll:topic-${topic.id}`)
      if (saved && typeof saved === 'object' && 'scrollTop' in saved) {
        return saved as { scrollTop: number; anchorId: string | null; isAtBottom: boolean }
      }
      if (typeof saved === 'number') {
        return { scrollTop: saved, anchorId: null, isAtBottom: false }
      }
    } catch {
      // fail-closed: no legacy fallback
    }
    return null
  }, [topic.id])
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
  // Bounded loaded projection: resident topic only. The `?? []` fallback is
  // memoized so viewport effects keep a stable identity while non-resident
  // (`undefined` stays at the API boundary).
  const loadedMessages = useLoadedTopicMessages(topic.id)
  const messages = useMemo(() => (loadedMessages ?? []) as Message[], [loadedMessages])
  const isTopicLoading = useTopicLoading(topic)
  const { displayCount, createTopicBranchByAnchor, createBranch } = useMessageOperations(topic)
  const { selectAnswer } = useMessageActionController()
  const { setTimeoutTimer, clearTimeoutTimer } = useTimer()
  const phaseAtRender = currentPhaseCorrelation()
  const phaseRenderStartedAt = phaseAtRender ? performance.now() : 0

  const { isMultiSelectMode, handleSelectMessage } = useChatContext(topic)

  const messageElements = useRef<Map<string, HTMLElement>>(new Map())
  const messagesRef = useRef<Message[]>(messages)
  const previousMessagesRef = useRef<Message[]>(messages)
  // Live current-topic ref: assigned during render so async `isStale` guards
  // always read the current topic, never a closure-fixed `topic.id`.
  const topicIdRef = useRef(topic.id)
  topicIdRef.current = topic.id
  // Live active-route ref: pagination and navigation window reads address
  // the current route (topic + branch), never a closure-fixed branch.
  const routeRef = useRef<string | null>(activeBranchId)
  routeRef.current = activeBranchId
  // Route loaded into the viewport projection (mirrors activeBranchId for
  // locally initiated switches; diverges when the route changes externally —
  // branch deleted elsewhere, delete-fallback, catalog prune).
  const loadedRouteRef = useRef(initLoadedRouteState(activeBranchId))
  // Topic transitions own the projection reset (useTopicTransition); rebase
  // the loaded-route marker so a stale route from the previous topic never
  // triggers an invalidation reload for the new topic.
  const lastTopicForRouteRef = useRef(topic.id)
  if (lastTopicForRouteRef.current !== topic.id) {
    lastTopicForRouteRef.current = topic.id
    loadedRouteRef.current = claimLoadedRoute(activeBranchId)
  }
  // Live translation ref so `navigate` stays stable across renders (production
  // `t` is stable; test mocks return a new closure per render).
  const tRef = useRef(t)
  tRef.current = t
  // Last-wins navigation epoch: each `navigate` call supersedes prior ones.
  const navigateEpochRef = useRef(0)
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

  // Divider/top restore generation: independent of the viewport scroll token.
  // `beginScroll('anchoring'/'programmatic')` suspends user-scroll handling by
  // design, so target validity must NEVER consult `canHandleUserViewportScroll`
  // (it would self-cancel). Validity is topic + route + mounted + this restore
  // generation still current. User input cancels via the active stabilizer
  // session below; the stabilizer's own programmatic deltas are guarded by a
  // precise single-frame suppress (`stabilizerSuppressRef`: post-apply
  // expected scrollTop + armed + generation, cleared on the next frame) so
  // they never self-cancel and never swallow real keyboard/scrollbar scrolls.
  const restoreEpochRef = useRef(0)
  const activeStabilizerRef = useRef<{
    handle: StabilizerHandle
    scrollToken: object
    release: () => void
    epoch: number
  } | null>(null)
  const stabilizerSuppressRef = useRef(createStabilizerScrollSuppress())
  // Route-restore preferred visual anchor: the row that must stay visually
  // still across a divider/top restore (divider-row or saved message-row),
  // bound to topicId/routeId/restoreEpoch with an explicit lifecycle. Route,
  // topic, deletion, unmount, or user-cancel clears it. Queued older-edge
  // intents carry only a detached snapshot (stable identity + targetOffset),
  // never this live ref.
  const activeRestoreAnchorRef = useRef<ActiveRestoreAnchor | null>(null)
  // Pending older-edge intent (InfiniteScroll latch fix): queued when `next`
  // fires while the viewport is temporarily non-user (anchoring/programmatic
  // restore or active navigation). Replayed once from the committed viewport
  // state after `navigation idle + scrollMode user` restores. Never depends
  // on library internals.
  const pendingOlderIntentRef = useRef<PendingOlderEdgeIntent | null>(null)
  const unmountedRef = useRef(false)
  useEffect(() => {
    return () => {
      unmountedRef.current = true
      pendingOlderIntentRef.current = null
      activeRestoreAnchorRef.current = null
      // Synchronous unmount teardown: invalidate the restore epoch so late
      // async continuations stay inert, then synchronously cancel the active
      // stabilizer (handle.cancel settles `done` without waiting for rAF) and
      // release the scroll token + hook ownership exactly once. Taking the
      // session first guarantees a single end/release even if a restore
      // `finally` runs later (it skips on epoch mismatch).
      restoreEpochRef.current += 1
      const active = activeStabilizerRef.current
      activeStabilizerRef.current = null
      stabilizerSuppressRef.current.armed = false
      if (active) {
        try {
          active.handle.cancel()
        } catch {}
        try {
          viewportDispatch({ type: 'scroll/end', token: active.scrollToken })
        } catch {}
        try {
          active.release()
        } catch {}
      }
    }
  }, [viewportDispatch])

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
      pendingOlderIntentRef.current = null
      activeRestoreAnchorRef.current = null
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
      pendingOlderIntentRef.current = null
      activeRestoreAnchorRef.current = null
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
    pendingOlderIntentRef.current = null
    activeRestoreAnchorRef.current = null
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

  useLayoutEffect(() => {
    // S3.1: Topic change detection is now owned by useTopicTransition.
    // This effect handles only window application for the current topic:
    //   Scenario 1: First load (empty viewport → apply latest window)
    //   Scenario 2: Reconcile existing window against updated messages
    // Layout-phase reconciliation: guarantees the viewport render projection
    // (displayMessages/displayGroups) is reconciled with the current loaded
    // projection before the browser can paint. Without this, a passive
    // effect would allow one paint where the stale group still selects the
    // deleted variant (now blockless) and fold CSS hides the survivor,
    // producing a blank interval. Paired delete retains resident projection
    // and must not reload/reset; only this local window reconciliation moves.
    // previousMessagesRef is co-located here (updated in the same layout
    // commit) so correctness does not depend on distant hook order; the
    // snapshot used for reconciliation is always the previous commit's
    // messages, and the ref is advanced synchronously before paint for the
    // next reconcilation.

    try {
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

      if (
        !areMessageArraysIdentical(currentDisplayMessages, newDisplayMessages) ||
        currentWindow !== reconciledWindow
      ) {
        applyMessageWindow(reconciledWindow)
      }
    } finally {
      // Advance previous snapshot synchronously in the same layout phase.
      previousMessagesRef.current = messages
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, displayCount])

  useEffect(() => {
    if (displayMessages.length === 0) return
    const active = currentPhaseCorrelation()
    if (active) recordPhaseEndpoint(active.path === 'echo' ? 'echo.domEndpoint' : 'topic.domEndpoint')
  }, [displayMessages])

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

  const runTransaction = useCallback(
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
   * Bounded wait until the Redux projection / React commit observably contains
   * the target (via `messagesRef`, which syncs in the `[messages]` effect after
   * render). Bounded by timeout, never infinite; no DOM scroll, no transaction
   * copy. Returns true when observable, false on stale/superseded/timeout.
   */
  const waitForProjectionCommit = useCallback(
    async (targetId: string, isStale: () => boolean, timeoutMs = 2000): Promise<boolean> => {
      const startedAt = Date.now()
      for (;;) {
        if (isStale()) return false
        if (messagesRef.current.some((m) => m.id === targetId)) return true
        if (Date.now() - startedAt >= timeoutMs) return false
        await new Promise<void>((resolve) => setTimeout(resolve, 16))
      }
    },
    []
  )

  /**
   * Unified stable-ID navigation entry point (single assembly site).
   *
   * Resident targets run the existing transaction directly (zero reads).
   * Missing message-ID targets are first ensured through the canonical
   * around-window loader (target topic activated, Messages mounted): one
   * `fetchMessagesWindow({kind:'around'})` read, strictly validated and
   * atomically merged (message+blocks), published, then — only after the Redux
   * projection/React commit observably contains the target — the same existing
   * transaction resolves. Stale/superseded completions never publish nor
   * navigate. `error` (transport/unknown/malformed) maps to `cancelled` so the
   * pending identity is preserved; only authoritative `not-found`/`success`
   * clears pending. No DB knowledge in the transaction itself.
   */
  const navigate = useCallback(
    (intent: MessageNavigationIntent) => {
      if (intent.kind !== 'message') return runTransaction(intent)
      const targetId = intent.targetId
      if (messagesRef.current.some((m) => m.id === targetId)) return runTransaction(intent)

      return (async () => {
        const navigateEpochAtStart = ++navigateEpochRef.current
        const topicIdAtStart = topicIdRef.current
        const transitionEpochAtStart = transitionEpochRef.current
        const deletionGenAtStart = captureDeletionGeneration(topicIdAtStart)
        const residentGenAtStart = captureResidentGeneration(() => store.getState(), topicIdAtStart)

        const isStale = (): boolean => {
          // Live current-topic read: catches switches even when the closure
          // topic.id is fixed (A→B→A included via transition epoch below).
          // No viewport topicGeneration check here: the generation advances
          // asynchronously via topic/reset after a switch, so a bootstrap
          // navigate started with the pre-reset generation would falsely
          // self-stale when the reset commits. Transition epoch + live topic
          // already cover switches without this race.
          if (topicIdRef.current !== topicIdAtStart) return true
          if (navigateEpochRef.current !== navigateEpochAtStart) return true
          if (transitionEpochRef.current !== transitionEpochAtStart) return true
          if (isDeletionStale(topicIdAtStart, deletionGenAtStart)) return true
          if (
            shouldDiscardPaginationForResident(
              residentGenAtStart,
              captureResidentGeneration(() => store.getState(), topicIdAtStart)
            )
          ) {
            return true
          }
          return false
        }

        const routeAtStart = routeRef.current
        const ensured = await ensureMessageLoaded(topicIdAtStart, targetId, {
          getExistingMessages: () => messagesRef.current,
          readAroundWindow: async (request) => {
            const { dbService } = await import('@renderer/services/db')
            // Navigation reads address the current route (never main by
            // default when a branch is active).
            const routedRequest: FetchMessagesWindowRequest = { ...request, branchId: routeAtStart }
            return (await runTopicWindowRead(topicIdAtStart, 'around', () =>
              dbService.fetchMessagesWindow(routedRequest)
            )) as unknown as FetchMessagesWindowResponse
          },
          isStaleBeforeFetch: () => isStale() || routeRef.current !== routeAtStart,
          isStaleAfterFetch: () => isStale() || routeRef.current !== routeAtStart
        })

        if (ensured.status === 'cancelled') return 'cancelled' as const
        if (ensured.status === 'resident') {
          if (isStale()) return 'cancelled' as const
          return runTransaction(intent)
        }
        if (ensured.status === 'not-found') {
          if (isStale()) return 'cancelled' as const
          // Authoritative missing: single user-visible toast per navigate call.
          // No retry loop here, so no toast storm. Pending clears via the
          // existing `result !== 'cancelled'` path in bootstrap/event handlers.
          window.toast.error(tRef.current('history.error.message_not_found'))
          return 'not-found' as const
        }
        if (ensured.status === 'error') {
          // Retryable transport/unknown/malformed: log already emitted in the
          // loader (privacy-safe, no IDs). Preserve pending by mapping to
          // `cancelled`; no user toast (no suitable generic key — log only).
          return 'cancelled' as const
        }

        if (isStale()) return 'cancelled' as const

        // Atomic staged publication (blocks then merged messages + route
        // capability in ONE Redux commit, synchronously with no interleaving
        // await). `messagesWindowMerged` unions the response-window capability
        // into the same-route resident set so no intermediate all-immutable
        // frame is published. No manual `messagesRef` assignment: the
        // transaction below runs only after the projection commit is observable.
        if (ensured.blocks.length > 0) {
          dispatch(withClosureTopics(upsertManyBlocks(ensured.blocks), topicIdAtStart))
        }
        dispatch(
          newMessagesActions.messagesWindowMerged({
            topicId: topicIdAtStart,
            messages: ensured.messages,
            route: routeAtStart,
            mutableMessageIds: ensured.mutableMessageIds ?? []
          })
        )

        const committed = await waitForProjectionCommit(targetId, isStale)
        if (!committed) return 'cancelled' as const
        if (isStale()) return 'cancelled' as const

        return runTransaction(intent)
      })()
    },
    [dispatch, runTransaction, waitForProjectionCommit]
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
            // Branch inheritance (docs/adr/context-window.md §9) via the authority
            // resolver: one metadata-only `chatdb:resolve-context-closure`
            // (intent `inherit`, `detail: 'anchor'`) call maps the parent's
            // persisted anchor by index into the new branch with clamp,
            // falling back to the target default when the source anchor is
            // invalid. No loaded messageIds group lists. Main never persists
            // settings; only the non-stale returned anchor is persisted
            // (empty branch stays anchorless). Metadata-only anchor responses
            // carry no messages/blocks and never enter normal Redux.
            void (async () => {
              try {
                const latestAssistant = (() => {
                  try {
                    return store.getState().assistants.assistants.find((a) => a.id === assistant.id) ?? assistant
                  } catch {
                    return assistant
                  }
                })()
                const latestSettings = getAssistantSettings(latestAssistant)
                // In-chat Copy Topic clones the active route's effective
                // prefix: the source anchor is read under the route key and
                // resolved as that route's source branch.
                const sourceRoute = routeRef.current
                const sourceAnchorKey =
                  typeof sourceRoute === 'string' && sourceRoute.length > 0 ? `${topic.id}:${sourceRoute}` : topic.id
                const sourceAnchor = latestSettings.contextWindowAnchor?.[sourceAnchorKey]
                const sourceKey =
                  sourceAnchor && (sourceAnchor as { kind: string; groupKey: string }).kind === 'active'
                    ? (sourceAnchor as { kind: string; groupKey: string }).groupKey
                    : null
                const response = await dbService.resolveContextClosure({
                  topicId: newTopic.id,
                  intent: 'inherit',
                  sourceTopicId: topic.id,
                  sourceBranchId: sourceRoute,
                  sourceAnchorGroupKey: sourceKey,
                  contextCount: latestSettings.contextCount ?? null,
                  currentAnchorGroupKey: null,
                  detail: 'anchor'
                })
                const resolved = response.resolvedAnchorGroupKey
                if (resolved === null || resolved === undefined) {
                  return
                }
                // Stale guard: only persist when the new branch still has no
                // anchor (the inherit call captured a null target anchor).
                const freshAssistant = (() => {
                  try {
                    return store.getState().assistants.assistants.find((a) => a.id === assistant.id) ?? assistant
                  } catch {
                    return assistant
                  }
                })()
                const freshSettings = getAssistantSettings(freshAssistant)
                const freshAnchor = freshSettings.contextWindowAnchor?.[newTopic.id] as
                  | { kind: string; groupKey: string }
                  | undefined
                if (freshAnchor?.kind === 'active') {
                  return
                }
                updateAssistantSettings({
                  contextWindowAnchor: {
                    ...freshSettings.contextWindowAnchor,
                    [newTopic.id]: { kind: 'active', groupKey: resolved }
                  }
                })
              } catch (error) {
                // Inherit failure (NOT_FOUND/transport) preserves settings;
                // fall back to establishment so a non-empty branch still
                // receives an anchor without loaded-viewport decisions.
                try {
                  await ensureTopicAnchorEstablished(dispatch, store.getState, assistant.id, newTopic.id)
                } catch {
                  logger.error('[NEW_BRANCH] Failed to inherit context window anchor', error as Error)
                }
              }
            })()

            window.toast.success(t('chat.message.copy_topic.created'))
          },
          onFailure: () => {
            logger.error(`[NEW_BRANCH] Failed to create topic branch for topic ${newTopic.id}`)
            window.toast.error(t('message.branch.error'))
          }
        })
      }),
      // Distinct TRUE branch creation (the ONLY true-branch creation method).
      // Forks one internal branch node at the anchor message of the ACTIVE
      // route (which may itself be inherited) with no prefix cloning and no
      // sync intent. New branches default to the localized New Branch name;
      // no auto-rename (the name is the branch identity shown on its fork
      // divider and the top breadcrumb). No edit-and-branch. Creating a
      // branch immediately selects it; the topic stays fixed (never
      // addTopic/setActiveTopic — branches are not topics).
      EventEmitter.on(EVENT_NAMES.NEW_TRUE_BRANCH, async (messageId: string) => {
        const defaultName = t('chat.topics.branch.default_name')
        const parentRoute = routeRef.current

        await branchFromAnchorMessage(messagesRef.current, messageId, {
          createBranchByAnchor: async (anchorId) => {
            const created = await createBranch(topic.id, parentRoute, anchorId, defaultName)
            if (created === null) return false
            // Immediately select the new route on the same logical topic,
            // then load its (empty-suffix) effective route via a windowed
            // `latest` read (never a fork-point read). Claimed locally so the
            // external-invalidation effect stays out of this path. The new
            // branch explicitly lands at latest/bottom (tail vicinity),
            // never above the fork point.
            loadedRouteRef.current = claimLoadedRoute(created.branchId)
            dispatch(activeBranchSet({ topicId: topic.id, branchId: created.branchId }))
            requestTopicBranches(dispatch, topic.id)
            const topicIdAtCreate = topic.id
            const newRoute = created.branchId
            await dispatch(loadRouteMessagesThunk(topicIdAtCreate, newRoute, { kind: 'latest' }))
            if (topicIdRef.current !== topicIdAtCreate || routeRef.current !== newRoute) return true
            try {
              const loaded = (selectLoadedMessagesForTopic(store.getState(), topicIdAtCreate) ?? []) as Message[]
              if (loaded.length > 0) {
                const latestWindow = createLatestMessageWindow(loaded, displayCount)
                viewportDispatch({ type: 'window/apply', window: latestWindow })
              }
            } catch {
              // fail-closed: loaded projection already rebased; viewport keeps prior window
            }
            // Explicit latest/bottom positioning under scroll ownership so the
            // bottom snap is never recorded as a user scroll.
            const release = holdProgrammaticScrollOwnership()
            try {
              await navigate({ kind: 'bottom', source: 'imperative' })
            } finally {
              release()
            }
            return true
          },
          onMessageNotFound: () => {
            logger.error(`[NEW_TRUE_BRANCH] Message not found: ${messageId}`)
          },
          onSuccess: () => {
            window.toast.success(t('chat.message.true_branch.created'))
          },
          onFailure: () => {
            logger.error(`[NEW_TRUE_BRANCH] Failed to create branch in topic ${topic.id}`)
            window.toast.error(t('message.true_branch.error'))
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
              dispatch(
                withClosureTopics(updateOneBlock({ id: msgBlockId, changes: { content: updatedRaw } }), topic.id)
              )

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

  const startOlderWindowLoad = useCallback(
    (preferred?: PreferredRestoreAnchorSnapshot | null) => {
      const preferredSnapshot: PreferredRestoreAnchorSnapshot | null = preferred
        ? preferred.kind === 'divider-row'
          ? { kind: 'divider-row', dividerKey: preferred.dividerKey, targetOffset: preferred.targetOffset }
          : { kind: 'message-row', messageId: preferred.messageId, targetOffset: preferred.targetOffset }
        : null
      const currentState = viewportStateRef.current
      if (!currentState.window?.hasMoreOlder || currentState.loading.older) return

      const anchorId = currentState.window?.oldestMessageId
      if (!anchorId) {
        logger.warn('[loadMoreMessages] missing stable anchor for R-03 around')
        return
      }

      const loadToken = {}
      const topicGeneration = currentState.topicGeneration
      const topicIdAtStart = topic.id
      const routeAtStart = routeRef.current
      const routeCacheKey = `${topicIdAtStart}::${routeAtStart ?? ''}`
      const deletionGenAtStart = captureDeletionGeneration(topicIdAtStart)
      const capturedResidentGen = captureResidentGeneration(() => store.getState(), topicIdAtStart)
      viewportDispatch({ type: 'load/start', direction: 'older', token: loadToken })

      const container = scrollContainerRef.current
      const anchor = findFirstVisibleMessage(container, messageElements.current)

      const before = clampWindowCount(LOAD_MORE_COUNT)
      const after = 1
      const request: FetchMessagesWindowRequest = {
        kind: 'around',
        topicId: topicIdAtStart,
        branchId: routeAtStart,
        anchorMessageId: anchorId,
        before,
        after
      }

      // S6.1 coverage check — fail-closed: only reuse cached window if it fully covers the request for current topic/generation
      // Topic-deletion epoch check at local join boundary: discarding cached window if deleted during lifetime
      if (isDeletionStale(topicIdAtStart, deletionGenAtStart)) {
        windowCacheRef.current.delete(routeCacheKey)
      }
      const cachedWindow = windowCacheRef.current.get(routeCacheKey)
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

            // stale discard — topic/route changed, generation advanced, or deleted during fetch, or resident generation advanced
            if (topic.id !== topicIdAtStart) {
              viewportDispatch({ type: 'load/cancel', direction: 'older', token: loadToken, topicGeneration })
              return
            }
            if (routeRef.current !== routeAtStart) {
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
            const currentResidentGen = captureResidentGeneration(() => store.getState(), topicIdAtStart)
            if (shouldDiscardPaginationForResident(capturedResidentGen, currentResidentGen)) {
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

            // atomic staged publication: validate first, then merged messages +
            // route capability in ONE Redux commit (no intermediate clear).
            windowCacheRef.current.set(routeCacheKey, response as unknown as FetchMessagesWindowResponse)
            const blocks = response.blocks as unknown as MessageBlock[]
            const incoming = response.messages as unknown as Message[]
            const existing = messagesRef.current
            const merged = mergeWindowIntoTopic(existing, incoming, anchorId)

            if (blocks.length > 0) {
              dispatch(withClosureTopics(upsertManyBlocks(blocks), topicIdAtStart))
            }
            // install merged ordered list + merged capability as single Redux transition
            dispatch(
              newMessagesActions.messagesWindowMerged({
                topicId: topicIdAtStart,
                messages: merged,
                route: routeAtStart,
                mutableMessageIds: Array.isArray(
                  (response as unknown as { mutableMessageIds?: unknown }).mutableMessageIds
                )
                  ? ((response as unknown as { mutableMessageIds: string[] }).mutableMessageIds ?? [])
                  : []
              })
            )

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

            if (anchor || preferredSnapshot) {
              requestAnimationFrame(async () => {
                if (!isCurrentLoad('older', loadToken, topicGeneration)) return
                const live = scrollContainerRef.current ?? container
                if (!live) return
                const esc =
                  typeof CSS !== 'undefined' &&
                  typeof (CSS as unknown as { escape?: (v: string) => string }).escape === 'function'
                    ? (CSS as unknown as { escape: (v: string) => string }).escape
                    : (v: string) => v
                const measurePreferred = (): number | null => {
                  if (!preferredSnapshot) return null
                  try {
                    if (preferredSnapshot.kind === 'divider-row') {
                      const row = document.querySelector(
                        `[data-divider-key="${esc(preferredSnapshot.dividerKey)}"]`
                      ) as HTMLElement | null
                      if (row && row.isConnected) {
                        return row.getBoundingClientRect().top - live.getBoundingClientRect().top
                      }
                      return null
                    }
                    const el = document.getElementById(`message-${esc(preferredSnapshot.messageId)}`)
                    if (el && el.isConnected) {
                      return el.getBoundingClientRect().top - live.getBoundingClientRect().top
                    }
                    return null
                  } catch {
                    return null
                  }
                }
                let fallbackDelta: number | null = null
                if (anchor && anchor.element && anchor.element.isConnected) {
                  try {
                    fallbackDelta = anchor.element.getBoundingClientRect().top - anchor.rect.top
                  } catch {
                    fallbackDelta = null
                  }
                }
                // DB query still reads around oldestMessageId; DOM compensation
                // prefers the restore anchor's current offset at its targetOffset
                // and falls back to the viewport-top message only when the
                // preferred target is missing/disconnected. Ordinary pagination
                // passes no preferred snapshot and keeps the old behavior.
                const decision = decidePaginationCompensation({
                  preferred: preferredSnapshot,
                  preferredCurrentOffset: preferredSnapshot ? measurePreferred() : null,
                  fallbackDelta
                })
                if (decision.kind === 'none') return
                const usedPreferred = decision.kind === 'preferred'
                const delta = decision.delta
                // Never start a second stabilizer conflicting with the active
                // route-restore stabilizer: reuse the restore ownership with a
                // direct delta + single-frame suppress and return.
                if (activeStabilizerRef.current) {
                  try {
                    live.scrollTop += delta
                  } catch {
                    return
                  }
                  const generation = armStabilizerSuppress(stabilizerSuppressRef.current, live.scrollTop)
                  try {
                    requestAnimationFrame(() => {
                      if (stabilizerSuppressRef.current.generation === generation) {
                        stabilizerSuppressRef.current.armed = false
                      }
                    })
                  } catch {}
                  return
                }
                const scrollToken = {}
                if (!(await beginScroll('anchoring', scrollToken))) return
                // beginScroll awaited a commit: a route restore may have started
                // its stabilizer in between, so the pre-await active check above
                // is stale. Re-read the live session here — this path has not
                // assigned yet, so any live entry belongs to the other
                // restore/pagination owner. Never start a second stabilizer over
                // it: single delta + single-frame suppress, then end our own
                // scroll token exactly once without touching the other ref.
                const activeAfterBegin = activeStabilizerRef.current
                if (activeAfterBegin) {
                  if (!isCurrentLoad('older', loadToken, topicGeneration)) {
                    viewportDispatch({ type: 'scroll/end', token: scrollToken })
                    return
                  }
                  if (!usedPreferred && anchor && !anchor.element.isConnected) {
                    viewportDispatch({ type: 'scroll/end', token: scrollToken })
                    return
                  }
                  try {
                    live.scrollTop += delta
                  } catch {
                    viewportDispatch({ type: 'scroll/end', token: scrollToken })
                    return
                  }
                  const contendedGeneration = armStabilizerSuppress(stabilizerSuppressRef.current, live.scrollTop)
                  try {
                    requestAnimationFrame(() => {
                      if (stabilizerSuppressRef.current.generation === contendedGeneration) {
                        stabilizerSuppressRef.current.armed = false
                      }
                    })
                  } catch {}
                  viewportDispatch({ type: 'scroll/end', token: scrollToken })
                  return
                }
                if (!isCurrentLoad('older', loadToken, topicGeneration)) {
                  viewportDispatch({ type: 'scroll/end', token: scrollToken })
                  return
                }
                if (!usedPreferred && anchor && !anchor.element.isConnected) {
                  viewportDispatch({ type: 'scroll/end', token: scrollToken })
                  return
                }
                try {
                  live.scrollTop += delta
                } catch {
                  viewportDispatch({ type: 'scroll/end', token: scrollToken })
                  return
                }
                const generation = armStabilizerSuppress(stabilizerSuppressRef.current, live.scrollTop)
                try {
                  requestAnimationFrame(() => {
                    if (stabilizerSuppressRef.current.generation === generation) {
                      stabilizerSuppressRef.current.armed = false
                    }
                  })
                } catch {}
                // Bounded short stabilizer for the preferred anchor only:
                // cancellable, user-input-first via the shared active session.
                // Live re-read (never hardcoded): start only while still empty.
                const hasActivePaginationBlocker = activeStabilizerRef.current !== null
                if (
                  shouldStartPaginationStabilizer({
                    hasActiveRestoreStabilizer: hasActivePaginationBlocker,
                    usedPreferredAnchor: usedPreferred
                  }) &&
                  preferredSnapshot &&
                  !hasActivePaginationBlocker
                ) {
                  const paginationEpoch = restoreEpochRef.current
                  const targetOffset = preferredSnapshot.targetOffset
                  const getTargetElement = (): HTMLElement | null => {
                    try {
                      if (preferredSnapshot.kind === 'divider-row') {
                        const row = document.querySelector(
                          `[data-divider-key="${esc(preferredSnapshot.dividerKey)}"]`
                        ) as HTMLElement | null
                        return row && row.isConnected ? row : null
                      }
                      const el = document.getElementById(`message-${esc(preferredSnapshot.messageId)}`)
                      return el && el.isConnected ? (el as unknown as HTMLElement) : null
                    } catch {
                      return null
                    }
                  }
                  const stabilizer = runBoundedPositionStabilizer(
                    live,
                    targetOffset,
                    {
                      getCurrentOffset: () => {
                        if (restoreEpochRef.current !== paginationEpoch) return null
                        if (!isCurrentLoad('older', loadToken, topicGeneration)) return null
                        return measurePreferred()
                      },
                      applyDelta: (d) => {
                        try {
                          live.scrollTop += d
                        } catch {
                          return
                        }
                        const g = armStabilizerSuppress(stabilizerSuppressRef.current, live.scrollTop)
                        try {
                          requestAnimationFrame(() => {
                            if (stabilizerSuppressRef.current.generation === g) {
                              stabilizerSuppressRef.current.armed = false
                            }
                          })
                        } catch {}
                      },
                      isCancelled: () =>
                        restoreEpochRef.current !== paginationEpoch ||
                        !isCurrentLoad('older', loadToken, topicGeneration)
                    },
                    { maxMs: 600, quietMs: 80 },
                    { getTargetElement }
                  )
                  activeStabilizerRef.current = {
                    handle: stabilizer,
                    scrollToken,
                    release: () => {},
                    epoch: paginationEpoch
                  }
                  try {
                    await stabilizer.done
                  } finally {
                    // Handle-identity guard: same-epoch concurrent sessions share
                    // the epoch, so only the owner clears its own ref — never a
                    // newer restore/pagination session that claimed it meanwhile.
                    if (
                      restoreEpochRef.current === paginationEpoch &&
                      activeStabilizerRef.current?.handle === stabilizer
                    ) {
                      stabilizer.cancel()
                      activeStabilizerRef.current = null
                    }
                  }
                }
                requestAnimationFrame(() => {
                  try {
                    if (restoreEpochRef.current !== undefined)
                      viewportDispatch({ type: 'scroll/end', token: scrollToken })
                  } catch {}
                })
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
    },
    [beginScroll, dispatch, isCurrentLoad, setTimeoutTimer, scrollContainerRef, topic.id, viewportDispatch]
  )

  // InfiniteScroll `next` entry (older edge): temporary scroll ownership or
  // active navigation must queue a generation-bound intent instead of dropping
  // it, otherwise the internal latch never releases and later scrolls retry
  // nothing.
  const loadMoreMessages = useCallback(() => {
    const currentState = viewportStateRef.current
    if (!currentState.window?.hasMoreOlder || currentState.loading.older) {
      if (!currentState.window?.hasMoreOlder) pendingOlderIntentRef.current = null
      return
    }
    if (!canHandleUserViewportScroll(currentState)) {
      if (shouldQueueOlderIntent(currentState)) {
        // Snapshot the current preferred restore anchor (stable identity +
        // targetOffset only, never the live ref) so the replayed pagination
        // holds the divider/saved row still. Ordinary user pagination has no
        // active anchor and snapshots null (behavior unchanged).
        const preferredSnapshot = snapshotRestoreAnchor(activeRestoreAnchorRef.current, {
          topicId: topic.id,
          routeId: routeRef.current,
          restoreEpoch: restoreEpochRef.current
        })
        pendingOlderIntentRef.current = createPendingOlderIntent({
          topicId: topic.id,
          routeId: routeRef.current,
          topicGeneration: currentState.topicGeneration,
          deletionGeneration: captureDeletionGeneration(topic.id),
          residentGeneration: captureResidentGeneration(() => store.getState(), topic.id),
          preferredAnchor: preferredSnapshot
        })
      }
      return
    }
    pendingOlderIntentRef.current = null
    startOlderWindowLoad()
  }, [startOlderWindowLoad, topic.id])

  // Pending replay: reads the *committed* viewport state (effect input after
  // scroll/end), never a stale ref. Single replay — cleared before starting —
  // so success/failure/hasMore/left-edge all converge without loops. Loading
  // guard keeps the intent while a load is active.
  useEffect(() => {
    const pending = pendingOlderIntentRef.current
    if (!pending) return
    const committed = viewportState
    const decision = decidePendingOlderReplay({
      pending,
      live: {
        topicId: topic.id,
        routeId: routeRef.current,
        topicGeneration: committed.topicGeneration,
        deletionGeneration: captureDeletionGeneration(topic.id),
        residentGeneration: captureResidentGeneration(() => store.getState(), topic.id),
        hasMoreOlder: committed.window?.hasMoreOlder ?? false,
        loadingOlder: committed.loading.older
      },
      committed,
      atOldestEdge: isStillAtOldestEdge(scrollContainerRef.current)
    })
    if (decision.action === 'keep') return
    const replayAnchor = pending.preferredAnchor ?? null
    pendingOlderIntentRef.current = null
    if (decision.action === 'discard') return
    startOlderWindowLoad(replayAnchor)
  }, [viewportState, topic.id, activeBranchId, startOlderWindowLoad])

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
    const routeAtStart = routeRef.current
    const routeCacheKey = `${topicIdAtStart}::${routeAtStart ?? ''}`
    const deletionGenAtStart = captureDeletionGeneration(topicIdAtStart)
    const capturedResidentGen = captureResidentGeneration(() => store.getState(), topicIdAtStart)
    viewportDispatch({ type: 'load/start', direction: 'newer', token: loadToken })

    const container = scrollContainerRef.current
    const anchor = findFirstVisibleMessage(container, messageElements.current)

    const before = 1
    const after = clampWindowCount(LOAD_MORE_COUNT)
    const request: FetchMessagesWindowRequest = {
      kind: 'around',
      topicId: topicIdAtStart,
      branchId: routeAtStart,
      anchorMessageId: anchorId,
      before,
      after
    }

    if (isDeletionStale(topicIdAtStart, deletionGenAtStart)) {
      windowCacheRef.current.delete(routeCacheKey)
    }
    const cachedWindow = windowCacheRef.current.get(routeCacheKey)
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
          if (routeRef.current !== routeAtStart) {
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
          const currentResidentGen = captureResidentGeneration(() => store.getState(), topicIdAtStart)
          if (shouldDiscardPaginationForResident(capturedResidentGen, currentResidentGen)) {
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

          windowCacheRef.current.set(routeCacheKey, response as unknown as FetchMessagesWindowResponse)
          const blocks = response.blocks as unknown as MessageBlock[]
          const incoming = response.messages as unknown as Message[]
          const existing = messagesRef.current
          const merged = mergeWindowIntoTopic(existing, incoming, anchorId)

          if (blocks.length > 0) {
            dispatch(withClosureTopics(upsertManyBlocks(blocks), topicIdAtStart))
          }
          dispatch(
            newMessagesActions.messagesWindowMerged({
              topicId: topicIdAtStart,
              messages: merged,
              route: routeAtStart,
              mutableMessageIds: Array.isArray(
                (response as unknown as { mutableMessageIds?: unknown }).mutableMessageIds
              )
                ? ((response as unknown as { mutableMessageIds: string[] }).mutableMessageIds ?? [])
                : []
            })
          )

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

  // Synchronously cancel the active stabilizer for genuine user input.
  // Ends the viewport scroll token and releases hook ownership so the
  // cancelling scroll (and every later one) is recorded as a normal user
  // route snapshot. Takes the session first, so end/release happen exactly
  // once even if a restore `finally` runs later (epoch mismatch skips).
  // Self-induced deltas never reach here (single-frame expected-scrollTop
  // suppress below). `handle.cancel` settles `done` synchronously.
  const cancelActiveStabilizerForUser = useCallback(() => {
    const active = activeStabilizerRef.current
    if (!active) return
    activeStabilizerRef.current = null
    restoreEpochRef.current += 1
    activeRestoreAnchorRef.current = null
    stabilizerSuppressRef.current.armed = false
    try {
      active.handle.cancel()
    } catch {}
    try {
      viewportDispatch({ type: 'scroll/end', token: active.scrollToken })
    } catch {}
    try {
      active.release()
    } catch {}
  }, [viewportDispatch])

  // Wheel/touch/pointer input cancels even before the scroll event fires.
  // Programmatic compensation never emits these, so no self-cancel risk.
  // Scrollbar drag fires pointerDown first, so it is already covered here.
  const handleStabilizerUserInput = useCallback(() => {
    if (activeStabilizerRef.current) cancelActiveStabilizerForUser()
  }, [cancelActiveStabilizerForUser])

  // Keyboard scroll pre-cancel: ArrowUp/Down, PageUp/Down, Home/End, Space.
  // Input targets (input/textarea/select/contentEditable) and modified keys
  // never cancel so editing and shortcuts keep the stabilizer alive.
  const handleStabilizerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!activeStabilizerRef.current) return
      let target: { tagName?: string; isContentEditable?: boolean } | null = null
      try {
        target = e.target as unknown as { tagName?: string; isContentEditable?: boolean }
      } catch {
        target = null
      }
      if (
        !shouldCancelStabilizerForKeyDown(
          { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey },
          target
        )
      ) {
        return
      }
      handleStabilizerUserInput()
    },
    [handleStabilizerUserInput]
  )

  const handleScroll = useCallback(() => {
    // User-scroll cancel sits BEFORE the viewport user-scroll gate: while a
    // stabilizer holds `beginScroll('anchoring'/'programmatic')` the gate is
    // closed by design, but a genuine user scroll must still cancel the
    // stabilizer immediately. The stabilizer's own programmatic deltas arm a
    // single-frame expected-scrollTop suppress (cleared on the next frame)
    // and are ignored here — never cancelled, never recorded. Any other
    // scrollTop (keyboard/scrollbar/wheel on the next frame or with a
    // different offset) cancels and falls through so the cancelling scroll
    // is recorded as the route snapshot.
    const active = activeStabilizerRef.current
    let userCancelledScroll = false
    if (active) {
      const containerForSuppress = scrollContainerRef.current
      const actualScrollTop = containerForSuppress ? containerForSuppress.scrollTop : null
      if (actualScrollTop !== null && isSelfInducedStabilizerScroll(stabilizerSuppressRef.current, actualScrollTop)) {
        return
      }
      cancelActiveStabilizerForUser()
      userCancelledScroll = true
      // Fall through: the cancelling scroll is a real user scroll (including
      // pure keyboard-triggered scroll) and must be recorded below as the
      // route snapshot. The viewport gate below is bypassed for this event
      // because `viewportStateRef` still holds the pre-cancel anchoring mode
      // until the layout effect commits; hook ownership was already released
      // synchronously so `handleScrollPosition` records normally.
    }
    const currentState = viewportStateRef.current
    if (!userCancelledScroll && !canHandleUserViewportScroll(currentState)) return

    handleScrollPosition()

    const container = scrollContainerRef.current
    if (container && hasMoreNewer && !isLoadingNewer && !isLoadingMore) {
      // Column-reverse: bottom (newest) is scrollTop ≈ 0, so the newer-edge
      // prefetch uses the single geometry primitive (never the oldest formula).
      if (distanceFromBottom(container.scrollTop) < COLUMN_REVERSE_NEWER_PREFETCH_PX) {
        loadNewerMessages()
      }
    }
  }, [
    cancelActiveStabilizerForUser,
    handleScrollPosition,
    hasMoreNewer,
    isLoadingNewer,
    isLoadingMore,
    loadNewerMessages,
    scrollContainerRef
  ])

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

  // Divider route switch: reliable visual invariant is "the clicked fork
  // divider row keeps the same pixel offset inside the container".
  // The clicked divider passes its stable identity (anchor + parent) and its
  // synchronously captured offset; Messages re-captures the same row before
  // the route leaves, loads the target route window around the fork anchor
  // (never the target history snapshot, never bottom), then restores the
  // SAME logical divider row to the SAME offset after commit + rAF, followed
  // by a bounded stabilizer for late Markdown/image/divider layout.
  // Fallback chain (never bottom): same anchor+parent divider row → shared
  // message visual anchor → fork message. The nearest-to-top message is NOT
  // the primary divider anchor. The OLD route's route-saved-row-anchor is
  // preserved via synchronous savePosition (route-keyed); the target route's
  // snapshot is never overwritten here. The loaded projection is rebased
  // atomically (no blank/reset, no mixed route).
  //
  // Anchor namespaces (never cross-write): `dividerVisualAnchor` (this path,
  // pixel offset of the divider row), `routeSavedRowAnchor` (route-local
  // snapshot messageId + intraRowOffset, top-selector path), `contextAnchor`
  // (contextBoundaryMessageId, model-context boundary only).
  const handleSelectRoute = useCallback(
    async (branchId: string | null, anchorMessageId: string, dividerInfo?: DividerSwitchInfo) => {
      const topicId = topic.id
      if (branchId === routeRef.current) return
      const topicIdAtStart = topicId
      const prevRoute = routeRef.current
      // Divider-visual-anchor snapshot, captured synchronously before reload:
      // prefer the passed divider offset, else measure the stable divider row.
      const container = scrollContainerRef.current
      const containerRect = container?.getBoundingClientRect() ?? null
      const parentOfDivider = dividerInfo?.parentBranchId ?? prevRoute
      const dividerKey = dividerInfo?.dividerKey ?? buildDividerKey(anchorMessageId, parentOfDivider)
      let dividerVisualAnchorOffset: number | null = dividerInfo?.dividerOffset ?? null
      if (dividerVisualAnchorOffset === null && container && containerRect) {
        try {
          const esc =
            typeof CSS !== 'undefined' &&
            typeof (CSS as unknown as { escape?: (v: string) => string }).escape === 'function'
              ? (CSS as unknown as { escape: (v: string) => string }).escape
              : (v: string) => v
          const row =
            (document.querySelector(`[data-divider-key="${esc(dividerKey)}"]`) as HTMLElement | null) ??
            (document.querySelector(
              `[data-testid="${esc(dividerRowTestId(anchorMessageId, parentOfDivider))}"]`
            ) as HTMLElement | null)
          dividerVisualAnchorOffset = captureDividerOffset(row, container)
        } catch {
          dividerVisualAnchorOffset = null
        }
      }
      // Shared-message fallback anchor (stable viewport-top content anchor,
      // crossing-first; NOT a min-abs-distance midpoint).
      const fallbackTop = findViewportTopAnchorWithOffset(container)
      const sharedVisualMessageId = fallbackTop?.messageId ?? null
      void findFirstVisibleMessage
      const rawScrollTop = container ? container.scrollTop : null
      loadedRouteRef.current = claimLoadedRoute(branchId)
      savePosition()
      cancelActiveLoads()
      // Incremental: keep the current viewport visible during the windowed
      // fetch (no topic/reset blank). Only the per-route window cache is
      // dropped so stale windows cannot satisfy the new route.
      windowCacheRef.current.clear()
      dispatch(activeBranchSet({ topicId, branchId }))
      let routeWindow: FetchMessagesWindowResponse
      try {
        // Fork-anchor windowed read with latest fallback for the same target
        // route (production `loadRouteWindowWithFallback` path).
        const settled = await loadRouteWindowWithFallback(
          dispatch,
          topicId,
          branchId,
          {
            anchorMessageId,
            before: NAVIGATION_VISUALLY_OLDER_GROUPS,
            after: NAVIGATION_VISUALLY_NEWER_GROUPS
          },
          () => topicIdRef.current === topicIdAtStart && routeRef.current === branchId
        )
        routeWindow = settled.response
      } catch (error) {
        logger.error(`[handleSelectRoute] Failed to load route for topic ${topicId}:`, error as Error)
        window.toast.error(t('message.true_branch.error'))
        const dividerRecovery = decideDividerDoubleFailureRecovery({
          prevRoute,
          targetRoute: branchId,
          startTopicId: topicIdAtStart,
          currentTopicId: topicIdRef.current,
          currentRoute: routeRef.current
        })
        if (dividerRecovery.shouldRollback) {
          loadedRouteRef.current = claimLoadedRoute(dividerRecovery.rollbackTo)
          dispatch(activeBranchSet({ topicId, branchId: dividerRecovery.rollbackTo }))
        }
        return
      }
      if (topicIdRef.current !== topicIdAtStart || routeRef.current !== branchId) return
      try {
        const loaded = (selectLoadedMessagesForTopic(store.getState(), topicId) ?? []) as Message[]
        const authoritative = routeWindow.window
          ? {
              hasMoreBefore: routeWindow.window.hasMoreBefore,
              hasMoreAfter: routeWindow.window.hasMoreAfter
            }
          : undefined
        const { window: targetWindow } = buildRouteViewport(
          loaded,
          [anchorMessageId, sharedVisualMessageId],
          authoritative,
          NAVIGATION_VISUALLY_OLDER_GROUPS,
          NAVIGATION_VISUALLY_NEWER_GROUPS
        )
        if (targetWindow) {
          viewportDispatch({ type: 'window/apply', window: targetWindow })
        }
      } catch (error) {
        logger.error(`[handleSelectRoute] Failed to rebuild viewport window:`, error as Error)
        return
      }
      // Divider-identity restore after the effective-route render: the SAME
      // logical divider row returns to the SAME pixel offset; fallback chain
      // is shared-message → fork message; raw scroll is the last resort.
      // Held under the viewport scroll token + hook ownership so the
      // compensation is never recorded as a user scroll, then stabilized
      // against late layout (bounded, cancellable).
      try {
        await viewportCommitWaiterRef.current.wait(viewportStateRef.current, (committedState) => {
          if (committedState.window?.displayMessages?.length) return true
          return null
        })
      } catch {
        // fail-closed: continue to rAF restore attempt
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (topicIdRef.current !== topicIdAtStart || routeRef.current !== branchId) return
          const live = scrollContainerRef.current
          if (!live || dividerVisualAnchorOffset === null) return
          void (async () => {
            // Restore generation: topic + route + mounted + this restore still
            // current. Never `canHandleUserViewportScroll` — the anchoring
            // token below closes that gate by design and would self-cancel.
            const restoreEpoch = ++restoreEpochRef.current
            // Preferred visual anchor for queued pagination: the same divider
            // row at the same targetOffset (or the shared message row when the
            // divider offset is unmeasurable). Bound to topic/route/epoch;
            // queued intents snapshot only its stable identity + offset.
            if (dividerVisualAnchorOffset !== null) {
              activeRestoreAnchorRef.current = createDividerRestoreAnchor({
                dividerKey,
                targetOffset: dividerVisualAnchorOffset,
                topicId: topicIdAtStart,
                routeId: branchId,
                restoreEpoch
              })
            } else if (fallbackTop) {
              activeRestoreAnchorRef.current = createMessageRestoreAnchor({
                messageId: fallbackTop.messageId,
                targetOffset: fallbackTop.intraRowOffset,
                topicId: topicIdAtStart,
                routeId: branchId,
                restoreEpoch
              })
            } else {
              activeRestoreAnchorRef.current = null
            }
            const stillTarget = () =>
              isRestoreTargetValid({
                topicMatch: topicIdRef.current === topicIdAtStart,
                routeMatch: routeRef.current === branchId,
                mounted: !unmountedRef.current,
                epochCurrent: restoreEpochRef.current === restoreEpoch
              })
            const esc =
              typeof CSS !== 'undefined' &&
              typeof (CSS as unknown as { escape?: (v: string) => string }).escape === 'function'
                ? (CSS as unknown as { escape: (v: string) => string }).escape
                : (v: string) => v
            const targetOffset = dividerVisualAnchorOffset
            const getDividerRowEl = (): HTMLElement | null => {
              const row =
                (document.querySelector(`[data-divider-key="${esc(dividerKey)}"]`) as HTMLElement | null) ??
                (document.querySelector(
                  `[data-testid="${esc(dividerRowTestId(anchorMessageId, parentOfDivider))}"]`
                ) as HTMLElement | null)
              return row && row.isConnected ? row : null
            }
            const getDividerOffset = (): number | null => {
              const row = getDividerRowEl()
              if (row) {
                try {
                  return row.getBoundingClientRect().top - live.getBoundingClientRect().top
                } catch {
                  return null
                }
              }
              return null
            }
            const applyCompensation = (delta: number): void => {
              if (!stillTarget()) return
              try {
                live.scrollTop += delta
              } catch {
                return
              }
              // Precise single-frame suppress: only the scroll event whose
              // scrollTop still equals the post-apply value is self-induced.
              // Cleared on the next frame (generation-guarded) so keyboard or
              // scrollbar scrolls on the next frame / with a different offset
              // always cancel instead of being swallowed.
              const generation = armStabilizerSuppress(stabilizerSuppressRef.current, live.scrollTop)
              try {
                requestAnimationFrame(() => {
                  if (stabilizerSuppressRef.current.generation === generation) {
                    stabilizerSuppressRef.current.armed = false
                  }
                })
              } catch {}
            }
            const restoreDecision = decideDividerRestoreTarget({
              dividerKeyPresentInTarget: getDividerOffset() !== null,
              sharedVisualMessageId,
              forkAnchorMessageId: anchorMessageId
            })
            const scrollToken = {}
            const releaseOwnership = holdProgrammaticScrollOwnership()
            let committed = false
            try {
              committed = await beginScroll('anchoring', scrollToken)
              if (!committed) return
              if (!stillTarget()) return
              if (restoreDecision.kind === 'divider-row') {
                const current = getDividerOffset()
                if (current !== null) {
                  const delta = current - targetOffset
                  if (Math.abs(delta) > 1) applyCompensation(delta)
                } else if (restoreDecision.targetId) {
                  // Unreachable for divider-row; kept for exhaustiveness.
                  void restoreDecision.targetId
                } else if (rawScrollTop !== null && Math.abs(live.scrollTop - rawScrollTop) > 1) {
                  applyCompensation(rawScrollTop - live.scrollTop)
                }
              } else if (restoreDecision.kind === 'shared-message' && restoreDecision.targetId) {
                const el = document.getElementById(`message-${esc(restoreDecision.targetId)}`)
                if (el && el.isConnected && fallbackTop) {
                  const want = fallbackTop.intraRowOffset
                  const have = el.getBoundingClientRect().top - live.getBoundingClientRect().top
                  const delta = have - want
                  if (Math.abs(delta) > 1) applyCompensation(delta)
                } else if (rawScrollTop !== null) {
                  applyCompensation(rawScrollTop - live.scrollTop)
                }
              } else if (restoreDecision.targetId) {
                const el = document.getElementById(`message-${esc(restoreDecision.targetId)}`)
                if (el && el.isConnected) {
                  const have = el.getBoundingClientRect().top - live.getBoundingClientRect().top
                  const delta = have - targetOffset
                  if (Math.abs(delta) > 1) applyCompensation(delta)
                } else if (rawScrollTop !== null && Math.abs(live.scrollTop - rawScrollTop) > 1) {
                  applyCompensation(rawScrollTop - live.scrollTop)
                }
              } else if (rawScrollTop !== null && Math.abs(live.scrollTop - rawScrollTop) > 1) {
                applyCompensation(rawScrollTop - live.scrollTop)
              }
              // Bounded stabilizer for late Markdown/image/divider layout:
              // re-align the same divider offset; cancels on restore-epoch
              // invalidation (route/topic/user-input/unmount); quiet + 1500ms
              // deadline bounded; cancelled sessions never compensate further.
              const stabilizer = runBoundedPositionStabilizer(
                live,
                targetOffset,
                {
                  getCurrentOffset: () => {
                    if (!stillTarget()) return null
                    // Only stabilize the divider row itself; message fallbacks
                    // already settled above and must not be dragged further.
                    if (restoreDecision.kind !== 'divider-row') return targetOffset
                    return getDividerOffset()
                  },
                  applyDelta: (delta) => {
                    applyCompensation(delta)
                  },
                  isCancelled: () => !stillTarget()
                },
                { maxMs: 1500, quietMs: 120 },
                { getTargetElement: () => getDividerRowEl() }
              )
              activeStabilizerRef.current = {
                handle: stabilizer,
                scrollToken,
                release: releaseOwnership,
                epoch: restoreEpoch
              }
              try {
                await stabilizer.done
              } finally {
                // Exactly-once session teardown: only the still-current epoch
                // owns end/release. A user cancel or unmount already took the
                // session (epoch bumped) and released; skip here to keep a
                // single cancel/end/release per return/error path.
                if (restoreEpochRef.current === restoreEpoch) {
                  stabilizer.cancel()
                  activeStabilizerRef.current = null
                }
              }
            } finally {
              // Restore-owned token/ownership: release only while still the
              // current epoch; user-cancel/unmount already released exactly
              // once and bumped the epoch. The active restore anchor lifecycle
              // ends here (queued intents already hold their detached snapshot).
              if (restoreEpochRef.current === restoreEpoch) {
                activeRestoreAnchorRef.current = null
                try {
                  viewportDispatch({ type: 'scroll/end', token: scrollToken })
                } catch {}
                try {
                  releaseOwnership()
                } catch {}
                if (activeStabilizerRef.current?.epoch === restoreEpoch) activeStabilizerRef.current = null
              }
            }
          })()
        })
      })
    },
    [beginScroll, cancelActiveLoads, dispatch, savePosition, t, topic.id, viewportDispatch]
  )

  // Route deletion fallback (branch subtree removal with active fallback):
  // the ONLY owner that reloads the fallback route. Triggered by the one-shot
  // `deletionFallbackRequested` intent emitted together with the active switch
  // in `deleteBranchSubtree` (both delete entries share that helper). Always
  // an explicit `latest` windowed read — never `chooseRouteWindowRequest` /
  // snapshot `around`. Claims `loadedRouteRef` first so the generic route
  // effect below stays out of this path; the generic effect additionally
  // skips while an intent for the current route is pending, so no concurrent
  // `around` can cover this `latest`. Deleted-route scroll snapshots are
  // dropped again here (covers throttle-flush recreation after the key
  // change); the fallback route's own snapshot is preserved for future normal
  // top-selector restores. Stale-safe: a rapid follow-up switch (topic/route
  // moved on) discards without publishing; `loadRouteMessagesThunk`'s own
  // request-sequence / active-route / generation guards provide the second
  // layer. Success builds a `latest` viewport with the full `displayCount`
  // window (deleting the last branch restores the never-branched full tail)
  // and pins latest/bottom under scroll ownership.
  useEffect(() => {
    const intent = deletionFallbackIntent
    if (!intent) return
    if (topic.id !== topicIdRef.current) return
    // Stale intent (user already switched again): consume without loading so
    // the deleted-route reload can never overwrite the current route.
    if (intent.route !== activeBranchId) {
      dispatch(deletionFallbackConsumed({ topicId: topic.id, intentId: intent.intentId }))
      return
    }
    if (isLoadedRouteCurrent(loadedRouteRef.current, activeBranchId)) {
      dispatch(deletionFallbackConsumed({ topicId: topic.id, intentId: intent.intentId }))
      return
    }
    loadedRouteRef.current = claimLoadedRoute(activeBranchId)
    const topicIdAtEffect = topic.id
    const routeAtEffect = activeBranchId
    const intentIdAtEffect = intent.intentId
    const deletedIdsAtEffect = [...intent.deletedBranchIds]
    cancelActiveLoads()
    // Invalidate any in-flight divider/top restores before the latest load.
    restoreEpochRef.current += 1
    // Incremental: keep the current viewport during the windowed fetch (no
    // topic/reset blank). Only the per-route window cache is dropped so stale
    // deleted-route windows cannot satisfy the fallback.
    windowCacheRef.current.clear()
    // Drop deleted-route scroll snapshots again (the helper already dropped
    // them before the key change; this covers the key-change throttle flush
    // recreation). Never touches the fallback route's own snapshot.
    try {
      const keyv =
        typeof window !== 'undefined'
          ? (window as unknown as { keyv?: { remove?: (k: string) => unknown } })?.keyv
          : undefined
      for (const branchId of deletedIdsAtEffect) {
        if (typeof branchId !== 'string' || branchId.length === 0) continue
        const key = `scroll:topic-${topicIdAtEffect}::${branchId}`
        try {
          keyv?.remove?.(key)
        } catch {
          // best-effort
        }
        try {
          handleScrollSnapshotCleared(key)
        } catch {
          // best-effort
        }
      }
    } catch {
      // fail-closed: latest read below still ignores snapshots
    }
    void (async () => {
      let routeWindow: FetchMessagesWindowResponse | void
      try {
        routeWindow = await dispatch(loadRouteMessagesThunk(topicIdAtEffect, routeAtEffect, { kind: 'latest' }))
      } catch (error) {
        logger.error('[deletionFallback] Failed to reload fallback route with latest:', error as Error)
        window.toast.error(t('message.true_branch.error'))
        if (topicIdRef.current !== topicIdAtEffect || routeRef.current !== routeAtEffect) {
          dispatch(deletionFallbackConsumed({ topicId: topicIdAtEffect, intentId: intentIdAtEffect }))
          return
        }
        loadedRouteRef.current = markLoadedRouteFailed(routeAtEffect)
        dispatch(deletionFallbackConsumed({ topicId: topicIdAtEffect, intentId: intentIdAtEffect }))
        return
      }
      // Stale follow-up switch: never publish, just consume.
      if (topicIdRef.current !== topicIdAtEffect || routeRef.current !== routeAtEffect) {
        dispatch(deletionFallbackConsumed({ topicId: topicIdAtEffect, intentId: intentIdAtEffect }))
        return
      }
      // A stale (superseded/generation-mismatched) latest read publishes
      // nothing (void): keep the failed marker retryable instead of applying
      // a half viewport.
      if (!routeWindow || !routeWindow.window) {
        loadedRouteRef.current = markLoadedRouteFailed(routeAtEffect)
        dispatch(deletionFallbackConsumed({ topicId: topicIdAtEffect, intentId: intentIdAtEffect }))
        return
      }
      try {
        const loaded = (selectLoadedMessagesForTopic(store.getState(), topicIdAtEffect) ?? []) as Message[]
        const authoritative = routeWindow.window
          ? {
              hasMoreBefore: routeWindow.window.hasMoreBefore,
              hasMoreAfter: routeWindow.window.hasMoreAfter
            }
          : undefined
        // Explicit latest viewport over the full displayCount window (never a
        // snapshot anchor, never a vicinity fallback). Empty fallback routes
        // atomically clear via the same constructor.
        const latestWindow = createLatestMessageWindow(loaded, displayCount, authoritative)
        viewportDispatch({ type: 'window/apply', window: latestWindow })
        // Pin latest/bottom under scroll ownership so the snap is never
        // recorded as a user scroll.
        const release = holdProgrammaticScrollOwnership()
        try {
          await navigate({ kind: 'bottom', source: 'imperative' })
        } finally {
          release()
        }
      } catch (error) {
        logger.error('[deletionFallback] Failed to rebuild fallback viewport:', error as Error)
      } finally {
        dispatch(deletionFallbackConsumed({ topicId: topicIdAtEffect, intentId: intentIdAtEffect }))
      }
    })()
  }, [
    activeBranchId,
    cancelActiveLoads,
    deletionFallbackIntent,
    dispatch,
    displayCount,
    navigate,
    t,
    topic.id,
    viewportDispatch
  ])

  // Top-selector route switch + external route invalidation (branch deleted
  // elsewhere, delete-fallback after subtree removal, catalog prune, topic
  // switch restore): the active route changed without a divider switch, so
  // the loaded projection is stale. The old route's position was already
  // snapshotted route-keyed (scroll throttle flush on key change) — never
  // overwrite the NEW route's snapshot here. The target window is read per
  // the NEW route's saved browsing position: isAtBottom → latest; saved
  // anchorId → around it; no valid snapshot → latest + vicinity/tail fallback
  // below. Never a bottom jump unless the saved position is at bottom, never
  // a topic transition. Divider-initiated switches claim loadedRouteRef first
  // and never enter this path.
  //
  // Double-failure degradation (around + latest both fail): the active route
  // is external truth and cannot roll back, so the viewport is atomically
  // cleared to an empty window and the loaded projection to [] — never "new
  // active route + old route projection", never mixed pagination. The failure
  // marker keeps loadedRouteRef diverged so the route effect (or a subsequent
  // route/topic switch) retries with a fresh load instead of believing the
  // new route is loaded.
  useEffect(() => {
    if (topic.id !== topicIdRef.current) return
    // Deletion-fallback intents own their route: the dedicated latest effect
    // above claims and reloads. Never issue a concurrent snapshot-around here.
    if (deletionFallbackIntent && deletionFallbackIntent.route === activeBranchId) return
    if (isLoadedRouteCurrent(loadedRouteRef.current, activeBranchId)) return
    loadedRouteRef.current = claimLoadedRoute(activeBranchId)
    const topicIdAtEffect = topic.id
    const routeAtEffect = activeBranchId
    const vicinityIds = messagesRef.current.map((m) => m.id)
    // Read the NEW route's route-saved-row-anchor snapshot before any fetch
    // (route-keyed; legacy topic-only key as main-route fallback). Never save
    // here — the OLD route was saved synchronously before the switch, and
    // the target snapshot must never be overwritten by this path.
    let saved: {
      scrollTop: number
      anchorId: string | null
      messageId?: string | null
      intraRowOffset?: number | null
      rawScrollTop?: number
      isAtBottom: boolean
    } | null = null
    try {
      saved = getRouteSavedPosition() ?? (routeAtEffect === null ? getLegacyMainSavedPosition() : null)
    } catch {
      saved = null
    }
    cancelActiveLoads()
    // Incremental: keep the current viewport during the windowed fetch (no
    // topic/reset blank). Only the per-route window cache is dropped.
    windowCacheRef.current.clear()
    void (async () => {
      let routeWindow: FetchMessagesWindowResponse | void
      try {
        const choice = chooseRouteWindowRequest(saved)
        if (choice.kind === 'latest') {
          routeWindow = await dispatch(loadRouteMessagesThunk(topicIdAtEffect, routeAtEffect, { kind: 'latest' }))
        } else {
          try {
            routeWindow = await dispatch(
              loadRouteMessagesThunk(topicIdAtEffect, routeAtEffect, {
                kind: 'around',
                anchorMessageId: choice.anchorMessageId,
                before: NAVIGATION_VISUALLY_OLDER_GROUPS,
                after: NAVIGATION_VISUALLY_NEWER_GROUPS
              })
            )
          } catch {
            // Saved anchor not on the target route (cross-route snapshot):
            // fall back to latest + vicinity/tail below.
            if (topicIdRef.current !== topicIdAtEffect || routeRef.current !== routeAtEffect) return
            routeWindow = await dispatch(loadRouteMessagesThunk(topicIdAtEffect, routeAtEffect, { kind: 'latest' }))
          }
        }
      } catch (error) {
        logger.error('[routeInvalidation] Failed to reload route after external change:', error as Error)
        window.toast.error(t('message.true_branch.error'))
        // External-truth double failure (production decision helper): cannot
        // roll the active route back, so clear both the loaded projection and
        // the viewport atomically. The tagged failed state keeps the real
        // route key with loadFailed=true, so the next route effect (or
        // route/topic switch) reloads instead of trusting a projection that
        // was never loaded. Stale-safe: only clears while still on the
        // failed target.
        const externalRecovery = decideExternalDoubleFailureRecovery({
          targetRoute: routeAtEffect,
          startTopicId: topicIdAtEffect,
          currentTopicId: topicIdRef.current,
          currentRoute: routeRef.current
        })
        if (!externalRecovery.shouldClear) return
        try {
          dispatch(newMessagesActions.rebaseRouteMessages({ topicId: topicIdAtEffect, messages: [] }))
        } catch {
          // fail-closed: viewport clear below still removes visible residual
        }
        loadedRouteRef.current = markLoadedRouteFailed(routeAtEffect)
        try {
          const emptyWindow = createLatestMessageWindow([], 1, { hasMoreBefore: false, hasMoreAfter: false })
          viewportDispatch({ type: 'window/apply', window: emptyWindow })
        } catch {
          // fail-closed: loaded projection already cleared above
        }
        return
      }
      if (topicIdRef.current !== topicIdAtEffect || routeRef.current !== routeAtEffect) return
      try {
        const loaded = (selectLoadedMessagesForTopic(store.getState(), topicIdAtEffect) ?? []) as Message[]
        const loadedIds = new Set(loaded.map((m) => m.id))
        // Vicinity/tail fallback when no valid snapshot: first still-present
        // loaded message, else route tail. With a valid snapshot the window
        // was already read around it; rebuild the same vicinity here so the
        // viewport apply is deterministic. Empty target routes atomically
        // clear the viewport (no old-route residual) with authoritative flags.
        // Route-saved-row-anchor: canonical messageId with legacy anchorId
        // alias; contextAnchor (contextBoundaryMessageId) never feeds this.
        const routeSavedRowAnchor =
          (typeof saved?.messageId === 'string' && loadedIds.has(saved.messageId) ? saved.messageId : null) ??
          (typeof saved?.anchorId === 'string' && loadedIds.has(saved.anchorId) ? saved.anchorId : null)
        const anchor = routeSavedRowAnchor ?? vicinityIds.find((id) => loadedIds.has(id)) ?? null
        const authoritative =
          routeWindow && routeWindow.window
            ? {
                hasMoreBefore: routeWindow.window.hasMoreBefore,
                hasMoreAfter: routeWindow.window.hasMoreAfter
              }
            : undefined
        const { window: targetWindow } = buildRouteViewport(
          loaded,
          [anchor],
          authoritative,
          NAVIGATION_VISUALLY_OLDER_GROUPS,
          NAVIGATION_VISUALLY_NEWER_GROUPS
        )
        if (targetWindow) {
          viewportDispatch({ type: 'window/apply', window: targetWindow })
        }
        // Route-local restore: isAtBottom → latest + bottom; else
        // around(saved messageId) + precise intra-row offset. Held under the
        // viewport scroll token + hook ownership so the programmatic restore
        // is never recorded as a user scroll, then bounded-stabilized for
        // late layout. Repeated restores converge to the same position.
        // Target validity is the restore epoch (topic/route/mounted/epoch),
        // never `canHandleUserViewportScroll` (the programmatic token below
        // closes that gate by design and would self-cancel).
        const topRestoreEpoch = ++restoreEpochRef.current
        const stillTopTarget = () =>
          isRestoreTargetValid({
            topicMatch: topicIdRef.current === topicIdAtEffect,
            routeMatch: routeRef.current === routeAtEffect,
            mounted: !unmountedRef.current,
            epochCurrent: restoreEpochRef.current === topRestoreEpoch
          })
        // Preferred visual anchor for queued pagination: the saved message row
        // keeps its intra-row offset even when top-selector auto-pagination
        // inserts older rows. Bottom restores carry no row anchor.
        if (routeSavedRowAnchor && typeof saved?.intraRowOffset === 'number' && Number.isFinite(saved.intraRowOffset)) {
          activeRestoreAnchorRef.current = createMessageRestoreAnchor({
            messageId: routeSavedRowAnchor,
            targetOffset: saved.intraRowOffset,
            topicId: topicIdAtEffect,
            routeId: routeAtEffect,
            restoreEpoch: topRestoreEpoch
          })
        } else {
          activeRestoreAnchorRef.current = null
        }
        try {
          if (saved?.isAtBottom) {
            const release = holdProgrammaticScrollOwnership()
            try {
              await navigate({ kind: 'bottom', source: 'imperative' })
            } finally {
              release()
            }
          } else if (routeSavedRowAnchor) {
            const wantOffset =
              typeof saved?.intraRowOffset === 'number' && Number.isFinite(saved.intraRowOffset)
                ? saved.intraRowOffset
                : null
            const release = holdProgrammaticScrollOwnership()
            const scrollToken = {}
            let committed = false
            try {
              committed = await beginScroll('programmatic', scrollToken)
              if (!committed) return
              if (!stillTopTarget()) return
              await navigate({ kind: 'message', targetId: routeSavedRowAnchor, source: 'imperative' })
              if (!stillTopTarget()) return
              const live = scrollContainerRef.current
              if (live && wantOffset !== null) {
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
                if (!stillTopTarget()) return
                try {
                  const esc =
                    typeof CSS !== 'undefined' &&
                    typeof (CSS as unknown as { escape?: (v: string) => string }).escape === 'function'
                      ? (CSS as unknown as { escape: (v: string) => string }).escape
                      : (v: string) => v
                  const el = document.getElementById(`message-${esc(routeSavedRowAnchor)}`)
                  const applyTopCompensation = (delta: number): void => {
                    if (!stillTopTarget()) return
                    try {
                      live.scrollTop += delta
                    } catch {
                      return
                    }
                    // Precise single-frame suppress (same contract as the
                    // divider path): only the matching expected scrollTop is
                    // self-induced; next-frame/different offsets cancel.
                    const generation = armStabilizerSuppress(stabilizerSuppressRef.current, live.scrollTop)
                    try {
                      requestAnimationFrame(() => {
                        if (stabilizerSuppressRef.current.generation === generation) {
                          stabilizerSuppressRef.current.armed = false
                        }
                      })
                    } catch {}
                  }
                  if (el && el.isConnected) {
                    const have = el.getBoundingClientRect().top - live.getBoundingClientRect().top
                    const delta = have - wantOffset
                    if (Math.abs(delta) > 1) applyTopCompensation(delta)
                    const stabilizer = runBoundedPositionStabilizer(
                      live,
                      wantOffset,
                      {
                        getCurrentOffset: () => {
                          if (!stillTopTarget()) return null
                          if (!el.isConnected) return null
                          try {
                            return el.getBoundingClientRect().top - live.getBoundingClientRect().top
                          } catch {
                            return null
                          }
                        },
                        applyDelta: (delta) => {
                          applyTopCompensation(delta)
                        },
                        isCancelled: () => !stillTopTarget()
                      },
                      { maxMs: 1500, quietMs: 120 },
                      {
                        getTargetElement: () => {
                          try {
                            const next = document.getElementById(`message-${esc(routeSavedRowAnchor)}`)
                            return next && next.isConnected ? (next as unknown as HTMLElement) : null
                          } catch {
                            return null
                          }
                        }
                      }
                    )
                    activeStabilizerRef.current = {
                      handle: stabilizer,
                      scrollToken,
                      release,
                      epoch: topRestoreEpoch
                    }
                    try {
                      await stabilizer.done
                    } finally {
                      // Exactly-once: only the still-current epoch owns
                      // cancel/end/release; user-cancel/unmount already took
                      // the session and bumped the epoch.
                      if (restoreEpochRef.current === topRestoreEpoch) {
                        stabilizer.cancel()
                        activeStabilizerRef.current = null
                      }
                    }
                  }
                } catch {
                  // fail-closed: keep the navigated vicinity
                }
              }
            } finally {
              // Restore-owned token/ownership: release only while still the
              // current epoch so every return/error path releases once. The
              // saved-row anchor lifecycle ends here (queued intents already
              // hold their detached snapshot).
              if (restoreEpochRef.current === topRestoreEpoch) {
                activeRestoreAnchorRef.current = null
                try {
                  viewportDispatch({ type: 'scroll/end', token: scrollToken })
                } catch {}
                try {
                  release()
                } catch {}
                if (activeStabilizerRef.current?.epoch === topRestoreEpoch) activeStabilizerRef.current = null
              }
            }
          } else if (saved && typeof saved.scrollTop === 'number') {
            const live = scrollContainerRef.current
            if (live) {
              const release = holdProgrammaticScrollOwnership()
              try {
                requestAnimationFrame(() => {
                  if (topicIdRef.current !== topicIdAtEffect || routeRef.current !== routeAtEffect) return
                  try {
                    live.scrollTop = saved.scrollTop
                  } catch {
                    // fail-closed: keep the vicinity window position
                  }
                })
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
              } finally {
                release()
              }
            }
          }
        } catch {
          // fail-closed: keep the vicinity window position
        }
      } catch (error) {
        logger.error('[routeInvalidation] Failed to rebuild viewport window:', error as Error)
      }
    })()
  }, [
    activeBranchId,
    beginScroll,
    cancelActiveLoads,
    deletionFallbackIntent,
    dispatch,
    getLegacyMainSavedPosition,
    getRouteSavedPosition,
    navigate,
    t,
    topic.id,
    viewportDispatch
  ])

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
          onSelectRoute={handleSelectRoute}
          onStabilizerUserInput={handleStabilizerUserInput}
          onStabilizerKeyDown={handleStabilizerKeyDown}
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
