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
import useScrollPosition, { commitSnapshotForRoute, routeScrollKey } from '@renderer/hooks/useScrollPosition'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTimer } from '@renderer/hooks/useTimer'
import { autoRenameTopic } from '@renderer/hooks/useTopic'
import { useTopicSegments } from '@renderer/hooks/useTopicSegments'
import { useTopicTransition } from '@renderer/hooks/useTopicTransition'
import {
  COLUMN_REVERSE_BOTTOM_THRESHOLD_PX,
  COLUMN_REVERSE_NEWER_PREFETCH_PX,
  distanceFromBottom,
  isAtBottom as isColumnReverseAtBottom
} from '@renderer/pages/home/Messages/columnReverseGeometry'
import {
  findFirstVisibleMessage,
  findViewportTopAnchorWithOffset,
  getMessageRowById
} from '@renderer/pages/home/Messages/domVisibility'
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
import { loadRouteMessagesThunk, updateMessageAndBlocksThunk } from '@renderer/store/thunk/messageThunk'
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

import { AnchorGroupProvider } from './anchorGroupContext'
import {
  buildDividerKey,
  captureDividerOffset,
  dividerRowTestId,
  type DividerSwitchInfo,
  findAnchorsWithChildren,
  ForkDivider
} from './BranchDividers'
import { decideDividerRestoreSearchStep, type DividerSearchTerminalReason } from './dividerRestoreSearch'
import {
  buildDividerSearchProgressFromVisible,
  buildDividerVisibleMessages,
  isDividerVisibleUnionExact,
  planDividerVisibleRebase
} from './dividerVisibleRebase'
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
import { createMessageViewportGroupModel } from './messageGroups'
import { NAVIGATION_VISUALLY_NEWER_GROUPS, NAVIGATION_VISUALLY_OLDER_GROUPS } from './messageNavigation'
import { buildRenderLayers, buildRenderSegments } from './messageRenderLayers'
import { useCrossMessageSelectionGuard, useEditModeNativeSelectionSuppression } from './messageSelectionGuard'
import {
  buildRouteViewport,
  canonicalSavedAnchorId,
  chooseRouteWindowRequest,
  chooseTopFirstPositionPlan,
  claimLoadedRoute,
  createTargetMessageWindow,
  decideDividerDoubleFailureRecovery,
  decideExternalDoubleFailureRecovery,
  decideTopRestoreAnchor,
  initLoadedRouteState,
  isLoadedRouteCurrent,
  isTopRestoreNotFoundError,
  isTopStableCommittable,
  markLoadedRouteFailed
} from './messageWindow'
import { isRestoreTargetValid, shouldCancelStabilizerForKeyDown } from './positionStabilizer'
import Prompt from './Prompt'
import { attemptFirstPosition, isFirstPlacementAwaitingAttempt } from './routeFirstPlacement'
import { buildRouteVisibleMessages, isRouteVisibleUnionExact, planTopVisibleRebase } from './routeOverlapRebase'
import { decidePaginationCompensation, type PreferredRestoreAnchorSnapshot } from './routeRestoreAnchor'
import {
  alignRetainedViewportOnce,
  shouldContinueRetainedViewport,
  shouldRestoreRetainedWindowInPlace,
  shouldTopPipelineRefuseDividerIntent
} from './routeViewportActivation'
import {
  buildContainerCapturer,
  isCaptureContainerHidden,
  useOptionalRouteViewport,
  useStableVisualAnchor,
  viewportPhaseAttrFor
} from './routeViewportContext'
import { displayedRouteKey, RouteViewportController } from './routeViewportController'
import { MessagesContainer, MessagesWrapper, ScrollContainer } from './shared'
import TopicSegmentLine from './TopicSegmentLine'
import { requestTopicBranches, useBranchTree } from './useBranchTree'
import { createViewportCommitWaiter } from './viewportCommitWaiter'
import {
  isViewportTransitionCurrent,
  type ViewportFirstPositionOutcome,
  type ViewportFirstPositionPlan,
  type ViewportTransitionPhase
} from './viewportTransition'

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
  /** Atomic viewport transition phase (diagnostic `data-viewport-phase`; hidden while positioning). */
  viewportPhase: ViewportTransitionPhase
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
  onStabilizerKeyDown,
  viewportPhase
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
        data-viewport-phase={viewportPhase}
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
  // Single route viewport transition controller: component-scoped via the
  // conversation-surface provider (Chat), with a per-instance fallback so
  // isolated tests render without a provider. The controller SOLELY owns the
  // route transition epoch, intent, phase, programmatic ownership
  // (released exactly once), displayed-route provenance, and the active
  // visual anchor. Redux still owns only the SELECTED activeBranch;
  // messageViewportReducer still owns projection/window.
  const viewportCtx = useOptionalRouteViewport()
  const [, setLocalViewportVersion] = useState(0)
  const [localConnectionGeneration, setLocalConnectionGeneration] = useState(0)
  const localControllerRef = useRef<RouteViewportController | null>(null)
  if (!localControllerRef.current && !viewportCtx) {
    localControllerRef.current = new RouteViewportController({ topicId: topic.id, route: activeBranchId })
  }
  const controller = viewportCtx?.controller ?? (localControllerRef.current as RouteViewportController)
  // Live context ref: adapter callbacks below read the CURRENT context at
  // call time under stable useCallback identities, so controller progress
  // notifies never recreate them — otherwise the route effect would re-run
  // mid-transition on every notify, open duplicate sessions, and ping-pong
  // epochs. The route effect runs on selected/topic change plus the explicit
  // reconnect connection-generation trigger; in-transition notifies only
  // re-render visuals/keeper (never restore: stable-clean/owned guards plus
  // no version dep).
  const viewportCtxRef = useRef(viewportCtx)
  viewportCtxRef.current = viewportCtx
  const notifyViewport = useCallback(() => {
    const live = viewportCtxRef.current
    if (live) {
      live.notifyChanged()
      return
    }
    setLocalViewportVersion((v) => v + 1)
  }, [])
  // Local fallback lifetime (isolated tests without a provider): the provider
  // owns attach/detach when present; this mirrors the resource lifetime only
  // for the fallback controller (single increment per mount, detach arms on
  // unmount). Ordinary local progress notifies above, never this signal.
  useEffect(() => {
    setLocalConnectionGeneration((g) => g + 1)
    return () => {
      try {
        localControllerRef.current?.detach()
      } catch {}
    }
  }, [])
  // Local suppression for imperative programmatic scrolls that are NOT route
  // transitions (e.g. new-branch landing bottom snap): while set, ordinary
  // scroll capture is dropped so the snap is never recorded as a user scroll.
  const suppressUserWriteRef = useRef(false)
  const viewportPhaseAttr =
    viewportCtx?.viewportPhaseAttr ??
    viewportPhaseAttrFor(
      controller.currentPhase,
      controller.currentIntent?.kind ?? null,
      controller.isActivationSession,
      controller.isActivationRequired,
      controller.isRetainedContinuation
    )
  // Explicit reconnect-activation trigger: the provider lifetime setup bumps
  // the connection generation on every Activity attach (local fallback bumps
  // once per mount above). The single TOP pipeline below depends ONLY on this
  // connection signal (plus selected topic/route) so a same-selected-route
  // reconnect retriggers the guarded own-target restore in the SAME effect
  // that loads it (never a second pipeline, never a loop: owned same-target
  // beyond-fetch-hold + stable-clean guards return). Ordinary controller
  // progress notifies (version) only re-render visuals/keeper, never restore.
  const viewportConnectionGeneration = viewportCtx?.connectionGeneration ?? localConnectionGeneration
  // Route-keyed scroll snapshots: each branch route keeps its own browsing
  // position under `topic-<id>::<branch|main>`. User scrolls are adopted
  // SOLELY via the atomic `controller.userTakeover()` in `handleScroll`
  // below (single writer → `commitSnapshotForRoute` with the returned key).
  // The hook keeps only explicit non-scroll duties (saved reads, topic-change
  // save, capture); its throttled scroll writer is never called for route
  // viewports (no double write with the takeover path).
  const {
    containerRef: scrollContainerRef,
    getSavedPosition,
    getSnapshotForRoute,
    savePosition,
    captureSnapshot
  } = useScrollPosition(`topic-${topic.id}::${activeBranchId ?? 'main'}`, {
    canWrite: () => {
      if (suppressUserWriteRef.current) return false
      // Explicit-save gate only (topic change / navigation persist): selected
      // must equal displayed and the controller must be unowned-clean, so no
      // key-change/stale-DOM gap can persist under the incoming key.
      const displayed = controller.displayedRoute
      if (displayed.topicId !== topic.id || displayed.route !== activeBranchId) return false
      return controller.canAcceptUserScrollWrite()
    }
  })
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
  // Displayed-route provenance is owned SOLELY by the controller (which route
  // the current committed DOM/window belongs to). Selected route is Redux
  // intent (`activeBranchId`/`routeRef`); the displayed route advances only
  // when the target is positioned and visible. Outgoing saves always write
  // under the DISPLAYED key, never the incoming selected route while old DOM
  // remains. During the incoming fetch the outgoing viewport stays visible;
  // controller ownership suppresses any write under the incoming identity.
  if (lastTopicForRouteRef.current !== topic.id) {
    lastTopicForRouteRef.current = topic.id
    loadedRouteRef.current = claimLoadedRoute(activeBranchId)
    // A topic change is not a route transition: sync the displayed route when
    // no transition owns it (a no-op while a transition is in flight).
    controller.syncDisplayed({ topicId: topic.id, route: activeBranchId })
    notifyViewport()
  }
  // Live container capturer for the controller's outgoing freeze (scoped to
  // this instance; unregistered on unmount). Persistent stable anchoring runs
  // in the keeper below (scoped observers, no polling).
  useEffect(() => {
    const register = viewportCtxRef.current?.registerCapturer
    if (register) {
      const capturer = buildContainerCapturer(scrollContainerRef)
      register(capturer)
      return () => register(null)
    }
    return undefined
    // Register once per mount: the capturer reads the live container at call
    // time, so context version bumps must not re-register (stable identity).
  }, [scrollContainerRef])
  // Persistent stable visual anchor maintainer (component-scoped keeper):
  // the keeper never takes over, never writes snapshots, never changes the
  // anchor — it only compensates `scrollTop` to hold the active anchor
  // offset. Messages calls `requestHold` for no-intent scrolls (visual
  // compensation only); the atomic `userTakeover` path stays sole writer.
  const anchorMaintainer = useStableVisualAnchor(scrollContainerRef)
  const anchorMaintainerRef = useRef(anchorMaintainer)
  anchorMaintainerRef.current = anchorMaintainer
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

  // Route transition truth lives SOLELY in `controller` (epoch, intent,
  // phase, ownership, displayed route, visual anchor). Validity is topic +
  // route + mounted + controller epoch still current — NEVER
  // `canHandleUserViewportScroll` (the anchoring token closes that gate by
  // design and would self-cancel). Genuine user input declares pending via
  // `controller.declareUserIntent()` and the scroll itself is adopted once via
  // `controller.userTakeover()`; programmatic compensation writes are
  // recognized by the stable-anchor keeper, never by timestamp windows.
  // Pending older-edge intent (InfiniteScroll latch fix): queued when `next`
  // fires while the viewport is temporarily non-user (anchoring/programmatic
  // restore or active navigation). Replayed once from the committed viewport
  // state after `navigation idle + scrollMode user` restores. Never depends
  // on library internals.
  const pendingOlderIntentRef = useRef<PendingOlderEdgeIntent | null>(null)
  const unmountedRef = useRef(false)
  // In-flight top fetch pipeline marker (same-session duplicate-run guard).
  const routeFetchEpochRef = useRef<number | null>(null)
  // First-position plan payload for the pre-paint layout reveal. Single
  // writer (the arm helpers below), never decision truth: every reader
  // re-gates on `controller.isSessionCurrent(epoch)`. Cleared only after the
  // owning session committed or terminated.
  const transitionPlanRef = useRef<{
    topicId: string
    routeId: string | null
    epoch: number
    plan: ViewportFirstPositionPlan
    /** Pre-paint first-position outcome (`searching` = intermediate edge parking). */
    outcome: ViewportFirstPositionOutcome | null
  } | null>(null)
  // First-placement reactive delivery + placement ack (bounded repair for the
  // branch→main dirty terminal): `transitionPlanRef` is ref-only (never
  // render state), so a recommitted plan can stay invisible to the pre-paint
  // layout effect when the window object, visual attr, and controller
  // primitives are all unchanged (retained same-window reactivation), and a
  // mutable controller read in an async completion can race React's render
  // commit (refused-while-`positioning` stable commit terminates the live
  // plan before it ever places). Every `commitRouteWindowAtomic` therefore
  // bumps `planSeq` (render state → the layout effect re-runs and attempts
  // the plan exactly once via `outcome`) and arms a per-epoch placement ack
  // that the layout effect settles on attempt; async completions await the
  // ack instead of completing/failing before placement. Supersession,
  // teardown, and terminal paths settle the previous ack unobserved (stale
  // no-op, never hangs, never disturbs the newer transaction).
  const [planSeq, setPlanSeq] = useState(0)
  const planSeqRef = useRef(0)
  const planAckRef = useRef<{ epoch: number; resolve: (observed: boolean) => void; promise: Promise<boolean> } | null>(
    null
  )
  // Divider restore search progress (binding invariant): while the requested
  // divider/shared anchor is outside the resident window, the restore stays in
  // a restoring/searching state under the owning session. Only the
  // resident→aligned→quiet path may commit the target route's stable
  // snapshot; terminal paths release exactly once with NO commit, preserving
  // the pre-existing target snapshot. Epoch truth is the controller's;
  // `ownerEpoch` is re-gated on every step — stale completions can never
  // commit. The new arm re-establishes the progress below.
  const dividerProgressRef = useRef<{
    ownerEpoch: number
    topicId: string
    routeId: string | null
    dividerKey: string
    anchorMessageId: string
    parentOfDivider: string | null
    sharedMessageId: string | null
    sharedOffset: number | null
    wantOffset: number | null
    pagesDriven: number
    lastLoadFailed: boolean
    drivenWindowKey: string | null
  } | null>(null)
  // Divider-only visible incremental rebase pending compensation (fast path).
  // Set synchronously with the visible window commit; the layout effect below
  // applies the synchronous first compensation (divider → wantOffset, explicit
  // shared fallback → sharedOffset), then a bounded quiet sequence (≥1 rAF)
  // revalidates + residual-corrects before the ONE stable commit. Ownership +
  // anchoring token stay held throughout. Cleared only after a successful
  // commit or a deliberate same-session fallback/termination (never cleared
  // ahead of a failed commit). Supersede/unmount cancels the quiet frame.
  const dividerVisibleRef = useRef<{
    ownerEpoch: number
    topicId: string
    routeId: string | null
    dividerKey: string
    anchorMessageId: string
    parentOfDivider: string | null
    sharedMessageId: string | null
    sharedOffset: number | null
    wantOffset: number
    windowId: string
    quietArmed: boolean
  } | null>(null)
  // Bounded quiet-frame handle for the visible rebase (at most two frames:
  // first quiet recheck, plus one residual recheck when a second correction
  // is written). Never a timer/stabilizer loop. Cancelled on
  // supersede/unmount/termination so stale callbacks stay inert.
  const dividerVisibleRafRef = useRef<number | null>(null)
  const cancelDividerVisibleQuiet = useCallback(() => {
    const handle = dividerVisibleRafRef.current
    dividerVisibleRafRef.current = null
    if (handle !== null) {
      try {
        cancelAnimationFrame(handle)
      } catch {}
    }
  }, [])
  // Top-only visible incremental rebase pending compensation (fast path).
  // Set synchronously with the visible union commit; the layout effect below
  // applies the synchronous first compensation to the target route's own saved
  // offset (never the divider click offset), then a bounded quiet sequence
  // (≥1 rAF) revalidates + residual-corrects before the ONE identity-stable
  // snapshot commit (`commitDisplayedStableWithAnchor`). Ownership + anchoring
  // token stay held throughout under the same controller session. Cleared
  // only after a successful commit or a deliberate termination (never cleared
  // ahead of a failed commit). Supersede/unmount cancels the quiet frame.
  // Never touches the divider search progress: lost residency falls back
  // through the existing top hidden terminal (fail-visible, preserve
  // snapshot), never divider search semantics.
  const topVisibleRef = useRef<{
    ownerEpoch: number
    topicId: string
    routeId: string | null
    anchorMessageId: string
    wantOffset: number
    windowId: string
    quietArmed: boolean
  } | null>(null)
  // Same-epoch top visible → hidden fallback payload (transient, single-use).
  // Stored synchronously when the visible union arms: the already-materialized
  // authoritative hidden target window + first-position plan + saved anchor
  // identity/offset for THIS epoch. Not a second controller truth (epoch,
  // intent, displayed, ownership all stay in the controller); consumed exactly
  // once by the fallback, cleared on success/terminal/supersede/unmount.
  const topHiddenFallbackRef = useRef<{
    ownerEpoch: number
    topicId: string
    routeId: string | null
    targetWindow: MessageWindow
    firstPlan: ViewportFirstPositionPlan
    anchorMessageId: string
    wantOffset: number
    isAtBottom: boolean
  } | null>(null)
  const topVisibleRafRef = useRef<number | null>(null)
  const cancelTopVisibleQuiet = useCallback(() => {
    const handle = topVisibleRafRef.current
    topVisibleRafRef.current = null
    if (handle !== null) {
      try {
        cancelAnimationFrame(handle)
      } catch {}
    }
  }, [])
  const cancelAllVisibleQuiet = useCallback(() => {
    cancelDividerVisibleQuiet()
    cancelTopVisibleQuiet()
  }, [cancelDividerVisibleQuiet, cancelTopVisibleQuiet])
  /** End the viewport's current scroll token (single anchoring owner at a time). */
  const endViewportScrollToken = useCallback(() => {
    const token = viewportStateRef.current.scrollToken
    if (!token) return
    try {
      viewportDispatch({ type: 'scroll/end', token })
    } catch {}
  }, [viewportDispatch])
  /**
   * Settle the live first-placement ack (stale no-op on epoch mismatch, never
   * disturbs the newer transaction). `epoch === null` settles whatever is
   * live (commit-time supersession). Resolution wakes the awaiting async
   * completion, which re-gates currency before completing.
   */
  const settlePlanAck = useCallback((epoch: number | null, observed: boolean) => {
    const ack = planAckRef.current
    if (!ack) return
    if (epoch !== null && ack.epoch !== epoch) return
    planAckRef.current = null
    try {
      ack.resolve(observed)
    } catch {}
  }, [])
  const failVisibleTransition = useCallback(
    (epoch: number) => {
      // Stale sessions are inert: never touch a newer session's token/phase.
      // A released-but-latest session (e.g. an `unplaced` first placement
      // that already terminalized inside the controller) still runs the
      // adoption below so the visible fallback becomes clean instead of
      // staying dirty indefinitely.
      if (epoch !== controller.currentEpoch) {
        return
      }
      const owned = controller.isSessionCurrent(epoch)
      cancelAllVisibleQuiet()
      if (owned) {
        controller.terminate(epoch, 'fail-visible')
      }
      // Deterministic own-target fallback: when the committed rendered window
      // is this session's own target AND the current selection, adopt it as
      // displayed so the terminal is clean (displayed == rendered) and a
      // future user scroll can save under the displayed-provenance target.
      // Guarded epoch + same-current target: pre-commit failures (rendered
      // bound to an older epoch or a cleared/empty window) adopt nothing, and
      // no snapshot is written — the pre-existing target snapshot is
      // preserved, never replaced by temporary fallback geometry.
      try {
        const rendered = controller.renderedProvenance
        if (
          rendered &&
          rendered.epoch === epoch &&
          rendered.topicId === topicIdRef.current &&
          rendered.routeId === routeRef.current &&
          (viewportStateRef.current.window?.displayMessages.length ?? 0) > 0
        ) {
          controller.adoptRenderedAsDisplayed(epoch)
        }
      } catch {
        // fail-closed: terminal still releases below
      }
      settlePlanAck(epoch, false)
      dividerProgressRef.current = null
      if (dividerVisibleRef.current?.ownerEpoch === epoch) dividerVisibleRef.current = null
      if (topVisibleRef.current?.ownerEpoch === epoch) topVisibleRef.current = null
      if (topHiddenFallbackRef.current?.ownerEpoch === epoch) topHiddenFallbackRef.current = null
      transitionPlanRef.current = null
      endViewportScrollToken()
      notifyViewport()
    },
    [cancelAllVisibleQuiet, controller, endViewportScrollToken, notifyViewport, settlePlanAck]
  )
  // Superseding teardown: terminate the current session (release exactly
  // once) so the next request starts clean. Never hides: callers own the
  // phase decision (arm re-hides, cancel fails visible).
  const tearDownViewportTransition = useCallback(() => {
    const epoch = controller.currentEpoch
    cancelAllVisibleQuiet()
    if (controller.programmaticOwned) {
      controller.terminate(epoch, 'superseded')
    }
    // The torn-down session's plan can never place: settle its ack
    // unobserved so any awaiting completion wakes and re-gates (stale no-op
    // for a newer session's ack by epoch mismatch).
    settlePlanAck(epoch, false)
    dividerProgressRef.current = null
    dividerVisibleRef.current = null
    topVisibleRef.current = null
    topHiddenFallbackRef.current = null
    transitionPlanRef.current = null
    endViewportScrollToken()
    notifyViewport()
  }, [cancelAllVisibleQuiet, controller, endViewportScrollToken, notifyViewport, settlePlanAck])
  /**
   * Bounded placement ack for async completions: while the current session's
   * plan is still awaiting its pre-paint placement attempt (`positioning` +
   * session-current + outcome unrecorded), wait for that explicit attempt
   * instead of committing or failing before it. The ack resolves via the
   * pre-paint layout effect of the same commit, or unobserved via
   * supersession/teardown/terminal — never polling, never an extra rAF,
   * never a forced render. Stale targets return false immediately; every
   * resumption re-gates currency before completing.
   */
  const awaitPlanPlacement = useCallback(
    async (epoch: number, isStillTarget: () => boolean): Promise<boolean> => {
      if (unmountedRef.current) return false
      if (!isStillTarget()) return false
      if (!isFirstPlacementAwaitingAttempt(controller, transitionPlanRef.current, epoch)) {
        return isStillTarget()
      }
      const ack = planAckRef.current
      if (!ack || ack.epoch !== epoch) return isStillTarget()
      try {
        await ack.promise
      } catch {
        return false
      }
      return isStillTarget()
    },
    [controller]
  )
  // NOTE: the former `armRouteTransition(plan, tid, route)` two-step arm has
  // been removed. Route-switch windows now commit ONLY via the single atomic
  // entry `commitRouteWindowAtomic` defined after `windowIdentityKey` below:
  // controller mark (epoch + target route + window identity → rendered) +
  // reducer dispatch + plan ref in ONE sync call; stale epochs refuse with no
  // dispatch, never tearing down the new session. Ordinary message
  // navigation / edit mode never enters that entry (not a route transition).
  // Bootstrap arm: same hidden-until-positioned contract without claiming the
  // viewport scroll token (the navigation transaction owns its own token).
  // Controller ownership alone suppresses transient capture pre-paint; the
  // stable completion commits explicitly without requiring user input.
  const armBootstrapTransition = useCallback(
    (plan: ViewportFirstPositionPlan, topicIdAtStart: string, routeAtStart: string | null) => {
      tearDownViewportTransition()
      const epoch = controller.request({ kind: 'generic', topicId: topicIdAtStart, targetRoute: routeAtStart }).epoch
      controller.appliedWindow(epoch)
      transitionPlanRef.current = { topicId: topicIdAtStart, routeId: routeAtStart, epoch, plan, outcome: null }
      notifyViewport()
      return epoch
    },
    [controller, tearDownViewportTransition, notifyViewport]
  )
  // Displayed-route/stable-snapshot coordinator (route-local viewports).
  // - Selected route = Redux intent (`routeRef`); displayed route =
  //   `controller.displayedRoute` (which route the current committed DOM
  //   belongs to).
  // - `saveDisplayedSnapshot` freezes the outgoing viewport under the
  //   DISPLAYED key synchronously before selected changes. Dropped while
  //   owned (transient): the existing stable snapshot stands.
  // - `beginFetchHold` opens the transition session (fetch-hold) across the
  //   incoming fetch (old viewport stays visible; no write may land under
  //   the incoming key). The positioning arm adopts it; rapid supersession
  //   terminates the old session (release exactly once) so stale fetches
  //   cannot arm or commit.
  // - `commitDisplayedStable` stores the final visible viewport under the
  //   target key on stable completion and advances the displayed route. A
  //   programmatic restore with no user input is itself a valid stable
  //   snapshot. Stale callers must gate on epoch (this helper re-checks
  //   topic/route/mounted/session currency).
  const displayedKeyFor = useCallback((tid: string, route: string | null): string => {
    return routeScrollKey(tid, route)
  }, [])
  const saveDisplayedSnapshot = useCallback((): boolean => {
    try {
      const live = viewportCtxRef.current
      if (live) {
        return live.freezeDisplayed()
      }
      // Isolated-render adapter for focused component tests (bare mount with
      // no provider): same controller-owned clean gate — dirty/owned states
      // preserve, never capture live DOM. Not a second production truth;
      // production Chat always provides the viewport context above.
      // Hidden-geometry guard (mirrors the provider capturer): never sample
      // display:none during detach; preserve the last legal snapshot instead.
      if (!controller.shouldCaptureOutgoing()) return false
      try {
        const liveContainer = scrollContainerRef.current as HTMLElement | null
        if (liveContainer) {
          // Positive hidden proof only (ancestor display:none / hidden /
          // disconnected); zero rects alone never prove hidden (jsdom).
          if (!liveContainer.isConnected) return false
          let el: HTMLElement | null = liveContainer
          while (el) {
            try {
              if (el.style?.display === 'none') return false
              if (el.hidden === true) return false
            } catch {}
            el = el.parentElement
          }
        }
      } catch {
        return false
      }
      const snapshot = captureSnapshot()
      if (!snapshot) return false
      return commitSnapshotForRoute(displayedRouteKey(controller.displayedRoute), snapshot)
    } catch {
      return false
    }
  }, [controller, captureSnapshot])
  const readTargetSnapshot = useCallback(
    (tid: string, route: string | null) => {
      try {
        const live = viewportCtxRef.current
        const out = live
          ? live.readSnapshot(displayedKeyFor(tid, route))
          : getSnapshotForRoute(displayedKeyFor(tid, route))
        return out
      } catch {
        return null
      }
    },
    [displayedKeyFor, getSnapshotForRoute]
  )
  const beginFetchHold = useCallback(
    (
      topicIdAtStart: string,
      incomingRoute: string | null,
      intent?: {
        kind: 'top' | 'divider' | 'generic'
        dividerKey?: string
        clickOffset?: number | null
        saved?: {
          scrollTop: number
          messageId: string | null
          intraRowOffset: number | null
          isAtBottom: boolean
        } | null
        snapshotInvalid?: boolean
      }
    ): number => {
      tearDownViewportTransition()
      const raw =
        intent?.saved !== undefined
          ? intent.saved
          : intent?.kind === 'top' || intent === undefined
            ? readTargetSnapshot(topicIdAtStart, incomingRoute)
            : null
      // Normalize the storage snapshot (optional fields) to the controller
      // snapshot shape (required nullable fields).
      const saved = raw
        ? {
            scrollTop: raw.scrollTop,
            messageId: raw.messageId ?? null,
            intraRowOffset: raw.intraRowOffset ?? null,
            isAtBottom: raw.isAtBottom
          }
        : null
      const { epoch } = controller.request({
        kind: intent?.kind ?? 'generic',
        topicId: topicIdAtStart,
        targetRoute: incomingRoute,
        dividerKey: intent?.dividerKey,
        clickOffset: intent?.clickOffset,
        saved,
        snapshotInvalid: intent?.snapshotInvalid
      })
      notifyViewport()
      return epoch
    },
    [controller, tearDownViewportTransition, notifyViewport, readTargetSnapshot]
  )
  /**
   * Adopt the in-flight fetch-hold session for the same topic/target (opened
   * by the top selector's controller request) instead of opening a second
   * one. Returns null when no adoptable session exists (external change,
   * deletion fallback, bootstrap) so the caller opens its own. TOP-specific:
   * never adopts a divider-owned session for the same target — divider
   * continue-here owns its clicked offset and must not be consumed by a
   * saved-snapshot TOP plan.
   */
  const adoptFetchHold = useCallback(
    (topicIdAtStart: string, incomingRoute: string | null): number | null => {
      if (shouldTopPipelineRefuseDividerIntent(controller, topicIdAtStart, incomingRoute)) return null
      const intent = controller.currentIntent
      if (
        controller.programmaticOwned &&
        controller.currentPhase === 'fetch-hold' &&
        intent !== null &&
        intent.topicId === topicIdAtStart &&
        intent.targetRoute === incomingRoute &&
        intent.kind !== 'divider'
      ) {
        return controller.currentEpoch
      }
      return null
    },
    [controller]
  )
  // Single-entry reconnect activation: NO separate hook ever opens a
  // transaction here. The single TOP pipeline below (connection-generation
  // dep) owns BOTH the guarded own-target `top` request AND the fetch →
  // window → measured layout/quiet/alignment → atomic reveal → stable commit
  // in the SAME bounded effect. Divider-owned sessions refuse there so a
  // generic activation never overwrites an explicit divider continuation.
  const commitDisplayedStable = useCallback(
    (tid: string, route: string | null, epoch: number): boolean => {
      if (unmountedRef.current) {
        return false
      }
      if (topicIdRef.current !== tid || routeRef.current !== route) {
        return false
      }
      if (!controller.isSessionCurrent(epoch)) {
        return false
      }
      const live = scrollContainerRef.current
      if (!live) {
        return false
      }
      const measured = captureSnapshot()
      if (!measured) {
        return false
      }
      const { commit } = controller.commitStable(epoch, {
        messageId: measured.messageId ?? null,
        intraRowOffset: measured.intraRowOffset ?? null,
        scrollTop: measured.scrollTop,
        isAtBottom: measured.isAtBottom
      })
      if (!commit) {
        return false
      }
      let stored = false
      try {
        stored = commitSnapshotForRoute(commit.routeKey, {
          scrollTop: commit.snapshot.scrollTop,
          anchorId: commit.snapshot.messageId,
          messageId: commit.snapshot.messageId,
          intraRowOffset: commit.snapshot.intraRowOffset,
          rawScrollTop: commit.snapshot.scrollTop,
          isAtBottom: commit.snapshot.isAtBottom
        })
      } catch {
        stored = false
      }
      transitionPlanRef.current = null
      endViewportScrollToken()
      notifyViewport()
      return stored
    },
    [controller, captureSnapshot, endViewportScrollToken, notifyViewport, scrollContainerRef]
  )
  // Top-route identity commit (route-local stable viewport): the stable
  // snapshot is explicitly constructed from the already-applied anchor
  // identity + wantOffset. Only scrollTop/rawScrollTop/isAtBottom come from
  // the final live container measurement. Never a crossing-first capture:
  // an expanded window may surface a shared/foreign row at the viewport top
  // while the requested anchor is correctly placed at its offset. Failure
  // (stale topic/route/epoch/mounted, or unmeasurable container) commits
  // nothing so the prior snapshot stands. Programmatic restore needs no
  // user input to become stable. Top-selector path only; the divider path
  // keeps its own capture commit untouched.
  const commitDisplayedStableWithAnchor = useCallback(
    (tid: string, route: string | null, epoch: number, anchorId: string, wantOffset: number | null): boolean => {
      if (unmountedRef.current) {
        return false
      }
      if (topicIdRef.current !== tid || routeRef.current !== route) {
        return false
      }
      if (!controller.isSessionCurrent(epoch)) {
        return false
      }
      const live = scrollContainerRef.current
      if (!live) {
        return false
      }
      let scrollTop = 0
      try {
        scrollTop = live.scrollTop
      } catch {
        return false
      }
      if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop)) {
        return false
      }
      let atBottom = false
      try {
        atBottom = isColumnReverseAtBottom(scrollTop, COLUMN_REVERSE_BOTTOM_THRESHOLD_PX)
      } catch {
        atBottom = false
      }
      const { commit } = controller.commitStable(epoch, {
        messageId: anchorId,
        intraRowOffset: wantOffset,
        scrollTop,
        isAtBottom: atBottom
      })
      if (!commit) {
        return false
      }
      let stored = false
      try {
        stored = commitSnapshotForRoute(commit.routeKey, {
          scrollTop,
          anchorId,
          messageId: anchorId,
          intraRowOffset: wantOffset,
          rawScrollTop: scrollTop,
          isAtBottom: atBottom
        })
      } catch {
        stored = false
      }
      transitionPlanRef.current = null
      endViewportScrollToken()
      notifyViewport()
      return stored
    },
    [controller, endViewportScrollToken, notifyViewport, scrollContainerRef]
  )
  // The top selector freezes through the controller (context request); this
  // instance only needs its live capturer registered (done above), so no
  // module-global saver registration exists anymore.
  // Pre-paint first-position + reveal: the single atomic step. Runs in the
  // layout phase so the target window's first paint already carries the
  // correct scroll. Post-reveal drift is held by the persistent stable
  // anchor keeper (scoped observers), not a stabilizer loop. Stale/missing
  // targets fail visible.
  useLayoutEffect(() => {
    // Reactive plan generation (bumped by every `commitRouteWindowAtomic`):
    // read so this pre-paint placement re-runs for each committed plan even
    // when the window object, visual attr, and controller primitives are
    // unchanged (retained same-window reactivation). Exactly-once is owned
    // by the recorded `outcome`, never by dep equality.
    void planSeq
    if (controller.currentPhase !== 'positioning') return
    const pending = transitionPlanRef.current
    if (!pending) {
      return
    }
    // Exactly-once per plan: an already-attempted plan never re-applies.
    if (pending.outcome !== null) {
      return
    }
    if (!controller.isSessionCurrent(pending.epoch)) return
    const live = scrollContainerRef.current
    const hasWindow = (viewportStateRef.current.window?.displayMessages.length ?? 0) > 0
    const current = isViewportTransitionCurrent({
      topicMatch: topicIdRef.current === pending.topicId,
      routeMatch: routeRef.current === pending.routeId,
      epochCurrent: controller.isSessionCurrent(pending.epoch),
      mounted: !unmountedRef.current
    })
    if (!current || !live || !hasWindow) {
      // Deterministic empty visible fallback (F1): an observed empty window
      // for the current target is a legitimate empty projection (empty topic /
      // deletion fallback tail), not a missing commit — fail visible exactly
      // once (releases, visible, no snapshot, ack settle false via
      // failVisible). Only a not-yet-observed window (null) stays hidden
      // awaiting the commit. No fake stable snapshot/anchor is invented.
      // Provenance-bound: only this transaction's actually committed target
      // window may take the empty fallback. A transient/bootstrap-old empty
      // (manual bootstrap arm with no atomic window commit) stays hidden
      // awaiting the hydrate/nav commit instead of killing it.
      const observedWindow = viewportStateRef.current.window
      const observedEmpty = observedWindow != null && (observedWindow.displayMessages?.length ?? 0) === 0
      // Missing window yet (commit not observed): stay hidden until the
      // window lands; only fail visible when this epoch is stale/gone.
      // Observed empty falls through to fail-visible below (never hidden)
      // ONLY when provenance-bound (see below).
      if (!hasWindow && current && live && !unmountedRef.current && !observedEmpty) return
      if (!hasWindow && current && live && !unmountedRef.current && observedEmpty) {
        const ack = planAckRef.current
        const ackArmed = !!ack && ack.epoch === pending.epoch
        if (!ackArmed) return
        try {
          const rendered = controller.renderedProvenance
          const ow = observedWindow as {
            oldestMessageId?: unknown
            newestMessageId?: unknown
            displayMessages?: unknown[]
          } | null
          const observedId =
            ow && Array.isArray(ow.displayMessages)
              ? `${String(ow.oldestMessageId ?? '')}::${String(ow.newestMessageId ?? '')}::${ow.displayMessages.length}`
              : null
          const renderedMatches =
            !!rendered &&
            !!observedId &&
            rendered.epoch === pending.epoch &&
            rendered.topicId === pending.topicId &&
            rendered.routeId === pending.routeId &&
            rendered.windowId === observedId
          if (!renderedMatches) return
        } catch {
          return
        }
      }
      failVisibleTransition(pending.epoch)
      return
    }
    // Shared attempt (records the explicit outcome on the plan + controller):
    // `searching` (edge-parked intermediate) keeps the restore in its
    // searching state — the projection below still reveals at the safe edge
    // so pagination can run, but no stable commit, intent clear, or ownership
    // release may follow until the requested identity is resident/aligned/
    // quiet (divider search coordinator owns that lifecycle). `refused`
    // (stale/wrong-phase) never touches the newer session: fail-visible is
    // epoch-gated and stays inert for it.
    let attempt: ViewportFirstPositionOutcome | 'refused'
    try {
      attempt = attemptFirstPosition(controller, pending, live)
    } catch {
      attempt = 'refused'
    }
    if (attempt === 'refused') {
      failVisibleTransition(pending.epoch)
      return
    }
    // Actual placement outcome/phase gates ack success (F2): unplaced or
    // terminal (including an activation attempt whose helper terminalized via
    // unplaced/exception) never acks true — fail visible preserving the prior
    // lawful snapshot (current-terminal own-target adoption iff valid rendered
    // nonempty via failVisible), settle false; stale stays inert via the epoch
    // gate. Only an actually placed/aligned or searching usable attempt may
    // ack success below. Phase is re-read (mutable controller truth may move
    // between the top guard and here; the cast defeats stale narrowing).
    if (attempt === 'unplaced' || (controller.currentPhase as string) === 'terminal') {
      failVisibleTransition(pending.epoch)
      return
    }
    if (
      topicIdRef.current !== pending.topicId ||
      routeRef.current !== pending.routeId ||
      !controller.isSessionCurrent(pending.epoch) ||
      unmountedRef.current
    ) {
      failVisibleTransition(pending.epoch)
      return
    }
    // Reveal tied to the same route/epoch: advance displayed only when the
    // target is positioned and visible. Ownership + scroll token stay held
    // until stable commit or terminal fallback (release exactly once there).
    //
    // Activation defers this reveal (F2): the retained window was placed
    // pre-paint while hidden, but effective alignment + projection coverage +
    // required layout settle are still unverified (folded anchor may need a
    // reveal, the projection commit may still be in flight, late layout may
    // move the anchor). The async activation continuation below verifies while
    // hidden (`positioning` via the activation aligned/searching mapping) and
    // calls `revealed()` only after the settle, immediately before the stable
    // commit. Ordinary transitions keep the immediate pre-paint reveal here.
    if (!controller.isActivationSession) {
      const revealedOk = controller.revealed(pending.epoch)
      if (!revealedOk) {
        // Epoch-gated: inert for a newer session, and adopts the committed
        // own-target render as displayed for a released-but-latest session
        // (e.g. an `unplaced` first placement) instead of leaving it dirty.
        failVisibleTransition(pending.epoch)
        return
      }
    }
    notifyViewport()
    // Placement ack: this plan's pre-paint attempt is now observed — wake any
    // awaiting async completion (same epoch only; stale no-op). Completions
    // re-gate currency before committing, so no false stable/reveal can land
    // before this positive placement. Terminal lost-race safety: a session
    // that terminalized between attempt and ack never acks true (re-read, see
    // above).
    if ((controller.currentPhase as string) === 'terminal') {
      failVisibleTransition(pending.epoch)
      return
    }
    settlePlanAck(pending.epoch, true)
    // Real-transaction trigger (retained same-window fix): the visual attr
    // (`positioning`) and the window object stay identical when a retained
    // window is recommitted (fetch-hold activation + positioning both map to
    // `positioning`, SAME window object), so neither can drive this pre-paint
    // placement. Depend on the primitive current phase/epoch instead: a
    // fetch-hold → positioning move or a new plan epoch reruns exactly once
    // via the current-plan gate above (stale epochs return inert, placed
    // sessions leave `positioning` so repeats are no-ops).
  }, [
    controller,
    controller.currentPhase,
    controller.currentEpoch,
    planSeq,
    viewportPhaseAttr,
    viewportState.window,
    failVisibleTransition,
    scrollContainerRef,
    notifyViewport,
    settlePlanAck
  ])
  // Layout lifetime (MUST stay layout + declared before the pre-paint
  // continuation below): the layout continuation consumes this marker, so the
  // reconnect setup must commit in the same layout phase before resumed
  // measurement. A passive marker stays stale-true through the show's layout
  // phase and the pre-paint fast path declines. Same cleanup meaning and same
  // resources as before; single controller owner stays the provider.
  useLayoutEffect(() => {
    // Symmetric connection: Activity hidden disconnects this effect (cleanup
    // below) while preserving state/refs/DOM; Activity visible reconnects by
    // re-running this setup plus the single TOP pipeline below. Single
    // controller owner: the provider `detach()` cancels the short-lived
    // transaction (epoch advance + exactly-once release, reactivation armed);
    // this instance clears only its UI-local transients here so parent/child
    // setup can never double-invalidate or ping-pong epochs. Old async
    // continuations stay inert via the detach epoch advance (fresh transaction
    // identity, not just this flag) plus the prompt same-lifetime flag below.
    // Isolated mounts without a provider own their fallback controller and
    // detach it directly. Stable deps only (no connection-generation dep) so
    // provider gen bumps re-render without re-running this teardown.
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      pendingOlderIntentRef.current = null
      // UI-local teardown only (single controller owner is the provider):
      // clear the in-flight fetch marker so the reconnected session adopts a
      // fresh epoch, cancel quiet frames, drop divider/visible progress + the
      // pre-paint plan, and end the scroll token (never leaves hidden, never
      // leaks ownership). Stale `finally` blocks skip on epoch mismatch. HMR
      // disposes via the provider effect as well; both paths are idempotent.
      try {
        if (!viewportCtxRef.current) controller.detach()
      } catch {}
      routeFetchEpochRef.current = null
      cancelAllVisibleQuiet()
      dividerProgressRef.current = null
      dividerVisibleRef.current = null
      topVisibleRef.current = null
      topHiddenFallbackRef.current = null
      transitionPlanRef.current = null
      // No placement can follow unmount: settle the ack unobserved so any
      // awaiting completion wakes and re-gates (stale no-op, never hangs).
      settlePlanAck(controller.currentEpoch, false)
      endViewportScrollToken()
      notifyViewport()
    }
  }, [cancelAllVisibleQuiet, controller, endViewportScrollToken, notifyViewport, settlePlanAck])

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
      // Hard deletion invalidates in-flight positioning too: invalidate the
      // controller (releases ownership exactly once so later saves are not
      // blocked) and end the scroll token so the emptied viewport is never
      // left hidden by a stale transition.
      const epochBeforeInvalidate = controller.currentEpoch
      controller.invalidateAll()
      // The invalidated plan can never place: settle its ack unobserved so
      // any awaiting completion wakes and re-gates (epoch-exact, never
      // disturbs a newer session).
      settlePlanAck(epochBeforeInvalidate, false)
      cancelAllVisibleQuiet()
      dividerProgressRef.current = null
      dividerVisibleRef.current = null
      topVisibleRef.current = null
      topHiddenFallbackRef.current = null
      transitionPlanRef.current = null
      endViewportScrollToken()
      notifyViewport()
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
  }, [tearDownViewportTransition, topic.id, clearTimeoutTimer, viewportDispatch, settlePlanAck])

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
      // A topic change invalidates any armed positioning transition: tear it
      // down (release exactly once) and fail visible so the new topic never
      // starts hidden. The bootstrap effect below arms a fresh transition.
      tearDownViewportTransition()
      notifyViewport()
    },
    clearTimers: () => {
      pendingOlderIntentRef.current = null
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

  // Ordinary projection apply (bootstrap first-load / reconcile): NOT a route
  // transition — never switches provenance. Same-route window refreshes bump
  // the controller window generation (`noteSameRouteWindowUpdate`) and notify
  // the component-scoped maintainer in the layout phase so it re-resolves the
  // container-scoped live anchor and holds on the committed DOM. A dirty
  // topic-switch (rendered unknown after `syncDisplayed`) rebaselines clean
  // with the applied window as proof (`rebaseClean`) when nothing owns the
  // viewport (owned bootstrap commits instead). Navigation / edit-mode window
  // changes never enter the route-transition entry. Route-transition windows
  // still position programmatically — never keeper preemption.
  const applyMessageWindow = useCallback(
    (window: MessageWindow) => {
      viewportDispatch({ type: 'window/apply', window })
      try {
        const len = Array.isArray(window.displayMessages) ? window.displayMessages.length : 0
        const wid = `${String((window as { oldestMessageId?: unknown }).oldestMessageId ?? '')}::${String((window as { newestMessageId?: unknown }).newestMessageId ?? '')}::${len}`
        if (wid.length === 0) return
        const target = { topicId: topicIdRef.current, route: routeRef.current }
        // Same-route refresh (reconcile/pagination): generation event only.
        // Notify so the keeper layout effect re-runs after the DOM commit and
        // reads the new committed rows (ordering: projection dispatch above +
        // this version bump batch into the same commit).
        if (controller.noteSameRouteWindowUpdate(target, wid)) {
          notifyViewport()
          return
        }
        // Dirty bootstrap (topic switch, no owner): rebase clean with proof.
        if (!controller.programmaticOwned) {
          controller.rebaseClean(target, wid)
          notifyViewport()
        }
      } catch {
        // fail-closed: projection already applied above
      }
    },
    [controller, notifyViewport, viewportDispatch]
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

  // Route-local stable snapshots update from any stable viewport — user
  // scrolls via `handleScroll`, same-route imperative navigation via
  // `navigateAndSave` below, and programmatic restores via the explicit
  // stable commit on completion. No input-gated fence: a successful
  // programmatic restore is itself a valid stable viewport.

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
        // Same-route user navigation: the resulting viewport is stable, so
        // persist it under the current (displayed) route key.
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
      // Forks one internal branch node at an anchor message owned by the
      // ACTIVE route (BRANCH-7 owner-only; inherited references reject
      // fail-closed with zero writes) with no prefix cloning and no sync
      // intent. New branches default to the localized New Branch name;
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
                // New-branch landing (route switch, no fetch-hold session):
                // provenance-bound rebase with window proof — never a bare
                // dispatch bypassing rendered. No snapshot write: the fresh
                // route keeps its deterministic bottom default until genuine
                // user scrolling establishes one.
                const disp = latestWindow.displayMessages ?? []
                const wid =
                  `${String((latestWindow as { oldestMessageId?: unknown }).oldestMessageId ?? '')}::${String((latestWindow as { newestMessageId?: unknown }).newestMessageId ?? '')}::${disp.length}` ||
                  `newbranch-${topicIdAtCreate}`
                viewportDispatch({ type: 'window/apply', window: latestWindow })
                try {
                  if (!controller.programmaticOwned) {
                    controller.rebaseClean({ topicId: topicIdAtCreate, route: newRoute }, wid)
                    notifyViewport()
                  }
                } catch {
                  // fail-closed: projection already applied above
                }
              }
            } catch {
              // fail-closed: loaded projection already rebased; viewport keeps prior window
            }
            // Explicit latest/bottom positioning with local write suppression
            // so the bottom snap is never recorded as a user scroll.
            suppressUserWriteRef.current = true
            try {
              await navigate({ kind: 'bottom', source: 'imperative' })
            } finally {
              suppressUserWriteRef.current = false
            }
            // The creation selects the new route outside any fetch-hold session
            // (existing new-branch-landing semantics preserved): the rebase
            // above already proved rendered == displayed == new route, so
            // later freezes/keeper writes use the new route's key — never the
            // stale outgoing key. No snapshot write: the fresh route keeps
            // its deterministic bottom default until genuine user scrolling
            // establishes one.
            if (topicIdRef.current === topicIdAtCreate && routeRef.current === newRoute) {
              notifyViewport()
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
      // Atomic bootstrap: hide the target window until the pre-paint layout
      // reveal applies the first scroll. The transaction owns its own scroll
      // token; this arm only holds hook ownership + the hidden phase. Route-
      // local plan only: a missing pending target reveals at the deterministic
      // default (bottom) — never outgoing geometry.
      const pendingTarget = decision.intent.kind === 'message' ? decision.intent.targetId : null
      const bootstrapRestoreEpoch = armBootstrapTransition(
        pendingTarget
          ? { kind: 'message', messageId: pendingTarget, wantOffset: null, fallbackScrollTop: null }
          : { kind: 'bottom' },
        topic.id,
        routeRef.current
      )
      void navigate(decision.intent).then((result) => {
        if (controller.currentEpoch !== bootstrapRestoreEpoch) return
        if (transitionEpochRef.current !== bootstrapEpoch) {
          failVisibleTransition(bootstrapRestoreEpoch)
          return
        }
        // Placement evidence (never trust the 'success' string alone): only
        // the current transaction's actually placed target may commit. The
        // shared helper records outcome + phase together (exactly-once with
        // the pre-paint layout attempt); unplaced/refused/terminal fails
        // visible preserving the prior lawful snapshot.
        const pendingTransition = transitionPlanRef.current
        if (pendingTransition?.epoch === bootstrapRestoreEpoch) {
          try {
            const live = scrollContainerRef.current
            if (
              !live ||
              unmountedRef.current ||
              topicIdRef.current !== topic.id ||
              routeRef.current !== pendingTransition.routeId ||
              !controller.isSessionCurrent(bootstrapRestoreEpoch)
            ) {
              failVisibleTransition(bootstrapRestoreEpoch)
              bootstrapPhaseRef.current = 'done'
              return
            }
            let attempt: ViewportFirstPositionOutcome | 'refused'
            try {
              attempt = attemptFirstPosition(controller, pendingTransition, live)
            } catch {
              attempt = 'refused'
            }
            if (attempt === 'refused') {
              failVisibleTransition(bootstrapRestoreEpoch)
              bootstrapPhaseRef.current = 'done'
              return
            }
            if (attempt === 'unplaced' || (controller.currentPhase as string) === 'terminal') {
              failVisibleTransition(bootstrapRestoreEpoch)
              bootstrapPhaseRef.current = 'done'
              return
            }
          } catch {
            failVisibleTransition(bootstrapRestoreEpoch)
            bootstrapPhaseRef.current = 'done'
            return
          }
        } else if ((controller.currentPhase as string) !== 'aligned') {
          const phaseNow = controller.currentPhase as string
          if (phaseNow !== 'aligned' && phaseNow !== 'searching') {
            if (!controller.isSessionCurrent(bootstrapRestoreEpoch)) return
            failVisibleTransition(bootstrapRestoreEpoch)
            bootstrapPhaseRef.current = 'done'
            return
          }
        }
        if (result !== 'cancelled') {
          // Positive placement required: the attempt above (or the pre-paint
          // layout attempt it deduplicates) left aligned/searching. A success
          // string with an unplaced target never forces placed. Final empty
          // windows never commit (fail-visible preserves the lawful snapshot).
          const phaseNow = controller.currentPhase as string
          if (phaseNow !== 'aligned' && phaseNow !== 'searching') {
            failVisibleTransition(bootstrapRestoreEpoch)
            bootstrapPhaseRef.current = 'done'
            return
          }
          if ((viewportStateRef.current.window?.displayMessages.length ?? 0) === 0) {
            failVisibleTransition(bootstrapRestoreEpoch)
            bootstrapPhaseRef.current = 'done'
            return
          }
          if (
            topicIdRef.current !== topic.id ||
            !controller.isSessionCurrent(bootstrapRestoreEpoch) ||
            unmountedRef.current
          ) {
            failVisibleTransition(bootstrapRestoreEpoch)
            bootstrapPhaseRef.current = 'done'
            return
          }
          clearPendingNavigate(pending)
          bootstrapPhaseRef.current = 'done'
          controller.revealed(bootstrapRestoreEpoch)
          notifyViewport()
          // Stable completion commit: the final visible viewport is the
          // route's stable snapshot (no user input required). Gated by the
          // same epoch; advances displayed provenance.
          commitDisplayedStable(topic.id, routeRef.current, bootstrapRestoreEpoch)
        } else {
          bootstrapPhaseRef.current = 'done'
          // Cancelled transactions position nothing: terminate visibly
          // without committing (release exactly once).
          failVisibleTransition(bootstrapRestoreEpoch)
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
    // Atomic bootstrap restore: same hidden-until-positioned contract as route
    // switches. The saved intra-row offset rides in the plan so the pre-paint
    // reveal lands precisely; the transaction scroll afterwards converges.
    // Same-route fallback only: the target's own saved scrollTop, never
    // outgoing geometry. No snapshot → deterministic default below.
    const savedForPlan = (() => {
      try {
        return getSavedPosition()
      } catch {
        return null
      }
    })()
    const restorePlan: ViewportFirstPositionPlan =
      decision.intent.kind === 'bottom'
        ? { kind: 'bottom' }
        : decision.intent.kind === 'message'
          ? {
              kind: 'message',
              messageId: decision.intent.targetId,
              wantOffset:
                typeof savedForPlan?.intraRowOffset === 'number' && Number.isFinite(savedForPlan.intraRowOffset)
                  ? savedForPlan.intraRowOffset
                  : null,
              fallbackScrollTop:
                savedForPlan && typeof savedForPlan.scrollTop === 'number' ? savedForPlan.scrollTop : null
            }
          : decision.intent.kind === 'scrollTop'
            ? { kind: 'scrollTop', scrollTop: decision.intent.scrollTop }
            : { kind: 'bottom' }
    const bootstrapRestoreEpoch = armBootstrapTransition(restorePlan, topic.id, routeRef.current)
    void navigate(decision.intent).then((result) => {
      if (controller.currentEpoch !== bootstrapRestoreEpoch) return
      if (transitionEpochRef.current !== restoreEpoch) {
        failVisibleTransition(bootstrapRestoreEpoch)
        return
      }
      // Same placement-evidence contract as the pending path above: never
      // trust the result string alone; unplaced/refused/terminal fails
      // visible preserving the prior lawful snapshot.
      const pendingTransition = transitionPlanRef.current
      if (pendingTransition?.epoch === bootstrapRestoreEpoch) {
        try {
          const live = scrollContainerRef.current
          if (
            !live ||
            unmountedRef.current ||
            topicIdRef.current !== topic.id ||
            routeRef.current !== pendingTransition.routeId ||
            !controller.isSessionCurrent(bootstrapRestoreEpoch)
          ) {
            failVisibleTransition(bootstrapRestoreEpoch)
            return
          }
          let attempt: ViewportFirstPositionOutcome | 'refused'
          try {
            attempt = attemptFirstPosition(controller, pendingTransition, live)
          } catch {
            attempt = 'refused'
          }
          if (attempt === 'refused') {
            failVisibleTransition(bootstrapRestoreEpoch)
            return
          }
          if (attempt === 'unplaced' || (controller.currentPhase as string) === 'terminal') {
            failVisibleTransition(bootstrapRestoreEpoch)
            return
          }
        } catch {
          failVisibleTransition(bootstrapRestoreEpoch)
          return
        }
      } else if ((controller.currentPhase as string) !== 'aligned') {
        const phaseNow = controller.currentPhase as string
        if (phaseNow !== 'aligned' && phaseNow !== 'searching') {
          if (!controller.isSessionCurrent(bootstrapRestoreEpoch)) return
          failVisibleTransition(bootstrapRestoreEpoch)
          return
        }
      }
      // Stable completion commit (same epoch gate already checked above):
      // the final visible viewport is the route's stable snapshot even with
      // no user input. Positive placement (aligned/searching) plus a
      // non-empty committed window is required; a non-persisted result or an
      // unplaced/empty target terminates visibly without committing.
      // Advances displayed provenance.
      if (shouldPersistNavigationResult(result)) {
        const phaseNow = controller.currentPhase as string
        if (phaseNow !== 'aligned' && phaseNow !== 'searching') {
          failVisibleTransition(bootstrapRestoreEpoch)
          return
        }
        if ((viewportStateRef.current.window?.displayMessages.length ?? 0) === 0) {
          failVisibleTransition(bootstrapRestoreEpoch)
          return
        }
        if (
          topicIdRef.current !== topic.id ||
          !controller.isSessionCurrent(bootstrapRestoreEpoch) ||
          unmountedRef.current
        ) {
          failVisibleTransition(bootstrapRestoreEpoch)
          return
        }
        controller.revealed(bootstrapRestoreEpoch)
        notifyViewport()
        commitDisplayedStable(topic.id, routeRef.current, bootstrapRestoreEpoch)
      } else {
        failVisibleTransition(bootstrapRestoreEpoch)
      }
    })
  }, [
    armBootstrapTransition,
    commitDisplayedStable,
    failVisibleTransition,
    isTopicLoading,
    messages,
    navigate,
    topic.id,
    getSavedPosition,
    scrollContainerRef
  ])

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

      // A failed restore-owned page terminates the divider search
      // (fail-visible release, no commit) instead of retry-looping: the
      // watcher re-steps on the load/cancel commit and observes the flag.
      const markRestoreLoadFailed = (): void => {
        const owning = dividerProgressRef.current
        if (
          owning &&
          owning.topicId === topicIdAtStart &&
          owning.routeId === routeAtStart &&
          controller.isSessionCurrent(owning.ownerEpoch)
        ) {
          owning.lastLoadFailed = true
        }
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
              markRestoreLoadFailed()
              viewportDispatch({ type: 'load/cancel', direction: 'older', token: loadToken, topicGeneration })
              return
            }
            if (response.window.topicId !== topicIdAtStart || response.window.kind !== 'around') {
              logger.error('[loadMoreMessages] window topic/kind mismatch, fail-closed')
              markRestoreLoadFailed()
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
                    const el = getMessageRowById(preferredSnapshot.messageId)
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
                if (decision.kind === 'none') {
                  return
                }
                const usedPreferred = decision.kind === 'preferred'
                const delta = decision.delta
                // Restore-owned pagination (divider search active for this
                // load's topic/route/session): the search owns the scroll
                // token and the align step owns completion. Apply the
                // preferred compensation directly and return — never begin a
                // competing token. The search watcher re-steps when this
                // window commits. Post-reveal drift is held by the persistent
                // stable-anchor keeper, not a stabilizer loop.
                const owningSearch = dividerProgressRef.current
                if (
                  owningSearch &&
                  owningSearch.topicId === topicIdAtStart &&
                  owningSearch.routeId === routeAtStart &&
                  controller.isSessionCurrent(owningSearch.ownerEpoch)
                ) {
                  try {
                    live.scrollTop += delta
                  } catch {
                    return
                  }
                  return
                }
                // A route transition in flight owns compensation: never start
                // a competing token over it — single direct delta, then leave
                // the token to its owner.
                if (controller.programmaticOwned) {
                  try {
                    live.scrollTop += delta
                  } catch {
                    return
                  }
                  return
                }
                const scrollToken = {}
                if (!(await beginScroll('anchoring', scrollToken))) return
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
                // Single compensation only: the persistent keeper holds the
                // anchor across subsequent layout settling. No bounded rAF
                // stabilizer, no second session.
                viewportDispatch({ type: 'scroll/end', token: scrollToken })
              })
            }
          } catch (err) {
            logger.error('[loadMoreMessages] window fetch failed, fail-closed', err as Error)
            if (isCurrentLoad('older', loadToken, topicGeneration)) {
              markRestoreLoadFailed()
              viewportDispatch({ type: 'load/cancel', direction: 'older', token: loadToken, topicGeneration })
            }
          }
        },
        50
      )
    },
    [
      beginScroll,
      controller,
      dispatch,
      isCurrentLoad,
      notifyViewport,
      setTimeoutTimer,
      scrollContainerRef,
      topic.id,
      viewportDispatch
    ]
  )

  // InfiniteScroll `next` entry (older edge): temporary scroll ownership or
  // active navigation must queue a generation-bound intent instead of dropping
  // it, otherwise the internal latch never releases and later scrolls retry
  // Preferred restore anchor snapshot for queued/driven pagination: the
  // controller's active visual anchor as a detached snapshot (stable identity
  // + targetOffset, never a live ref). Null unless the anchor belongs to the
  // live topic/route/session, so ordinary user pagination snapshots null and
  // behaves exactly as before.
  const snapshotPreferredAnchor = useCallback((): PreferredRestoreAnchorSnapshot | null => {
    const intent = controller.currentIntent
    if (!intent || intent.topicId !== topic.id || intent.targetRoute !== routeRef.current) return null
    if (!controller.isSessionCurrent(controller.currentEpoch)) return null
    // Provenance-guarded: the anchor is observable only when it was produced
    // for this exact topic+route. A foreign live anchor never snapshots.
    const anchor = controller.getAnchorFor({ topicId: topic.id, route: routeRef.current })
    if (!anchor) return null
    if (anchor.kind === 'divider') {
      return { kind: 'divider-row', dividerKey: anchor.dividerKey, targetOffset: anchor.offset }
    }
    return { kind: 'message-row', messageId: anchor.messageId, targetOffset: anchor.offset }
  }, [controller, topic.id])
  // nothing.
  const loadMoreMessages = useCallback(() => {
    const currentState = viewportStateRef.current
    // Restore-owned search guard: while a divider restore search is active for
    // the current topic/route/epoch, the normal/manual pagination path must
    // never race or steal ownership. Route through the restore-owned protocol
    // with the preserved preferred anchor (explicit drive when user-idle,
    // queued intent otherwise) — never a plain anchor-less start.
    const liveSearch = dividerProgressRef.current
    if (
      liveSearch &&
      liveSearch.topicId === topic.id &&
      liveSearch.routeId === routeRef.current &&
      liveSearch.ownerEpoch === controller.currentEpoch
    ) {
      const restorePreferred = snapshotPreferredAnchor()
      if (!currentState.window?.hasMoreOlder || currentState.loading.older) return
      if (!canHandleUserViewportScroll(currentState)) {
        if (shouldQueueOlderIntent(currentState)) {
          pendingOlderIntentRef.current = createPendingOlderIntent({
            topicId: topic.id,
            routeId: routeRef.current,
            topicGeneration: currentState.topicGeneration,
            deletionGeneration: captureDeletionGeneration(topic.id),
            residentGeneration: captureResidentGeneration(() => store.getState(), topic.id),
            preferredAnchor: restorePreferred
          })
        }
        return
      }
      pendingOlderIntentRef.current = null
      startOlderWindowLoad(restorePreferred)
      return
    }
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
        const preferredSnapshot = snapshotPreferredAnchor()
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

  // Capture-phase declaration (interaction token/session): genuine user
  // input opens/refreshes the controller-owned session and stops persistent
  // programmatic compensation until `scrollend` closes it. Never
  // terminates/releases the transition; multi-scroll gestures stay in one
  // session (each scroll updates the stable snapshot).
  const cancelActiveStabilizerForUser = useCallback(() => {
    try {
      controller.declareUserIntent()
    } catch {}
    notifyViewport()
  }, [controller, notifyViewport])

  // Wheel/touch/pointer input declares intent even before the scroll event
  // fires. Programmatic compensation never emits these, so no self-cancel
  // risk. Scrollbar drag fires pointerDown first, so it is already covered.
  // The scroll itself is recorded via `handleScroll` below; no input-gated
  // fence exists — user input never authorizes persistence by itself, the
  // resulting stable viewport does.
  const handleStabilizerUserInput = useCallback(() => {
    cancelActiveStabilizerForUser()
  }, [cancelActiveStabilizerForUser])

  // Keyboard scroll pre-cancel: ArrowUp/Down, PageUp/Down, Home/End, Space.
  // Input targets (input/textarea/select/contentEditable) and modified keys
  // never declare intent so editing and shortcuts keep compensation alive.
  const handleStabilizerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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

  // Single atomic user-scroll path (controller-owned `userTakeover` with a
  // live interaction token). Capture (wheel/touch/pointer/key/scrollbar)
  // opens/refreshes the session first; ONLY scrolls inside that live session
  // may measure + `userTakeover()` + persist (multi-scroll gestures update
  // the snapshot on every scroll; `scrollend` closes the session). Scrolls
  // with NO live session are programmatic / window-reconcile layout effects:
  // they never take over, never commit, never change the stable anchor —
  // the persistent keeper compensates the active anchor instead. Only the
  // returned `{taken:true, routeKey, snapshot}` authorizes a
  // `commitSnapshotForRoute(routeKey, snapshot)` user-source write (never the
  // selected `topic-${id}::${activeBranchId}` key: fetch-hold outgoing
  // takeovers write the outgoing route; selected Redux intent is untouched).
  // Pagination detection below only reads scroll geometry (never authorizes
  // a snapshot) and the hook throttled writer is never called here.
  const handleScroll = useCallback(() => {
    if (!suppressUserWriteRef.current) {
      const liveToken = controller.activeInteractionToken
      if (liveToken !== null) {
        const container = scrollContainerRef.current
        const measured = captureSnapshot()
        if (container && measured) {
          let liveWindowId: string | undefined
          try {
            const w = viewportStateRef.current.window
            if (w && Array.isArray((w as { displayMessages?: unknown }).displayMessages)) {
              const ww = w as { oldestMessageId?: unknown; newestMessageId?: unknown; displayMessages: unknown[] }
              liveWindowId = `${String(ww.oldestMessageId ?? '')}::${String(ww.newestMessageId ?? '')}::${ww.displayMessages.length}`
            }
          } catch {
            liveWindowId = undefined
          }
          const out = controller.userTakeover(
            {
              messageId: measured.messageId ?? null,
              intraRowOffset: measured.intraRowOffset ?? null,
              scrollTop: measured.scrollTop,
              isAtBottom: measured.isAtBottom
            },
            liveWindowId,
            liveToken
          )
          if (out.taken) {
            try {
              commitSnapshotForRoute(out.routeKey, {
                scrollTop: out.snapshot.scrollTop,
                anchorId: out.snapshot.messageId,
                messageId: out.snapshot.messageId,
                intraRowOffset: out.snapshot.intraRowOffset,
                rawScrollTop: out.snapshot.scrollTop,
                isAtBottom: out.snapshot.isAtBottom
              })
            } catch {
              // fail-closed: controller state already advanced above
            }
            // Takeover invalidated the old epoch: stale async continuations
            // are inert via epoch mismatch/session check. Clear only the old
            // session's plan/search/token, never a newer owner's. The user
            // interaction session itself stays live for momentum/drag scrolls
            // until `scrollend` (keeper) or the next programmatic request.
            if (out.reason === 'owned-takeover') {
              transitionPlanRef.current = null
              dividerProgressRef.current = null
              // Owned takeover ends the visible quiet session with it: cancel
              // its bounded frames and drop only the taken-over pending driver.
              // The controller already released ownership exactly once above;
              // the anchoring token ends here exactly once. A newer owned
              // session (if ever armed) is never touched.
              try {
                const h = dividerVisibleRafRef.current
                dividerVisibleRafRef.current = null
                if (h !== null) cancelAnimationFrame(h)
              } catch {}
              try {
                const pv = dividerVisibleRef.current
                if (pv && !(pv.ownerEpoch === controller.currentEpoch && controller.programmaticOwned)) {
                  dividerVisibleRef.current = null
                }
              } catch {
                // fail-closed
              }
              endViewportScrollToken()
            }
            notifyViewport()
          }
        }
      } else {
        // No live session: never measure for takeover, never commit, never
        // change the anchor — visual compensation only via the same keeper
        // hold (no snapshot write is reopened here).
        try {
          anchorMaintainerRef.current.requestHold('messages-scroll')
        } catch {}
      }
      // No live session otherwise: programmatic scrolls (first position,
      // pagination / divider-align compensation, same-route window refresh
      // layout effects) must never pose as user.
    }

    const container = scrollContainerRef.current
    if (container && hasMoreNewer && !isLoadingNewer && !isLoadingMore) {
      // Column-reverse: bottom (newest) is scrollTop ≈ 0, so the newer-edge
      // prefetch uses the single geometry primitive (never the oldest formula).
      if (distanceFromBottom(container.scrollTop) < COLUMN_REVERSE_NEWER_PREFETCH_PX) {
        loadNewerMessages()
      }
    }
  }, [
    captureSnapshot,
    controller,
    endViewportScrollToken,
    hasMoreNewer,
    isLoadingNewer,
    isLoadingMore,
    loadNewerMessages,
    notifyViewport,
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

  // Divider restore search driver (binding invariant, single owner).
  // Exactly one action per invocation, decided purely from the committed
  // window + anchor residency + epoch liveness — never from a scroll event:
  // - resident → async align to the captured offset, quiet, then the ONE
  //   stable commit (the only commit path for divider restores);
  // - absent + older pages remain + loader idle → explicitly start one
  //   restore-owned page carrying the preserved preferred anchor;
  // - absent + loader busy → wait (no-op);
  // - oldest edge / load failure / page cap / supersession → terminal
  //   fail-visible release exactly once with NO stable commit (the
  //   pre-existing target snapshot stands; a false edge commit would poison
  //   future restores).
  // The restore identity + captured offset survive every older-window
  // expansion; expansion compensation uses the preferred anchor while
  // current. Rapid route/topic/deletion supersession bumps the epoch, which
  // invalidates stale steps and stale align completions.
  const searchAligningRef = useRef<number | null>(null)
  const windowIdentityKey = useCallback(
    (
      window: { oldestMessageId?: unknown; newestMessageId?: unknown; displayMessages?: unknown[] } | null | undefined
    ): string | null => {
      if (!window || !Array.isArray(window.displayMessages)) return null
      return `${String(window.oldestMessageId ?? '')}::${String(window.newestMessageId ?? '')}::${window.displayMessages.length}`
    },
    []
  )
  // Single route-window entry (provenance-bound atomic commit).
  // Records session epoch + target route + window identity as rendered,
  // dispatches the window, and stores the first-position plan in the SAME
  // sync call. Stale/superseded fetch completions (epoch mismatch, intent
  // mismatch, or phase beyond fetch-hold) refuse with NO dispatch and NEVER
  // tear down the new session — old `finally` blocks can never mark/reveal/
  // commit the new session. Ordinary pagination/reconcile never enters here:
  // same-route window refreshes use `controller.noteSameRouteWindowUpdate`
  // (windowId only, no provenance switch); message navigation / edit mode
  // uses its own transaction tokens, never a route transition.
  const commitRouteWindowAtomic = useCallback(
    (
      fetchEpoch: number,
      topicIdAtStart: string,
      routeAtStart: string | null,
      window: MessageWindow,
      plan: ViewportFirstPositionPlan,
      onPublish?: () => void
    ): number | null => {
      if (!controller.isSessionCurrent(fetchEpoch)) {
        return null
      }
      const intent = controller.currentIntent
      if (!intent || intent.topicId !== topicIdAtStart || intent.targetRoute !== routeAtStart) {
        return null
      }
      if (controller.currentPhase !== 'fetch-hold') {
        return null
      }
      const wid = windowIdentityKey(window) ?? `epoch-${fetchEpoch}`
      const ok = controller.applyTransitionWindow(fetchEpoch, { topicId: topicIdAtStart, route: routeAtStart }, wid)
      if (!ok) {
        return null
      }
      if (onPublish) {
        if (topicIdRef.current !== topicIdAtStart || routeRef.current !== routeAtStart) {
          return null
        }
        if (!controller.isSessionCurrent(fetchEpoch)) {
          return null
        }
        onPublish()
      }
      viewportDispatch({ type: 'window/apply', window })
      transitionPlanRef.current = {
        topicId: topicIdAtStart,
        routeId: routeAtStart,
        epoch: fetchEpoch,
        plan,
        outcome: null
      }
      // Observable plan delivery: supersede any previous ack, arm this
      // epoch's placement ack, and bump the reactive plan generation so the
      // pre-paint layout effect attempts this plan exactly once even when the
      // window object, visual attr, and controller primitives are unchanged
      // (retained same-window reactivation).
      settlePlanAck(null, false)
      let ackResolve: (observed: boolean) => void = () => undefined
      const ackPromise = new Promise<boolean>((resolve) => {
        ackResolve = resolve
      })
      planAckRef.current = { epoch: fetchEpoch, resolve: ackResolve, promise: ackPromise }
      planSeqRef.current += 1
      setPlanSeq(planSeqRef.current)
      const scrollToken = {}
      viewportDispatch({ type: 'scroll/begin', mode: 'anchoring', token: scrollToken })
      notifyViewport()
      return fetchEpoch
    },
    [controller, notifyViewport, settlePlanAck, viewportDispatch, windowIdentityKey]
  )
  // Divider-only visible incremental rebase entry (fast path, never hidden).
  // Synchronously rebases the existing rendered list (shared prefix stays
  // mounted by stable ID), records session epoch + target route + window
  // identity as rendered via `applyVisibleRebaseWindow` (fetch-hold → aligned
  // directly, no positioning/visibility:hidden), and arms the synchronous
  // first compensation + bounded quiet sequence below. Ownership + anchoring
  // token stay held until the quiet sequence commits or deliberately falls
  // back/terminates. Stale epochs refuse with no dispatch and never disturb
  // the new session. Any eligibility/residency doubt must take the hidden
  // searching path instead — never this entry. No stable commit happens here.
  const commitDividerVisibleAtomic = useCallback(
    (
      fetchEpoch: number,
      topicIdAtStart: string,
      routeAtStart: string | null,
      window: MessageWindow,
      visible: {
        dividerKey: string
        anchorMessageId: string
        parentOfDivider: string | null
        sharedMessageId: string | null
        sharedOffset: number | null
        wantOffset: number
      },
      onPublish?: () => void
    ): number | null => {
      if (!controller.isSessionCurrent(fetchEpoch)) return null
      const intent = controller.currentIntent
      if (!intent || intent.kind !== 'divider') return null
      if (intent.topicId !== topicIdAtStart || intent.targetRoute !== routeAtStart) return null
      if (controller.currentPhase !== 'fetch-hold') return null
      if ((window.displayMessages?.length ?? 0) === 0) return null
      const wid = windowIdentityKey(window) ?? `epoch-${fetchEpoch}`
      const ok = controller.applyVisibleRebaseWindow(fetchEpoch, { topicId: topicIdAtStart, route: routeAtStart }, wid)
      if (!ok) return null
      if (onPublish) {
        if (topicIdRef.current !== topicIdAtStart || routeRef.current !== routeAtStart) {
          return null
        }
        if (!controller.isSessionCurrent(fetchEpoch)) {
          return null
        }
        onPublish()
      }
      cancelDividerVisibleQuiet()
      viewportDispatch({ type: 'window/apply', window })
      dividerVisibleRef.current = {
        ownerEpoch: fetchEpoch,
        topicId: topicIdAtStart,
        routeId: routeAtStart,
        dividerKey: visible.dividerKey,
        anchorMessageId: visible.anchorMessageId,
        parentOfDivider: visible.parentOfDivider,
        sharedMessageId: visible.sharedMessageId,
        sharedOffset: visible.sharedOffset,
        wantOffset: visible.wantOffset,
        windowId: wid,
        quietArmed: false
      }
      const scrollToken = {}
      viewportDispatch({ type: 'scroll/begin', mode: 'anchoring', token: scrollToken })
      notifyViewport()
      return fetchEpoch
    },
    [cancelDividerVisibleQuiet, controller, notifyViewport, viewportDispatch, windowIdentityKey]
  )
  // Top-only visible incremental rebase entry (fast path, never hidden).
  // Synchronously rebases the existing rendered list (shared prefix through
  // the saved anchor stays mounted by stable ID), records session epoch +
  // target route + window identity as rendered via `applyVisibleRebaseWindow`
  // (fetch-hold → aligned directly, no positioning/visibility:hidden), and
  // arms the synchronous first compensation + bounded quiet sequence below.
  // The target route's own saved offset is used independently (never the
  // divider click offset). Ownership + anchoring token stay held until the
  // quiet sequence identity-commits or deliberately terminates. Stale epochs
  // refuse with no dispatch and never disturb the new session. Any
  // eligibility/residency doubt must take the existing hidden atomic path
  // instead — never this entry, never divider search. No stable commit here.
  const commitTopVisibleAtomic = useCallback(
    (
      fetchEpoch: number,
      topicIdAtStart: string,
      routeAtStart: string | null,
      window: MessageWindow,
      visible: { anchorMessageId: string; wantOffset: number }
    ): number | null => {
      if (!controller.isSessionCurrent(fetchEpoch)) return null
      const intent = controller.currentIntent
      if (!intent || intent.kind !== 'top') return null
      if (intent.topicId !== topicIdAtStart || intent.targetRoute !== routeAtStart) return null
      if (controller.currentPhase !== 'fetch-hold') return null
      if ((window.displayMessages?.length ?? 0) === 0) return null
      if (typeof visible.anchorMessageId !== 'string' || visible.anchorMessageId.length === 0) return null
      if (typeof visible.wantOffset !== 'number' || !Number.isFinite(visible.wantOffset)) return null
      const wid = windowIdentityKey(window) ?? `epoch-${fetchEpoch}`
      const ok = controller.applyVisibleRebaseWindow(fetchEpoch, { topicId: topicIdAtStart, route: routeAtStart }, wid)
      if (!ok) return null
      cancelTopVisibleQuiet()
      viewportDispatch({ type: 'window/apply', window })
      topVisibleRef.current = {
        ownerEpoch: fetchEpoch,
        topicId: topicIdAtStart,
        routeId: routeAtStart,
        anchorMessageId: visible.anchorMessageId,
        wantOffset: visible.wantOffset,
        windowId: wid,
        quietArmed: false
      }
      const scrollToken = {}
      viewportDispatch({ type: 'scroll/begin', mode: 'anchoring', token: scrollToken })
      notifyViewport()
      return fetchEpoch
    },
    [cancelTopVisibleQuiet, controller, notifyViewport, viewportDispatch, windowIdentityKey]
  )
  const endDividerSearchTerminal = useCallback(
    (epoch: number, _reason: DividerSearchTerminalReason): void => {
      void _reason
      // Terminal fallback: explicit fail-visible release exactly once, never
      // a divider-position commit. failVisibleTransition is session-gated: it
      // releases only while this epoch still owns the transition (superseded
      // searches are already inert). The pre-existing target route snapshot
      // is preserved — correct because no verified divider position exists to
      // persist, and persisting the edge/intermediate scroll would corrupt the
      // next restore of this route.
      if (dividerProgressRef.current?.ownerEpoch === epoch) dividerProgressRef.current = null
      if (searchAligningRef.current === epoch) searchAligningRef.current = null
      failVisibleTransition(epoch)
    },
    [failVisibleTransition]
  )
  const alignAndCommitDividerSearch = useCallback(
    async (
      epoch: number,
      topicIdAtStart: string,
      routeAtStart: string | null,
      alignKind: 'divider-row' | 'shared-message'
    ): Promise<void> => {
      if (searchAligningRef.current === epoch) {
        return
      }
      searchAligningRef.current = epoch
      try {
        const search = dividerProgressRef.current
        if (!search || search.ownerEpoch !== epoch) {
          return
        }
        const live = scrollContainerRef.current
        if (!live) {
          endDividerSearchTerminal(epoch, 'missing-window')
          return
        }
        const stillTarget = () =>
          isRestoreTargetValid({
            topicMatch: topicIdRef.current === topicIdAtStart,
            routeMatch: routeRef.current === routeAtStart,
            mounted: !unmountedRef.current,
            epochCurrent: controller.isSessionCurrent(epoch)
          })
        if (!stillTarget()) {
          endDividerSearchTerminal(epoch, 'superseded')
          return
        }
        const esc =
          typeof CSS !== 'undefined' &&
          typeof (CSS as unknown as { escape?: (v: string) => string }).escape === 'function'
            ? (CSS as unknown as { escape: (v: string) => string }).escape
            : (v: string) => v
        const getDividerRowEl = (): HTMLElement | null => {
          const row =
            (document.querySelector(`[data-divider-key="${esc(search.dividerKey)}"]`) as HTMLElement | null) ??
            (document.querySelector(
              `[data-testid="${esc(dividerRowTestId(search.anchorMessageId, search.parentOfDivider))}"]`
            ) as HTMLElement | null)
          return row && row.isConnected ? row : null
        }
        const getSharedEl = (): HTMLElement | null => {
          if (!search.sharedMessageId) return null
          return getMessageRowById(search.sharedMessageId)
        }
        const measureEl = (el: HTMLElement | null): number | null => {
          if (!el) return null
          try {
            return el.getBoundingClientRect().top - live.getBoundingClientRect().top
          } catch {
            return null
          }
        }
        const targetEl = alignKind === 'divider-row' ? getDividerRowEl() : getSharedEl()
        const measured = measureEl(targetEl)
        if (targetEl === null || measured === null) {
          // Lost residency between decision and alignment (layout churn):
          // re-step instead of aligning a ghost.
          searchAligningRef.current = null
          return
        }
        const capturedTarget =
          alignKind === 'divider-row'
            ? search.wantOffset !== null && Number.isFinite(search.wantOffset)
              ? search.wantOffset
              : measured
            : search.sharedOffset !== null && Number.isFinite(search.sharedOffset)
              ? search.sharedOffset
              : measured
        if (!stillTarget()) return
        // Compensate to the CAPTURED offset (never the outgoing raw
        // scrollTop, never an arbitrary delay), then settle one frame for
        // post-alignment layout quiet. ≤12px contract preserved (1px
        // epsilon). The persistent keeper holds the offset across late
        // layout; no bounded rAF stabilizer, no second session. The arm's
        // scroll token stays held until the commit below releases it.
        const delta = measured - capturedTarget
        if (Math.abs(delta) > 1) {
          try {
            live.scrollTop += delta
          } catch {
            return
          }
        }
        try {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        } catch {
          // fail-closed: commit gated below still verifies currency
        }
        if (!stillTarget()) return
        // The ONE stable commit for this divider restore: resident +
        // aligned + quiet. Advances displayed provenance, ends
        // ownership/token (release exactly once inside). Stale epochs
        // (superseded, user-cancelled, unmounted) never commit: the
        // cancelling owner already released exactly once.
        if (controller.isSessionCurrent(epoch)) {
          commitDisplayedStable(topicIdAtStart, routeAtStart, epoch)
          if (dividerProgressRef.current?.ownerEpoch === epoch) dividerProgressRef.current = null
        }
      } finally {
        if (searchAligningRef.current === epoch) searchAligningRef.current = null
      }
    },
    [commitDisplayedStable, controller, endDividerSearchTerminal, scrollContainerRef]
  )
  const stepDividerSearch = useCallback(() => {
    const search = dividerProgressRef.current
    if (!search) return
    // Supersession: a newer transition already owns the viewport (arming
    // clears the record, so reaching here with a mismatch is belt-and-braces).
    if (
      search.topicId !== topicIdRef.current ||
      search.routeId !== routeRef.current ||
      search.ownerEpoch !== controller.currentEpoch ||
      unmountedRef.current
    ) {
      if (search.ownerEpoch === controller.currentEpoch && !unmountedRef.current) {
        endDividerSearchTerminal(search.ownerEpoch, 'superseded')
      } else if (dividerProgressRef.current === search) {
        dividerProgressRef.current = null
      }
      return
    }
    if (searchAligningRef.current === search.ownerEpoch) return
    const committed = viewportStateRef.current
    const live = scrollContainerRef.current
    const esc =
      typeof CSS !== 'undefined' && typeof (CSS as unknown as { escape?: (v: string) => string }).escape === 'function'
        ? (CSS as unknown as { escape: (v: string) => string }).escape
        : (v: string) => v
    let dividerResident = false
    let sharedResident = false
    try {
      if (live) {
        const row = document.querySelector(`[data-divider-key="${esc(search.dividerKey)}"]`) as HTMLElement | null
        dividerResident = !!row && row.isConnected
        if (!dividerResident && search.sharedMessageId) {
          sharedResident = getMessageRowById(search.sharedMessageId) !== null
        } else if (dividerResident) {
          sharedResident = false
        }
      }
    } catch {
      dividerResident = false
      sharedResident = false
    }
    const preferred: PreferredRestoreAnchorSnapshot =
      search.wantOffset !== null
        ? { kind: 'divider-row', dividerKey: search.dividerKey, targetOffset: search.wantOffset }
        : search.sharedMessageId !== null && search.sharedOffset !== null
          ? { kind: 'message-row', messageId: search.sharedMessageId, targetOffset: search.sharedOffset }
          : { kind: 'divider-row', dividerKey: search.dividerKey, targetOffset: 0 }
    const decision = decideDividerRestoreSearchStep(
      {
        dividerResident,
        sharedResident,
        hasMoreOlder: committed.window?.hasMoreOlder ?? false,
        loadingOlder: committed.loading.older,
        pagesDriven: search.pagesDriven,
        targetCurrent: true,
        mounted: true,
        hasWindow: (committed.window?.displayMessages.length ?? 0) > 0,
        lastLoadFailed: search.lastLoadFailed
      },
      preferred
    )
    if (decision.action === 'align-and-commit') {
      void alignAndCommitDividerSearch(search.ownerEpoch, search.topicId, search.routeId, decision.alignKind)
      return
    }
    if (decision.action === 'drive-older') {
      // Explicit restore-owned drive (no scroll event required): short
      // windows at edge=0 may never fire InfiniteScroll, so the search owns
      // pagination directly. Dedup on the committed window identity so one
      // window drives exactly one page.
      const key = windowIdentityKey(committed.window)
      if (key !== null && search.drivenWindowKey === key) return
      search.drivenWindowKey = key
      search.pagesDriven += 1
      search.lastLoadFailed = false
      startOlderWindowLoad(decision.preferred)
      return
    }
    if (decision.action === 'wait-load') {
      return
    }
    endDividerSearchTerminal(search.ownerEpoch, decision.reason)
  }, [
    alignAndCommitDividerSearch,
    endDividerSearchTerminal,
    scrollContainerRef,
    startOlderWindowLoad,
    windowIdentityKey
  ])

  // Committed-window watcher: after each restore-owned older page lands (or
  // any window change while searching), re-step the search — continue driving
  // while the anchor is absent, align+commit once resident, terminate at the
  // oldest edge. Explicit, scroll-event-independent. Never drives while the
  // target is still hidden pre-paint, while a page is in flight, or while an
  // alignment is running for this epoch.
  useEffect(() => {
    const search = dividerProgressRef.current
    if (!search) return
    if (viewportPhaseAttr !== 'revealed') return
    if (searchAligningRef.current === search.ownerEpoch) return
    stepDividerSearch()
  }, [viewportState.window, viewportState.loading.older, viewportPhaseAttr, stepDividerSearch])

  // Divider-only visible rebase: synchronous first compensation + bounded
  // quiet sequence (fast path, layout phase, never hidden).
  // The visible commit above rebased the rendered list synchronously with the
  // container still visible (phase `aligned`, never `positioning`). This layout
  // effect applies the FIRST compensation synchronously before paint
  // (divider → wantOffset, explicit shared fallback → sharedOffset), then
  // schedules a bounded quiet sequence (≥1 rAF after the write, at most one
  // residual recheck frame). No stable commit happens in this layout effect:
  // the quiet callback revalidates mounted/topic/route/epoch/current
  // intent/current rendered window identity + resident divider-or-shared
  // fallback, applies a residual correction when needed, and only then runs
  // the ONE existing stable commit. No timer/stabilizer loop, no intermediate
  // snapshot write. Post-apply lost residency fails closed INTO the existing
  // hidden searching path under the SAME epoch/intent/ownership (aligned →
  // searching via `fallbackVisibleToSearch`, then the restore-owned
  // coordinator). A failed final commit while the epoch is still current
  // explicitly fails/terminates the visible transition (never clears the
  // pending driver first); stale callbacks never touch a newer session.
  useLayoutEffect(() => {
    const pending = dividerVisibleRef.current
    if (!pending) return
    // The quiet sequence owns the remainder once armed: a re-run for the same
    // pending must not apply a second first compensation or a second commit.
    if (pending.quietArmed) return
    if (!controller.isSessionCurrent(pending.ownerEpoch)) {
      if (dividerVisibleRef.current === pending) dividerVisibleRef.current = null
      return
    }
    if (controller.currentPhase !== 'aligned') return
    if (topicIdRef.current !== pending.topicId || routeRef.current !== pending.routeId) {
      failVisibleTransition(pending.ownerEpoch)
      return
    }
    const live = scrollContainerRef.current
    if (!live || unmountedRef.current) {
      failVisibleTransition(pending.ownerEpoch)
      return
    }
    const esc =
      typeof CSS !== 'undefined' && typeof (CSS as unknown as { escape?: (v: string) => string }).escape === 'function'
        ? (CSS as unknown as { escape: (v: string) => string }).escape
        : (v: string) => v
    // Post-apply lost-residency fallback into hidden searching (same session).
    // Explicit, stale-safe, no stable write: the search coordinator owns the
    // remainder (restore-owned pagination → resident → aligned → quiet →
    // the ONE stable commit). The anchoring scroll token stays held across
    // the transition; ownership releases only at that commit or a terminal.
    const fallBackToHiddenSearch = (): void => {
      const epoch = pending.ownerEpoch
      if (dividerVisibleRef.current !== pending && dividerProgressRef.current?.ownerEpoch !== epoch) {
        // Not ours anymore: stale work stays inert, never touches the newer
        // session.
        return
      }
      if (!controller.isSessionCurrent(epoch)) {
        if (dividerVisibleRef.current === pending) dividerVisibleRef.current = null
        return
      }
      cancelDividerVisibleQuiet()
      const progress = buildDividerSearchProgressFromVisible({
        ownerEpoch: pending.ownerEpoch,
        topicId: pending.topicId,
        routeId: pending.routeId,
        dividerKey: pending.dividerKey,
        anchorMessageId: pending.anchorMessageId,
        parentOfDivider: pending.parentOfDivider,
        sharedMessageId: pending.sharedMessageId,
        sharedOffset: pending.sharedOffset,
        wantOffset: pending.wantOffset
      })
      if (!progress) {
        failVisibleTransition(epoch)
        return
      }
      if (!controller.fallbackVisibleToSearch(epoch)) {
        failVisibleTransition(epoch)
        return
      }
      dividerProgressRef.current = progress
      if (dividerVisibleRef.current === pending) dividerVisibleRef.current = null
      notifyViewport()
      try {
        stepDividerSearch()
      } catch {
        // fail-closed: the committed-window watcher re-steps on window change
      }
    }
    const resolveTarget = (): { el: HTMLElement; target: number } | null => {
      try {
        const row = document.querySelector(`[data-divider-key="${esc(pending.dividerKey)}"]`) as HTMLElement | null
        if (row && row.isConnected) {
          if (typeof pending.wantOffset !== 'number' || !Number.isFinite(pending.wantOffset)) return null
          return { el: row, target: pending.wantOffset }
        }
        if (pending.sharedMessageId) {
          const el = getMessageRowById(pending.sharedMessageId)
          if (el) {
            if (typeof pending.sharedOffset !== 'number' || !Number.isFinite(pending.sharedOffset)) return null
            return { el, target: pending.sharedOffset }
          }
        }
        return null
      } catch {
        return null
      }
    }
    const measureOffset = (el: HTMLElement): number | null => {
      try {
        return el.getBoundingClientRect().top - live.getBoundingClientRect().top
      } catch {
        return null
      }
    }
    // Explicit terminal for current-session failures: never clears the driver
    // alone (termination owns the clear + exactly-once token release). Stale
    // work drops only its own driver and never touches a newer session.
    const dropOrFailVisible = (): void => {
      if (controller.isSessionCurrent(pending.ownerEpoch)) {
        failVisibleTransition(pending.ownerEpoch)
      } else if (dividerVisibleRef.current === pending) {
        dividerVisibleRef.current = null
      }
    }
    // Quiet-callback currency gate (strict): mounted/topic/route/epoch/phase/
    // intent/rendered window identity + live committed window must all still
    // agree with the pending visible driver. No adoption: a same-current
    // window mismatch is a current-session failure (explicit fail/terminate
    // via dropOrFailVisible, or the hidden fallback when anchor residency is
    // lost). Stale superseded work only clears its own pending ref.
    const quietCurrent = (): { ok: boolean; lostResidency: boolean } => {
      if (unmountedRef.current) return { ok: false, lostResidency: false }
      if (topicIdRef.current !== pending.topicId || routeRef.current !== pending.routeId) {
        return { ok: false, lostResidency: false }
      }
      if (!controller.isSessionCurrent(pending.ownerEpoch)) return { ok: false, lostResidency: false }
      if (controller.currentPhase !== 'aligned') return { ok: false, lostResidency: false }
      const intent = controller.currentIntent
      if (!intent || intent.kind !== 'divider') return { ok: false, lostResidency: false }
      if (intent.topicId !== pending.topicId || intent.targetRoute !== pending.routeId) {
        return { ok: false, lostResidency: false }
      }
      try {
        const liveWindowId = windowIdentityKey(viewportStateRef.current.window)
        if (!liveWindowId || liveWindowId !== pending.windowId) {
          if (!resolveTarget()) return { ok: false, lostResidency: true }
          return { ok: false, lostResidency: false }
        }
      } catch {
        return { ok: false, lostResidency: false }
      }
      const rendered = controller.renderedProvenance
      if (!rendered || rendered.epoch !== pending.ownerEpoch || rendered.windowId !== pending.windowId) {
        if (!resolveTarget()) return { ok: false, lostResidency: true }
        return { ok: false, lostResidency: false }
      }
      if (!resolveTarget()) return { ok: false, lostResidency: true }
      return { ok: true, lostResidency: false }
    }
    const commitQuiet = (): void => {
      const gate = quietCurrent()
      if (!gate.ok) {
        if (gate.lostResidency) {
          fallBackToHiddenSearch()
          return
        }
        // Same-current window mismatch: explicit fail/terminate (releases
        // exactly once, preserves the pre-existing snapshot). Stale work
        // drops only its own driver.
        dropOrFailVisible()
        return
      }
      const ok = commitDisplayedStable(pending.topicId, pending.routeId, pending.ownerEpoch)
      if (ok) {
        if (dividerVisibleRef.current === pending) dividerVisibleRef.current = null
        notifyViewport()
        return
      }
      // Commit refused: while this epoch is still current the visible
      // transition must explicitly fail/terminate (releases exactly once,
      // preserves the pre-existing snapshot). Never clear the pending driver
      // first — termination owns the clear. Stale epochs stay inert.
      if (controller.isSessionCurrent(pending.ownerEpoch)) {
        failVisibleTransition(pending.ownerEpoch)
        return
      }
      if (dividerVisibleRef.current === pending) dividerVisibleRef.current = null
    }
    try {
      const first = resolveTarget()
      if (!first) {
        fallBackToHiddenSearch()
        return
      }
      const have = measureOffset(first.el)
      if (have === null) {
        fallBackToHiddenSearch()
        return
      }
      const delta = have - first.target
      if (Math.abs(delta) > 1) {
        try {
          live.scrollTop += delta
        } catch {
          failVisibleTransition(pending.ownerEpoch)
          return
        }
      }
      // Hold the same session/ownership + anchoring token across the quiet
      // sequence: no commit, no snapshot write, no phase change here.
      pending.quietArmed = true
      cancelDividerVisibleQuiet()
      dividerVisibleRafRef.current = requestAnimationFrame(() => {
        dividerVisibleRafRef.current = null
        // Stale scheduled work must no-op against a newer session.
        if (dividerVisibleRef.current !== pending) return
        const gate = quietCurrent()
        if (!gate.ok) {
          if (gate.lostResidency) {
            fallBackToHiddenSearch()
            return
          }
          // Same-current window mismatch terminates explicitly (releases
          // exactly once); stale work drops only its own driver.
          dropOrFailVisible()
          return
        }
        // Residual re-measure: late layout (fonts/images/divider) may have
        // moved the target after the first write. A second correction waits
        // one more frame and revalidates before the commit.
        const current = resolveTarget()
        if (!current) {
          fallBackToHiddenSearch()
          return
        }
        const reHave = measureOffset(current.el)
        if (reHave === null) {
          fallBackToHiddenSearch()
          return
        }
        const residual = reHave - current.target
        if (Math.abs(residual) > 1) {
          try {
            live.scrollTop += residual
          } catch {
            failVisibleTransition(pending.ownerEpoch)
            return
          }
          dividerVisibleRafRef.current = requestAnimationFrame(() => {
            dividerVisibleRafRef.current = null
            if (dividerVisibleRef.current !== pending) return
            commitQuiet()
          })
          return
        }
        commitQuiet()
      })
    } catch {
      failVisibleTransition(pending.ownerEpoch)
    }
  }, [
    viewportState.window,
    controller,
    cancelDividerVisibleQuiet,
    commitDisplayedStable,
    failVisibleTransition,
    notifyViewport,
    scrollContainerRef,
    stepDividerSearch,
    windowIdentityKey
  ])

  // Top-only visible rebase: synchronous first compensation + bounded quiet
  // sequence (fast path, layout phase, never hidden).
  // The visible commit above rebased the rendered list synchronously with the
  // container still visible (phase `aligned`, never `positioning`). This layout
  // effect applies the FIRST compensation synchronously before paint (saved
  // anchor → saved offset, via the raw-ID row lookup, never a selector
  // escape), then schedules a bounded quiet sequence (≥1 rAF after the write,
  // at most one residual recheck frame). No stable commit happens in this
  // layout effect: the quiet callback revalidates mounted/topic/route/epoch/
  // current intent/current rendered window identity + resident anchor, applies
  // a residual correction when needed, and only then runs the ONE identity-
  // stable snapshot commit (`commitDisplayedStableWithAnchor`). No timer/
  // stabilizer loop, no intermediate snapshot write. Post-apply loss of
  // coverage/residency/alignment fails closed into the EXISTING hidden atomic
  // restore under the SAME epoch (rewind aligned → fetch-hold, commit the
  // stashed authoritative target window + plan, hidden retry, ownership held
  // until it settles) — never divider search semantics, never a second
  // controller truth, never the union identity adopted as hidden proof. Only
  // when that hidden path actually cannot restore (missing payload, rewind or
  // hidden commit refused, retry unresolvable) does the terminal preserve run
  // (fail-visible, prior snapshot kept). Stale callbacks stay inert and never
  // touch a newer session. A failed final commit while the epoch is still
  // current tries the hidden retry first (never clears the pending driver
  // first); stale callbacks never touch a newer session.
  useLayoutEffect(() => {
    const pending = topVisibleRef.current
    if (!pending) return
    if (pending.quietArmed) return
    if (!controller.isSessionCurrent(pending.ownerEpoch)) {
      if (topVisibleRef.current === pending) topVisibleRef.current = null
      if (topHiddenFallbackRef.current?.ownerEpoch === pending.ownerEpoch) topHiddenFallbackRef.current = null
      return
    }
    if (controller.currentPhase !== 'aligned') return
    if (topicIdRef.current !== pending.topicId || routeRef.current !== pending.routeId) {
      failVisibleTransition(pending.ownerEpoch)
      return
    }
    const live = scrollContainerRef.current
    if (!live || unmountedRef.current) {
      failVisibleTransition(pending.ownerEpoch)
      return
    }
    const resolveTarget = (): { el: HTMLElement; target: number } | null => {
      try {
        const el = getMessageRowById(pending.anchorMessageId)
        if (!el) return null
        if (typeof pending.wantOffset !== 'number' || !Number.isFinite(pending.wantOffset)) return null
        return { el, target: pending.wantOffset }
      } catch {
        return null
      }
    }
    const measureOffset = (el: HTMLElement): number | null => {
      try {
        return el.getBoundingClientRect().top - live.getBoundingClientRect().top
      } catch {
        return null
      }
    }
    const dropOrFailVisible = (): void => {
      if (controller.isSessionCurrent(pending.ownerEpoch)) {
        failVisibleTransition(pending.ownerEpoch)
      } else {
        if (topVisibleRef.current === pending) topVisibleRef.current = null
        if (topHiddenFallbackRef.current?.ownerEpoch === pending.ownerEpoch) topHiddenFallbackRef.current = null
      }
    }
    // Same-epoch top visible → hidden fallback (bounded, no new lifecycle).
    // Rewinds aligned → fetch-hold and commits the stashed authoritative
    // target window + first-position plan through the EXISTING hidden entry,
    // then runs the hidden retry (fold-reveal, bounded projection wait,
    // direct settle, identity commit gate) under the same epoch with
    // ownership held throughout. No W1→W2 adoption (the union identity is
    // never rebound as hidden proof), no programmatic snapshot pollution (the
    // ONE identity commit is the only writer), no divider semantics. Stale
    // work stays inert; terminal preserve runs only when the hidden path
    // actually cannot restore.
    const runTopHiddenRetry = async (fb: {
      ownerEpoch: number
      topicId: string
      routeId: string | null
      anchorMessageId: string
      wantOffset: number
      isAtBottom: boolean
    }): Promise<void> => {
      const epoch = fb.ownerEpoch
      const stillTarget = (): boolean =>
        topicIdRef.current === fb.topicId &&
        routeRef.current === fb.routeId &&
        !unmountedRef.current &&
        controller.currentEpoch === epoch
      // Placement ack: the hidden fallback's fresh plan places in the
      // pre-paint layout effect of the same-epoch hidden commit — settle
      // work must not run before that attempt is observed.
      const retryPlacementObserved = await awaitPlanPlacement(epoch, stillTarget)
      if (!retryPlacementObserved) {
        failVisibleTransition(epoch)
        return
      }
      try {
        if (checkElement(fb.anchorMessageId) === 'hidden') {
          await selectMessageForFold(fb.anchorMessageId)
        }
      } catch {
        // fail-closed: commit gate below still verifies residency
      }
      if (!stillTarget()) {
        failVisibleTransition(epoch)
        return
      }
      try {
        const projectionReady = await waitForProjectionCommit(fb.anchorMessageId, () => !stillTarget())
        if (!projectionReady) {
          failVisibleTransition(epoch)
          return
        }
      } catch {
        failVisibleTransition(epoch)
        return
      }
      if (!stillTarget()) {
        failVisibleTransition(epoch)
        return
      }
      const retryLive = scrollContainerRef.current
      if (retryLive && typeof fb.wantOffset === 'number' && Number.isFinite(fb.wantOffset)) {
        const settleOnce = (): boolean => {
          try {
            const el = getMessageRowById(fb.anchorMessageId)
            if (!el || !stillTarget()) return false
            const have = el.getBoundingClientRect().top - retryLive.getBoundingClientRect().top
            const delta = have - fb.wantOffset
            if (Math.abs(delta) > 1) retryLive.scrollTop += delta
            return true
          } catch {
            return false
          }
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        if (!stillTarget()) {
          failVisibleTransition(epoch)
          return
        }
        settleOnce()
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        if (!stillTarget()) {
          failVisibleTransition(epoch)
          return
        }
        settleOnce()
      }
      if (!controller.isSessionCurrent(epoch)) return
      // Hidden commit gate under the original policies: the saved anchor must
      // be covered (projection) and resident (DOM) before it may become the
      // route snapshot — an unmet valid anchor fails visible and preserves
      // the prior snapshot, never a fallback commit.
      let projectionContains = false
      try {
        projectionContains = messagesRef.current.some((m) => m.id === fb.anchorMessageId)
      } catch {
        projectionContains = false
      }
      let domConnected = false
      try {
        domConnected = getMessageRowById(fb.anchorMessageId) !== null
      } catch {
        domConnected = false
      }
      if (
        !isTopStableCommittable({
          isAtBottom: fb.isAtBottom,
          snapshotInvalidForRoute: false,
          requestedAnchor: fb.anchorMessageId,
          projectionContains,
          domConnected
        })
      ) {
        failVisibleTransition(epoch)
        return
      }
      const ok = commitDisplayedStableWithAnchor(
        fb.topicId,
        fb.routeId,
        epoch,
        fb.anchorMessageId,
        Number.isFinite(fb.wantOffset) ? fb.wantOffset : null
      )
      if (!ok && controller.isSessionCurrent(epoch)) {
        failVisibleTransition(epoch)
      }
    }
    const fallBackToHiddenTop = (): void => {
      const epoch = pending.ownerEpoch
      // Stale work stays inert: never touch the newer session, only drop the
      // driver's own attempt data.
      if (topVisibleRef.current !== pending) return
      const fb = topHiddenFallbackRef.current
      if (!controller.isSessionCurrent(epoch)) {
        if (topVisibleRef.current === pending) topVisibleRef.current = null
        if (fb?.ownerEpoch === epoch) topHiddenFallbackRef.current = null
        return
      }
      // No materialized hidden plan for this epoch: the hidden path actually
      // cannot restore → terminal preserve (prior snapshot kept).
      if (!fb || fb.ownerEpoch !== epoch || fb.topicId !== pending.topicId || fb.routeId !== pending.routeId) {
        failVisibleTransition(epoch)
        return
      }
      cancelTopVisibleQuiet()
      if (topVisibleRef.current === pending) topVisibleRef.current = null
      if (!controller.fallbackTopVisibleToHidden(epoch)) {
        topHiddenFallbackRef.current = null
        failVisibleTransition(epoch)
        return
      }
      const hiddenEpoch = commitRouteWindowAtomic(epoch, fb.topicId, fb.routeId, fb.targetWindow, fb.firstPlan)
      if (hiddenEpoch === null) {
        topHiddenFallbackRef.current = null
        failVisibleTransition(epoch)
        return
      }
      // Single-use payload consumed: the hidden path owns the remainder
      // (first-position layout + retry below). Ownership + token stay held.
      topHiddenFallbackRef.current = null
      notifyViewport()
      void runTopHiddenRetry(fb)
    }
    const quietCurrent = (): { ok: boolean; lostResidency: boolean } => {
      if (unmountedRef.current) return { ok: false, lostResidency: false }
      if (topicIdRef.current !== pending.topicId || routeRef.current !== pending.routeId) {
        return { ok: false, lostResidency: false }
      }
      if (!controller.isSessionCurrent(pending.ownerEpoch)) return { ok: false, lostResidency: false }
      if (controller.currentPhase !== 'aligned') return { ok: false, lostResidency: false }
      const intent = controller.currentIntent
      if (!intent || intent.kind !== 'top') return { ok: false, lostResidency: false }
      if (intent.topicId !== pending.topicId || intent.targetRoute !== pending.routeId) {
        return { ok: false, lostResidency: false }
      }
      try {
        const liveWindowId = windowIdentityKey(viewportStateRef.current.window)
        if (!liveWindowId || liveWindowId !== pending.windowId) {
          if (!resolveTarget()) return { ok: false, lostResidency: true }
          return { ok: false, lostResidency: false }
        }
      } catch {
        return { ok: false, lostResidency: false }
      }
      const rendered = controller.renderedProvenance
      if (!rendered || rendered.epoch !== pending.ownerEpoch || rendered.windowId !== pending.windowId) {
        if (!resolveTarget()) return { ok: false, lostResidency: true }
        return { ok: false, lostResidency: false }
      }
      if (!resolveTarget()) return { ok: false, lostResidency: true }
      return { ok: true, lostResidency: false }
    }
    const commitQuiet = (): void => {
      const gate = quietCurrent()
      if (!gate.ok) {
        // Coverage/residency/alignment loss retries hidden under the same
        // epoch; any other current-session divergence terminates. Stale work
        // only drops its own driver via dropOrFailVisible.
        if (gate.lostResidency) {
          fallBackToHiddenTop()
          return
        }
        dropOrFailVisible()
        return
      }
      const ok = commitDisplayedStableWithAnchor(
        pending.topicId,
        pending.routeId,
        pending.ownerEpoch,
        pending.anchorMessageId,
        pending.wantOffset
      )
      if (ok) {
        if (topVisibleRef.current === pending) topVisibleRef.current = null
        if (topHiddenFallbackRef.current?.ownerEpoch === pending.ownerEpoch) topHiddenFallbackRef.current = null
        notifyViewport()
        return
      }
      // Final visible commit refused while still current: the visible union
      // cannot complete → hidden retry first, terminal only if hidden cannot
      // restore. Stale epochs stay inert.
      if (controller.isSessionCurrent(pending.ownerEpoch)) {
        fallBackToHiddenTop()
        return
      }
      if (topVisibleRef.current === pending) topVisibleRef.current = null
      if (topHiddenFallbackRef.current?.ownerEpoch === pending.ownerEpoch) topHiddenFallbackRef.current = null
    }
    try {
      const first = resolveTarget()
      if (!first) {
        fallBackToHiddenTop()
        return
      }
      const have = measureOffset(first.el)
      if (have === null) {
        fallBackToHiddenTop()
        return
      }
      const delta = have - first.target
      if (Math.abs(delta) > 1) {
        try {
          live.scrollTop += delta
        } catch {
          failVisibleTransition(pending.ownerEpoch)
          return
        }
      }
      pending.quietArmed = true
      cancelTopVisibleQuiet()
      topVisibleRafRef.current = requestAnimationFrame(() => {
        topVisibleRafRef.current = null
        if (topVisibleRef.current !== pending) return
        const gate = quietCurrent()
        if (!gate.ok) {
          if (gate.lostResidency) {
            fallBackToHiddenTop()
            return
          }
          dropOrFailVisible()
          return
        }
        const current = resolveTarget()
        if (!current) {
          fallBackToHiddenTop()
          return
        }
        const reHave = measureOffset(current.el)
        if (reHave === null) {
          fallBackToHiddenTop()
          return
        }
        const residual = reHave - current.target
        if (Math.abs(residual) > 1) {
          try {
            live.scrollTop += residual
          } catch {
            failVisibleTransition(pending.ownerEpoch)
            return
          }
          topVisibleRafRef.current = requestAnimationFrame(() => {
            topVisibleRafRef.current = null
            if (topVisibleRef.current !== pending) return
            commitQuiet()
          })
          return
        }
        commitQuiet()
      })
    } catch {
      failVisibleTransition(pending.ownerEpoch)
    }
  }, [
    viewportState.window,
    awaitPlanPlacement,
    controller,
    cancelTopVisibleQuiet,
    checkElement,
    commitDisplayedStableWithAnchor,
    commitRouteWindowAtomic,
    failVisibleTransition,
    notifyViewport,
    scrollContainerRef,
    selectMessageForFold,
    waitForProjectionCommit,
    windowIdentityKey
  ])

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
  // the primary divider anchor. The OLD (displayed) route's stable snapshot
  // is frozen synchronously before the switch (displayed provenance); the
  // target route's snapshot is committed only on stable completion. The
  // loaded projection is rebased atomically (no blank/reset, no mixed route).
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
      // Outgoing-route freeze: synchronously snapshot the DISPLAYED route
      // BEFORE the selected route changes. Dropped while owned (transient):
      // the existing stable snapshot stands. Then open the divider session
      // (fetch-hold): the outgoing viewport stays visible during the fetch
      // below and no write may land under the incoming route identity. The
      // divider intent keeps ONLY the clicked divider's screen offset — the
      // target route's history is never read.
      saveDisplayedSnapshot()
      const capturedCurrentWindowAtStart = viewportStateRef.current.window
      const fetchEpoch = beginFetchHold(topicIdAtStart, branchId, {
        kind: 'divider',
        dividerKey,
        clickOffset: dividerVisualAnchorOffset
      })
      loadedRouteRef.current = claimLoadedRoute(branchId)
      cancelActiveLoads()
      // Incremental: keep the current viewport visible during the windowed
      // fetch (no topic/reset blank). Only the per-route window cache is
      // dropped so stale windows cannot satisfy the new route.
      windowCacheRef.current.clear()
      dispatch(activeBranchSet({ topicId, branchId }))
      let routeWindow: FetchMessagesWindowResponse
      // Deferred publish: fetch without dispatching blocks/rebase so the
      // Redux projection + viewport window + controller phase commit in ONE
      // React batch (no intermediate paint with new suffix before compensation).
      let deferredBlocks: MessageBlock[] = []
      let deferredMessages: Message[] = []
      let deferredMutable: string[] = []
      try {
        const isStillTarget = (): boolean => topicIdRef.current === topicIdAtStart && routeRef.current === branchId
        const aroundOpts = {
          kind: 'around' as const,
          anchorMessageId,
          before: NAVIGATION_VISUALLY_OLDER_GROUPS,
          after: NAVIGATION_VISUALLY_NEWER_GROUPS,
          deferPublish: true
        }
        let aroundRes: FetchMessagesWindowResponse | void = undefined
        try {
          aroundRes = (await (dispatch as unknown as (a: unknown) => Promise<unknown>)(
            loadRouteMessagesThunk(topicId, branchId, aroundOpts)
          )) as FetchMessagesWindowResponse | void
          // Thunk returns response directly (not via unwrap); handle both.
          if (aroundRes && (aroundRes as unknown as { window?: unknown }).window) {
            routeWindow = aroundRes
          } else {
            throw new Error('around route read discarded as stale')
          }
        } catch (aroundError) {
          if (!isStillTarget()) throw aroundError
          const latestRes = (await (dispatch as unknown as (a: unknown) => Promise<unknown>)(
            loadRouteMessagesThunk(topicId, branchId, { kind: 'latest', deferPublish: true } as unknown as Parameters<
              typeof loadRouteMessagesThunk
            >[2])
          )) as FetchMessagesWindowResponse | void
          if (!latestRes || !(latestRes as unknown as { window?: unknown }).window) {
            throw new Error('latest route fallback discarded as stale')
          }
          routeWindow = latestRes
        }
        deferredBlocks = (routeWindow.blocks as unknown as MessageBlock[]) ?? []
        deferredMessages = (routeWindow.messages as unknown as Message[]) ?? []
        deferredMutable = Array.isArray((routeWindow as unknown as { mutableMessageIds?: unknown }).mutableMessageIds)
          ? ((routeWindow as unknown as { mutableMessageIds: string[] }).mutableMessageIds ?? [])
          : []
      } catch (error) {
        logger.error(`[handleSelectRoute] Failed to load route for topic ${topicId}:`, error as Error)
        window.toast.error(t('message.true_branch.error'))
        failVisibleTransition(fetchEpoch)
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
      if (topicIdRef.current !== topicIdAtStart || routeRef.current !== branchId) {
        failVisibleTransition(fetchEpoch)
        return
      }
      // Batched publish helper: blocks + rebase dispatched synchronously with
      // the window commit in the same tick (no intermediate paint).
      let deferredPublished = false
      const publishDeferredProjection = (): void => {
        if (deferredPublished) return
        deferredPublished = true
        if (deferredBlocks.length > 0) {
          dispatch(withClosureTopics(upsertManyBlocks(deferredBlocks), topicIdAtStart))
        }
        dispatch(
          newMessagesActions.rebaseRouteMessages({
            topicId: topicIdAtStart,
            messages: deferredMessages,
            route: branchId,
            mutableMessageIds: deferredMutable
          })
        )
      }
      try {
        // Use the authoritative deferred messages directly (store not yet updated
        // due to deferPublish) so target viewport build is deterministic.
        const loaded = deferredMessages
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
          // Divider-only visible incremental rebase (fast path, never hidden):
          // fork-aligned route semantics — the preserved chain is the current
          // resident prefix through the fork (which may begin earlier than the
          // target around-window head), verified continuous against the
          // authoritative target response; only the target window's ordered
          // exclusive suffix is appended and the outgoing foreign suffix is
          // removed. The union window covers the preserved prefix plus the
          // suffix exactly, so shared rows keep their mounted DOM nodes and
          // the clicked divider stays at its offset via the layout
          // compensation below. Any eligibility doubt falls through to the
          // hidden searching path unchanged (missing fork, disjoint/
          // malformed/interleaved/duplicate/unstable IDs, foreign suffix,
          // unmeasurable offset, or empty incoming suffix).
          if (dividerVisualAnchorOffset !== null) {
            try {
              const currentWindow = capturedCurrentWindowAtStart
              const currentIds = currentWindow?.displayMessages?.map((m) => m.id) ?? []
              const targetIds = targetWindow.displayMessages?.map((m) => m.id) ?? []
              const responseIds = ((routeWindow.messages ?? []) as unknown as Message[]).map((m) => m.id)
              const toOldestFirst = (newestFirst: string[]): string[] => [...newestFirst].reverse()
              const visiblePlan = planDividerVisibleRebase({
                currentIdsOldestFirst: toOldestFirst(currentIds),
                targetResponseIdsOldestFirst: responseIds,
                targetWindowIdsOldestFirst: toOldestFirst(targetIds),
                forkAnchorId: anchorMessageId,
                currentHasMoreBefore: currentWindow?.hasMoreOlder ?? false,
                targetHasMoreAfter: targetWindow.hasMoreNewer
              })
              if (visiblePlan) {
                // Union objects: preserved prefix reuses the exact resident
                // instances (same React keys → mounted rows stay); the suffix
                // comes from the authoritative loaded projection.
                const unionNewestFirst = buildDividerVisibleMessages(
                  currentWindow?.displayMessages ?? [],
                  loaded,
                  visiblePlan
                )
                const unionOldestFirst = [...unionNewestFirst].reverse()
                // Group quotas sized to cover the whole union (every preserved
                // group plus every incoming group), so no shared row is
                // trimmed by quota: the union IS the committed window.
                // Capabilities ride merged (older from the preserved current
                // side, newer from the target side).
                const unionModel = createMessageViewportGroupModel(unionOldestFirst)
                const unionForkGroup = unionModel.messageIdToGroup.get(anchorMessageId)
                const unionForkGroupIndex = unionForkGroup ? unionModel.groups.indexOf(unionForkGroup) : -1
                if (unionForkGroupIndex >= 0) {
                  const unionWindow = createTargetMessageWindow(
                    unionOldestFirst,
                    anchorMessageId,
                    unionForkGroupIndex + 1,
                    unionModel.groups.length - unionForkGroupIndex - 1,
                    { hasMoreBefore: visiblePlan.hasMoreBefore, hasMoreAfter: visiblePlan.hasMoreAfter }
                  )
                  // Fail-closed union gate: the built visible window must
                  // represent every planned ID exactly (no bounded-viewport
                  // trim, no duplicates/missing IDs, group count/capacity
                  // consistent, hasMore flags truthful). Any mismatch skips
                  // the visible path and runs the existing hidden atomic path
                  // unchanged. Uses the exported cap/observability mechanisms
                  // (never a hardcoded second truth).
                  const unionExact = isDividerVisibleUnionExact({
                    plan: visiblePlan,
                    unionOldestFirst,
                    unionNewestFirst,
                    unionWindow,
                    unionModelGroupCount: unionModel.groups.length
                  })
                  if (unionExact && (unionWindow.displayMessages?.length ?? 0) > 0) {
                    const visibleEpoch = commitDividerVisibleAtomic(
                      fetchEpoch,
                      topicIdAtStart,
                      branchId,
                      unionWindow,
                      {
                        dividerKey,
                        anchorMessageId,
                        parentOfDivider,
                        sharedMessageId: sharedVisualMessageId,
                        sharedOffset:
                          fallbackTop && Number.isFinite(fallbackTop.intraRowOffset)
                            ? fallbackTop.intraRowOffset
                            : null,
                        wantOffset: dividerVisualAnchorOffset
                      },
                      publishDeferredProjection
                    )
                    if (visibleEpoch !== null) {
                      // Visible path armed: the layout effect applies the first
                      // compensation, then the bounded quiet sequence commits.
                      // Skip the hidden search record and the rAF coordinator
                      // below entirely (no positioning, no searching on the
                      // success path).
                      return
                    }
                  }
                }
              }
            } catch {
              // fail-closed: fall through to the hidden path below
            }
          }
          // Atomic route transition: arm hidden-until-positioned together
          // with the target window commit in the same React batch. The old
          // viewport stays visible during the fetch above (incremental);
          // only this commit hides, and the pre-paint layout effect applies
          // the first scroll synchronously before reveal. First placement
          // lives ONLY in that layout effect; the async continuation below
          // runs the bounded stabilizer for post-reveal drift. Route-local
          // fallbacks only: divider row → shared message → oldest edge
          // (a partial window still lands near the pagination edge and
          // auto-pages under the divider anchor during the transition).
          // Never the outgoing route's raw scrollTop.
          const firstPlan: ViewportFirstPositionPlan =
            dividerVisualAnchorOffset !== null
              ? {
                  kind: 'divider',
                  dividerKey,
                  anchorMessageId,
                  wantOffset: dividerVisualAnchorOffset,
                  fallbackMessageId: sharedVisualMessageId,
                  fallbackOffset: fallbackTop?.intraRowOffset ?? null,
                  rawScrollTop: null,
                  edgeFallbackOnMissing: true
                }
              : fallbackTop
                ? {
                    kind: 'message',
                    messageId: fallbackTop.messageId,
                    wantOffset: fallbackTop.intraRowOffset,
                    fallbackScrollTop: null,
                    edgeFallbackOnMissing: true
                  }
                : { kind: 'none' }
          // Provenance-bound atomic commit (single entry): stale fetch
          // completions refuse with no dispatch and never disturb the new
          // session (rapid supersede safe). Deferred projection publishes
          // atomically with the window commit in the same synchronous tick
          // only after epoch/phase success — never before check/apply failed.
          const restoreEpoch = commitRouteWindowAtomic(
            fetchEpoch,
            topicIdAtStart,
            branchId,
            targetWindow,
            firstPlan,
            publishDeferredProjection
          )
          if (restoreEpoch === null) {
            failVisibleTransition(fetchEpoch)
            return
          }
          // The controller already holds the divider visual anchor from the
          // fetch-hold request (same divider row at the same targetOffset, or
          // the shared message row when the divider offset is unmeasurable —
          // the request falls back to a message anchor only when no divider
          // key was supplied). Queued intents snapshot only its stable
          // identity + offset. The anchor + captured offset survive EVERY
          // older-window expansion until the search coordinator commits or
          // terminates (never cleared on intermediate pages).
          // Divider restore search record: the coordinator below (and the
          // window-watcher effect) drives restore-owned pagination from
          // window/hasMoreOlder/anchor-residency state — never from a scroll
          // event — until the requested identity is resident/aligned/quiet.
          // Only when a restore identity exists (divider offset or shared
          // fallback); identity-less restores take the deterministic default
          // single-pass path in the coordinator below.
          if (dividerVisualAnchorOffset !== null || fallbackTop !== null) {
            dividerProgressRef.current = {
              ownerEpoch: restoreEpoch,
              topicId: topicIdAtStart,
              routeId: branchId,
              dividerKey,
              anchorMessageId,
              parentOfDivider,
              sharedMessageId: sharedVisualMessageId,
              sharedOffset:
                fallbackTop && Number.isFinite(fallbackTop.intraRowOffset) ? fallbackTop.intraRowOffset : null,
              wantOffset: dividerVisualAnchorOffset,
              pagesDriven: 0,
              lastLoadFailed: false,
              drivenWindowKey: null
            }
          }
        }
      } catch (error) {
        logger.error(`[handleSelectRoute] Failed to rebuild viewport window:`, error as Error)
        return
      }
      // Divider restore search coordinator (binding invariant): route-stable
      // completion waits for the requested identity (divider row or valid
      // shared fallback) to be resident/aligned/quiet. The pre-paint layout
      // reveal already placed the first position — `placed` for a resident
      // identity, `searching` (safe-edge parking) when it is outside the
      // resident window. This coordinator runs ONE search step explicitly
      // (never via scroll event); the committed-window watcher effect drives
      // subsequent pages as windows land. Intermediate pages never commit,
      // never clear the intent, never release ownership. Never
      // `canHandleUserViewportScroll` — the anchoring token closes that gate
      // by design and would self-cancel.
      try {
        await viewportCommitWaiterRef.current.wait(viewportStateRef.current, (committedState) => {
          if (committedState.window?.displayMessages?.length) return true
          return null
        })
      } catch {
        // fail-closed: continue to rAF search attempt
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (topicIdRef.current !== topicIdAtStart || routeRef.current !== branchId) {
            failVisibleTransition(fetchEpoch)
            return
          }
          const pending = transitionPlanRef.current
          const armedEpoch =
            pending && pending.topicId === topicIdAtStart && pending.routeId === branchId
              ? pending.epoch
              : controller.currentEpoch
          if (controller.currentEpoch !== armedEpoch || unmountedRef.current) {
            failVisibleTransition(armedEpoch)
            return
          }
          const search = dividerProgressRef.current
          if (!search || search.ownerEpoch !== armedEpoch) {
            // Identity-less restore (deterministic default): no search to
            // run. Settle one frame for late layout, then commit the visible
            // default viewport as stable and release. Superseded searches are
            // inert (epoch mismatch → fail visible only).
            void (async () => {
              try {
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
              } catch {
                // fail-closed below still releases
              }
              if (controller.currentEpoch !== armedEpoch || unmountedRef.current) {
                failVisibleTransition(armedEpoch)
                return
              }
              const owner = transitionPlanRef.current
              const owned = owner !== null && owner.topicId === topicIdAtStart && owner.routeId === branchId
              if (owned) {
                // commitDisplayedStable commits, advances displayed, ends the
                // token, clears the plan, and releases exactly once.
                commitDisplayedStable(topicIdAtStart, branchId, armedEpoch)
                notifyViewport()
              } else {
                failVisibleTransition(armedEpoch)
              }
            })()
            return
          }
          // Restore-owned search step: align+commit when resident, explicit
          // page drive when absent, terminal release (no commit) at the
          // oldest edge / failure / cap. Ownership stays held across pages.
          stepDividerSearch()
        })
      })
    },
    [
      beginFetchHold,
      cancelActiveLoads,
      commitDisplayedStable,
      commitDividerVisibleAtomic,
      commitRouteWindowAtomic,
      dispatch,
      failVisibleTransition,
      saveDisplayedSnapshot,
      scrollContainerRef,
      stepDividerSearch,
      t,
      topic.id
    ]
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
    // Invalidate any in-flight divider/top restores before the latest load
    // and hold fetch-gap ownership: the outgoing viewport stays visible
    // during the fetch (incremental) and no write may land under the
    // fallback identity. The armed transition below tears this hold down
    // synchronously; stale/failure paths fail visible (release, never hide).
    const deletionFetchEpoch = beginFetchHold(topicIdAtEffect, routeAtEffect)
    notifyViewport()
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
        failVisibleTransition(deletionFetchEpoch)
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
        failVisibleTransition(deletionFetchEpoch)
        dispatch(deletionFallbackConsumed({ topicId: topicIdAtEffect, intentId: intentIdAtEffect }))
        return
      }
      // A stale (superseded/generation-mismatched) latest read publishes
      // nothing (void): keep the failed marker retryable instead of applying
      // a half viewport.
      if (!routeWindow || !routeWindow.window) {
        failVisibleTransition(deletionFetchEpoch)
        loadedRouteRef.current = markLoadedRouteFailed(routeAtEffect)
        dispatch(deletionFallbackConsumed({ topicId: topicIdAtEffect, intentId: intentIdAtEffect }))
        return
      }
      // `deletionEpoch` is assigned exactly when the transition arms; the
      // catch below only fails that same epoch visible (never a newer owner).
      let deletionEpoch: number | null = null
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
        // Atomic deletion fallback (single entry): provenance-bound commit —
        // stale completions refuse with no dispatch, never disturbing a
        // superseding session. No navigation transaction: the window above
        // already is the tail and the plan already pins bottom.
        deletionEpoch = commitRouteWindowAtomic(deletionFetchEpoch, topicIdAtEffect, routeAtEffect, latestWindow, {
          kind: 'bottom'
        })
        if (deletionEpoch === null) {
          failVisibleTransition(deletionFetchEpoch)
          return
        }
        // Post-reveal settle only: one frame for late layout, then stable
        // commit (releases ownership exactly once) while still current.
        // Stale paths below fail visible; a superseding transition owns the
        // phase and must not be disturbed.
        try {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          if (topicIdRef.current !== topicIdAtEffect || routeRef.current !== routeAtEffect) {
            failVisibleTransition(deletionEpoch)
            return
          }
        } catch {
          // fail-closed: release in finally
        } finally {
          // Epoch-guarded stable completion: stale `finally` blocks never
          // touch the new session (session currency, not bare epoch equality).
          // Placement ack first: the fallback plan places in the pre-paint
          // layout effect of the same commit — completing before that attempt
          // would refuse while `positioning` and strand the session.
          const doneEpoch = deletionEpoch
          if (doneEpoch !== null && controller.isSessionCurrent(doneEpoch)) {
            await awaitPlanPlacement(doneEpoch, () =>
              isRestoreTargetValid({
                topicMatch: topicIdRef.current === topicIdAtEffect,
                routeMatch: routeRef.current === routeAtEffect,
                mounted: !unmountedRef.current,
                epochCurrent: controller.currentEpoch === doneEpoch
              })
            )
            if (!controller.isSessionCurrent(doneEpoch)) {
              return
            }
            // Stable completion: the fallback bottom viewport is the route's
            // stable snapshot (no user input required). commitDisplayedStable
            // advances displayed provenance, ends the token, clears the plan,
            // and releases ownership exactly once.
            commitDisplayedStable(topicIdAtEffect, routeAtEffect, doneEpoch)
            notifyViewport()
          }
        }
      } catch (error) {
        logger.error('[deletionFallback] Failed to rebuild fallback viewport:', error as Error)
        // Fail the armed epoch visible (no-op when superseded or never armed).
        if (deletionEpoch !== null) failVisibleTransition(deletionEpoch)
      } finally {
        dispatch(deletionFallbackConsumed({ topicId: topicIdAtEffect, intentId: intentIdAtEffect }))
      }
    })()
  }, [
    activeBranchId,
    beginFetchHold,
    cancelActiveLoads,
    commitDisplayedStable,
    commitRouteWindowAtomic,
    deletionFallbackIntent,
    dispatch,
    displayCount,
    awaitPlanPlacement,
    failVisibleTransition,
    t,
    topic.id
  ])

  // Top-selector route switch + external route invalidation (branch deleted
  // elsewhere, delete-fallback after subtree removal, catalog prune, topic
  // switch restore): the active route changed without a divider switch, so
  // the loaded projection is stale. Outgoing provenance: the OLD (displayed)
  // route was frozen synchronously before the switch by the top selector's
  // displayed-aware saver; this path re-freezes idempotently for external
  // paths that bypass the selector, then holds fetch-gap ownership so the
  // still-visible outgoing viewport can never write under the incoming key.
  // Never overwrite the NEW route's snapshot here. The target window is read
  // per the NEW route's own saved browsing position: valid canonical anchor
  // (messageId, legacy anchorId fallback) → around it even when isAtBottom;
  // no usable anchor → deterministic route-local default (latest + tail
  // below, bottom when isAtBottom). Never a bottom jump when an anchor is
  // unless the saved position is at bottom, never outgoing raw scrollTop,
  // never a topic transition. Divider-initiated switches claim
  // loadedRouteRef first and never enter this path.
  //
  // Double-failure degradation (around + latest both fail): the active route
  // is external truth and cannot roll back, so the viewport is atomically
  // cleared to an empty window and the loaded projection to [] — never "new
  // active route + old route projection", never mixed pagination. The failure
  // marker keeps loadedRouteRef diverged so the route effect (or a subsequent
  // route/topic switch) retries with a fresh load instead of believing the
  // new route is loaded.
  // Validated-continuation pre-paint (same-route page return, PRE-PAINT ONLY):
  // when the retained viewport provably shows its legal target — same
  // selected/displayed route, target-owned snapshot, retained + loaded +
  // connected coverage, live measurable geometry at the 1px production
  // epsilon — commit the fresh guarded epoch synchronously in the layout
  // phase so the FIRST paint already shows the correct viewport: no hidden
  // frames, no window redispatch, no placement plan. Exact geometry means
  // ZERO writes; a covered measurable mismatch gets ONE synchronous
  // anchor/bottom correction here (still pre-paint) with an immediate
  // remeasure that must verify within 1px before validate/reveal/commit.
  // A fresh guarded epoch still opens (new transaction identity, resources
  // reconnect) and identity/coverage/epoch/owner guards still apply; the
  // snapshot stays target-owned (never hidden geometry, never outgoing
  // position). Any doubt (unmeasurable, unverified after one correction,
  // empty, route change, deletion, divider, anchorless non-bottom) declines
  // with NO side effects — no epoch opened, no snapshot touched — and the
  // passive TOP pipeline below takes the existing hidden measurable restore.
  // Success consumes `activationRequired` and stabilizes, so the passive
  // pipeline early-returns as nothing-to-do. The passive lane never performs
  // a visible correction.
  useLayoutEffect(() => {
    if (!controller.isActivationRequired) return
    if (controller.currentPhase !== 'idle') return
    if (controller.programmaticOwned) return
    if (unmountedRef.current) return
    const tidForPre = topic.id
    const routeForPre = activeBranchId
    if (topicIdRef.current !== tidForPre || routeRef.current !== routeForPre) return
    const displayedForPre = controller.displayedRoute
    if (displayedForPre.topicId !== tidForPre || displayedForPre.route !== routeForPre) return
    if (deletionFallbackIntent && deletionFallbackIntent.route === routeForPre) return
    if (shouldTopPipelineRefuseDividerIntent(controller, tidForPre, routeForPre)) return
    // Target-owned snapshot read (mirrors the TOP pipeline below: storage by
    // target key, retained live-anchor preference when proven same-route).
    // After a detach the live anchor is cleared, so this is the persisted
    // snapshot — never hidden geometry, never outgoing position.
    let savedForPre: {
      scrollTop: number
      anchorId: string | null
      messageId?: string | null
      intraRowOffset?: number | null
      rawScrollTop?: number
      isAtBottom: boolean
    } | null = null
    try {
      const rawForPre =
        readTargetSnapshot(tidForPre, routeForPre) ?? (routeForPre === null ? getLegacyMainSavedPosition() : null)
      const recForPre = (rawForPre ?? null) as {
        scrollTop: number
        anchorId?: string | null
        messageId?: string | null
        intraRowOffset?: number | null
        rawScrollTop?: number
        isAtBottom: boolean
      } | null
      savedForPre = recForPre
        ? {
            scrollTop: recForPre.scrollTop,
            anchorId: recForPre.messageId ?? recForPre.anchorId ?? null,
            messageId: recForPre.messageId ?? null,
            intraRowOffset: recForPre.intraRowOffset ?? null,
            rawScrollTop: recForPre.rawScrollTop ?? recForPre.scrollTop,
            isAtBottom: recForPre.isAtBottom
          }
        : null
    } catch {
      return
    }
    const retainedLiveForPre = controller.getAnchorFor({ topicId: tidForPre, route: routeForPre })
    const useRetainedForPre =
      retainedLiveForPre !== null &&
      retainedLiveForPre.kind === 'message' &&
      controller.displayedRoute.topicId === tidForPre &&
      controller.displayedRoute.route === routeForPre
    if (useRetainedForPre && retainedLiveForPre.kind === 'message') {
      savedForPre = {
        scrollTop: typeof savedForPre?.scrollTop === 'number' ? savedForPre.scrollTop : 0,
        anchorId: retainedLiveForPre.messageId,
        messageId: retainedLiveForPre.messageId,
        intraRowOffset: retainedLiveForPre.offset,
        rawScrollTop: typeof savedForPre?.rawScrollTop === 'number' ? savedForPre.rawScrollTop : 0,
        isAtBottom: false
      }
    }
    const anchorForPre = canonicalSavedAnchorId(savedForPre)
    const wantOffsetForPre =
      typeof savedForPre?.intraRowOffset === 'number' && Number.isFinite(savedForPre.intraRowOffset)
        ? savedForPre.intraRowOffset
        : null
    const retainedWindowForPre = viewportStateRef.current.window
    const retainedIdsForPre = new Set((retainedWindowForPre?.displayMessages ?? []).map((m) => m.id))
    const loadedIdsForPre = new Set(messagesRef.current.map((m) => m.id))
    const admittedForPre = shouldContinueRetainedViewport({
      wasActivation: true,
      selectedTopicId: tidForPre,
      selectedRoute: routeForPre,
      displayedTopicId: displayedForPre.topicId,
      displayedRoute: displayedForPre.route,
      deletionPending: false,
      hasRetainedWindow: (retainedWindowForPre?.displayMessages.length ?? 0) > 0,
      canonicalAnchor: anchorForPre,
      isAtBottom: !!savedForPre?.isAtBottom,
      retainedContainsAnchor: anchorForPre ? retainedIdsForPre.has(anchorForPre) : false,
      loadedContainsAnchor: anchorForPre ? loadedIdsForPre.has(anchorForPre) : false,
      domAnchorResident: anchorForPre ? getMessageRowById(anchorForPre) !== null : true,
      wantOffsetFinite: wantOffsetForPre !== null
    })
    if (!admittedForPre || !retainedWindowForPre || (retainedWindowForPre.displayMessages.length ?? 0) === 0) {
      return
    }
    const liveForPre = scrollContainerRef.current
    const widForPre = windowIdentityKey(retainedWindowForPre)
    if (!liveForPre || !widForPre) return
    // Disconnected/hidden guard (same existing predicate as capture + passive):
    // never consume the activation while the container is detached or under an
    // actual display:none ancestor. visibility:hidden stays measurable (the
    // helper ignores it) so the hidden-but-measurable restore remains allowed.
    // Declines with no side effects — no epoch opened, no snapshot touched.
    try {
      if (isCaptureContainerHidden(liveForPre)) return
    } catch {
      return
    }
    // Single shared pre-paint geometry gate (1px production epsilon): exact
    // means zero writes; covered mismatch gets one synchronous correction +
    // immediate remeasure here, still before paint and still revealed. Any
    // unmeasurable/unverified geometry declines with no side effects (the
    // helper's failed write is the only scroll touch, and it falls through
    // to the hidden restore below — never a fictional aligned commit).
    let alignedForPre = false
    try {
      const rowElForPre = anchorForPre ? getMessageRowById(anchorForPre) : null
      const isRowVisibleForPre = anchorForPre ? checkElement(anchorForPre) === 'visible' : true
      const alignForPre = alignRetainedViewportOnce({
        container: liveForPre,
        rowEl: rowElForPre,
        anchorId: anchorForPre,
        wantOffset: wantOffsetForPre,
        isAtBottom: !!savedForPre?.isAtBottom,
        isRowVisible: isRowVisibleForPre
      })
      alignedForPre = alignForPre.aligned
    } catch {
      alignedForPre = false
    }
    if (!alignedForPre) return
    // Commit synchronously pre-paint: fresh epoch, validate, reveal, stabilize.
    // No window dispatch, no plan, no scroll token, no rAF — the keeper
    // re-resolves via the version notify inside the commit helpers.
    saveDisplayedSnapshot()
    const preEpoch =
      adoptFetchHold(tidForPre, routeForPre) ??
      beginFetchHold(tidForPre, routeForPre, {
        kind: 'top',
        saved: useRetainedForPre
          ? {
              scrollTop: savedForPre?.scrollTop ?? 0,
              messageId: savedForPre?.messageId ?? null,
              intraRowOffset: savedForPre?.intraRowOffset ?? null,
              isAtBottom: false
            }
          : undefined
      })
    if (routeFetchEpochRef.current !== null && controller.isSessionCurrent(routeFetchEpochRef.current)) return
    routeFetchEpochRef.current = preEpoch
    if (!controller.validateRetainedContinuation(preEpoch, { topicId: tidForPre, route: routeForPre }, widForPre)) {
      failVisibleTransition(preEpoch)
      return
    }
    let preRevealed = false
    try {
      preRevealed = controller.revealed(preEpoch)
    } catch {
      preRevealed = false
    }
    if (!preRevealed || !controller.isSessionCurrent(preEpoch)) {
      if (controller.isSessionCurrent(preEpoch)) {
        failVisibleTransition(preEpoch)
      }
      return
    }
    const preCommitted = anchorForPre
      ? commitDisplayedStableWithAnchor(tidForPre, routeForPre, preEpoch, anchorForPre, wantOffsetForPre)
      : commitDisplayedStable(tidForPre, routeForPre, preEpoch)
    if (!preCommitted && controller.isSessionCurrent(preEpoch)) {
      failVisibleTransition(preEpoch)
    }
  }, [
    viewportConnectionGeneration,
    topic.id,
    activeBranchId,
    controller,
    deletionFallbackIntent,
    readTargetSnapshot,
    getLegacyMainSavedPosition,
    saveDisplayedSnapshot,
    adoptFetchHold,
    beginFetchHold,
    failVisibleTransition,
    commitDisplayedStable,
    commitDisplayedStableWithAnchor,
    checkElement,
    windowIdentityKey
  ])
  useEffect(() => {
    // Disconnected lifetime (Activity hidden cleanup ran, show setup not yet
    // re-run): stay inert without consuming the armed activation. The show's
    // pre-paint layout effect above owns the single validated continuation
    // before first paint; consuming here while disconnected would force a
    // hidden first paint. Mirrors the pre-paint `unmountedRef` guard.
    if (unmountedRef.current) return
    if (topic.id !== topicIdRef.current) return
    // Deletion-fallback intents own their route: the dedicated latest effect
    // above claims and reloads. Never issue a concurrent snapshot-around here.
    if (deletionFallbackIntent && deletionFallbackIntent.route === activeBranchId) return
    // Single-entry reconnect activation (Activity Chat→Settings→Chat):
    // the provider `detach()` armed `isActivationRequired` while preserving
    // displayed + cache + persisted snapshots. The strict pre-paint layout
    // effect above may already have consumed the activation (validated exact
    // continuation → stable); when it did, the nothing-to-do guard below
    // returns immediately. Otherwise THIS effect opens the guarded own-target
    // `top` fetch-hold below AND drives fetch → window →
    // measured layout/quiet/alignment → atomic reveal → stable commit — never
    // a separate hook half-start (prior split consumed the flag in another
    // effect at routeViewportActivation.ts:112, then this loader could skip
    // and leave the latest window msg00 instead of the saved anchor msg14).
    // Same-selected-route reconnect is a real activation even though the
    // route key is unchanged: it must enter the guarded own-target
    // restoration below — never trust the loaded claim and never falsely mark
    // provenance stable (`rebaseClean` refuses while armed). Only a clean
    // displayed-stable viewport with NO pending activation truly has nothing
    // to do; every other loaded-current state falls through. An owned fresh
    // reconnect (flag just consumed by THIS effect's own request) still loads
    // — consumed-false is never confused with restored-true. Terminal never
    // auto-retries: a terminal session needs an explicit route/connection
    // trigger, never a progress reentry.
    const wasActivation = controller.isActivationRequired
    if (!wasActivation) {
      // Terminal no-retry (fail-closed): a released terminal viewport stays
      // until the next genuine selected/connection trigger.
      if (controller.currentPhase === 'terminal') return
      if (isLoadedRouteCurrent(loadedRouteRef.current, activeBranchId)) {
        if (controller.isDomProvenanceClean) return
      }
    }
    const topicIdAtEffect = topic.id
    const routeAtEffect = activeBranchId
    // Single-pipeline guard: a transition for this exact target already owns
    // the controller. Adopt a fetch-hold session to drive the pipeline;
    // when the pipeline is already driving (beyond fetch-hold) or already
    // completed (displayed stable on target), never open a duplicate fetch
    // pipeline, which would ping-pong epochs with the running one. A dirty
    // (detached) viewport never counts as completed — it must reconnect.
    const liveIntent = controller.currentIntent
    // Explicit TOP intent isolation (narrow): a divider-owned session for this
    // exact target owns its clicked-offset continuation. The TOP pipeline
    // never consumes that epoch nor overwrites it with a saved-snapshot plan
    // during a divider fetch-hold + route/version rerun. Foreign-target
    // divider sessions proceed normally; top/generic/bootstrap unaffected.
    // Shared `commitRouteWindowAtomic` stays generic (divider hidden fallback
    // uses it).
    if (shouldTopPipelineRefuseDividerIntent(controller, topicIdAtEffect, routeAtEffect)) return
    if (
      liveIntent !== null &&
      liveIntent.topicId === topicIdAtEffect &&
      liveIntent.targetRoute === routeAtEffect &&
      controller.programmaticOwned &&
      controller.currentPhase !== 'fetch-hold'
    ) {
      return
    }
    if (
      !controller.programmaticOwned &&
      controller.displayedRoute.topicId === topicIdAtEffect &&
      controller.displayedRoute.route === routeAtEffect &&
      (controller.currentPhase === 'stable' || controller.currentPhase === 'idle') &&
      controller.isDomProvenanceClean
    ) {
      return
    }
    // NOTE: no outgoing `vicinityIds` fallback — the target window is read
    // from the NEW route's own snapshot (around) or its deterministic
    // route-local default (latest + tail). Outgoing IDs never position the
    // target.
    // Read the NEW route's own route-saved-row-anchor snapshot via the
    // explicit target key (never the hook's current key while old DOM
    // remains; legacy topic-only key as main-route fallback). Never save
    // the target here — the OLD (displayed) route is frozen below and the
    // target snapshot must never be overwritten by this path.
    let saved: {
      scrollTop: number
      anchorId: string | null
      messageId?: string | null
      intraRowOffset?: number | null
      rawScrollTop?: number
      isAtBottom: boolean
    } | null = null
    try {
      const raw =
        readTargetSnapshot(topicIdAtEffect, routeAtEffect) ??
        (routeAtEffect === null ? getLegacyMainSavedPosition() : null)
      // Normalize the controller snapshot shape (no anchorId/rawScrollTop)
      // to the storage snapshot shape consumed below.
      const asRecord = (raw ?? null) as {
        scrollTop: number
        anchorId?: string | null
        messageId?: string | null
        intraRowOffset?: number | null
        rawScrollTop?: number
        isAtBottom: boolean
      } | null
      saved = asRecord
        ? {
            scrollTop: asRecord.scrollTop,
            anchorId: asRecord.messageId ?? asRecord.anchorId ?? null,
            messageId: asRecord.messageId ?? null,
            intraRowOffset: asRecord.intraRowOffset ?? null,
            rawScrollTop: asRecord.rawScrollTop ?? asRecord.scrollTop,
            isAtBottom: asRecord.isAtBottom
          }
        : null
    } catch {
      saved = null
    }
    // Rapid-return retained anchor (A→B→A where the intermediate B never
    // displayed): route-qualified read only — the live anchor is observable
    // here solely when its provenance already equals the incoming target
    // (proven same-route). A foreign live anchor (B provenance while
    // requesting A) returns null and the target's own persisted snapshot
    // wins. Never infer route from displayed alone.
    const retainedLiveAnchor = controller.getAnchorFor({ topicId: topicIdAtEffect, route: routeAtEffect })
    const useRetainedAnchor =
      retainedLiveAnchor !== null &&
      retainedLiveAnchor.kind === 'message' &&
      controller.displayedRoute.topicId === topicIdAtEffect &&
      controller.displayedRoute.route === routeAtEffect
    if (useRetainedAnchor && retainedLiveAnchor.kind === 'message') {
      saved = {
        scrollTop: typeof saved?.scrollTop === 'number' ? saved.scrollTop : 0,
        anchorId: retainedLiveAnchor.messageId,
        messageId: retainedLiveAnchor.messageId,
        intraRowOffset: retainedLiveAnchor.offset,
        rawScrollTop: typeof saved?.rawScrollTop === 'number' ? saved.rawScrollTop : 0,
        isAtBottom: false
      }
    }
    // Retained-projection-first reactivation (page resume, same route):
    // when the retained window demonstrably covers the requested stable
    // anchor against the current renderer-owned window + loaded projection +
    // connected DOM, restore it in place with a fresh guarded epoch and no
    // windowed fetch — row DOM identities survive, no reload. Every other
    // shape (missing anchor, changed route, deletion, anchorless non-bottom)
    // falls through to the existing full fetch/rebuild below. Divider-owned
    // sessions already refused above and never reach here.
    if (wasActivation) {
      // Validated continuation lives ONLY in the pre-paint layout effect above
      // (single shared 1px geometry helper + immediate remeasure, still
      // revealed, still synchronous). This ordinary passive effect never
      // performs a visible correction: an unguarded passive scroll write could
      // paint a corrected frame after Home is already visible. When pre-paint
      // declines, this lane falls through to the existing hidden measurable
      // restore below (never a wrong visible frame, never a fictional commit).
      // Hidden-lifetime guard: while Home is hidden the container has no
      // measurable layout (display:none rects). Stay inert here without
      // consuming the activation (no epoch, no snapshot, no scroll) so the
      // show's pre-paint layout effect owns the single validated continuation
      // before first paint; consuming now would force a hidden first paint.
      // Uses the existing capture predicate (detached / actual display:none /
      // hidden ancestor) plus the measurable-rect gate; visibility:hidden
      // stays measurable on purpose (hidden-but-measurable restore allowed).
      try {
        const liveForGate = scrollContainerRef.current
        if (!liveForGate) return
        try {
          if (isCaptureContainerHidden(liveForGate)) return
        } catch {
          return
        }
        const gateRect = liveForGate.getBoundingClientRect()
        if (
          !Number.isFinite(gateRect.width) ||
          !Number.isFinite(gateRect.height) ||
          gateRect.width <= 0 ||
          gateRect.height <= 0 ||
          !Number.isFinite(liveForGate.clientHeight) ||
          liveForGate.clientHeight <= 0
        ) {
          return
        }
      } catch {
        return
      }
      try {
        const retainedWindow = viewportStateRef.current.window
        const retainedIds = new Set((retainedWindow?.displayMessages ?? []).map((m) => m.id))
        const loadedList = messagesRef.current
        const loadedIds = new Set(loadedList.map((m) => m.id))
        const anchorForInPlace = canonicalSavedAnchorId(saved)
        const displayedAtEffect = controller.displayedRoute
        const domResidentForInPlace = anchorForInPlace ? getMessageRowById(anchorForInPlace) !== null : true
        const inPlaceEligible = shouldRestoreRetainedWindowInPlace({
          wasActivation,
          selectedTopicId: topicIdAtEffect,
          selectedRoute: routeAtEffect,
          displayedTopicId: displayedAtEffect.topicId,
          displayedRoute: displayedAtEffect.route,
          deletionPending: !!(deletionFallbackIntent && deletionFallbackIntent.route === routeAtEffect),
          hasRetainedWindow: (retainedWindow?.displayMessages.length ?? 0) > 0,
          canonicalAnchor: anchorForInPlace,
          isAtBottom: !!saved?.isAtBottom,
          retainedContainsAnchor: anchorForInPlace ? retainedIds.has(anchorForInPlace) : false,
          loadedContainsAnchor: anchorForInPlace ? loadedIds.has(anchorForInPlace) : false,
          domAnchorResident: domResidentForInPlace
        })
        if (inPlaceEligible && retainedWindow && (retainedWindow.displayMessages.length ?? 0) > 0) {
          saveDisplayedSnapshot()
          const inPlaceEpoch =
            adoptFetchHold(topicIdAtEffect, routeAtEffect) ??
            beginFetchHold(topicIdAtEffect, routeAtEffect, {
              kind: 'top',
              saved: useRetainedAnchor
                ? {
                    scrollTop: saved?.scrollTop ?? 0,
                    messageId: saved?.messageId ?? null,
                    intraRowOffset: saved?.intraRowOffset ?? null,
                    isAtBottom: false
                  }
                : undefined
            })
          if (routeFetchEpochRef.current !== null && controller.isSessionCurrent(routeFetchEpochRef.current)) {
            return
          }
          routeFetchEpochRef.current = inPlaceEpoch
          // The retained projection is already the loaded route: never reclaim
          // `loadedRouteRef` here (already current) and never drop the
          // per-route window cache for a path that issues no fetch.
          const inPlacePlan = chooseTopFirstPositionPlan({
            saved,
            snapshotInvalidForRoute: false,
            routeSavedRowAnchor: anchorForInPlace
          })
          const inPlaceRestoreEpoch = commitRouteWindowAtomic(
            inPlaceEpoch,
            topicIdAtEffect,
            routeAtEffect,
            retainedWindow,
            inPlacePlan
          )
          if (inPlaceRestoreEpoch === null) {
            failVisibleTransition(inPlaceEpoch)
            return
          }
          // Hidden settle only (never first placement — the layout effect
          // places pre-paint while hidden): fold-reveal when hidden, bounded
          // projection wait, direct compensation to the saved offset/bottom,
          // then the ONE identity-stable commit. Stale paths fail visible and
          // preserve the prior snapshot; no snapshot is invented here.
          void (async () => {
            const stillInPlaceTarget = (): boolean =>
              isRestoreTargetValid({
                topicMatch: topicIdRef.current === topicIdAtEffect,
                routeMatch: routeRef.current === routeAtEffect,
                mounted: !unmountedRef.current,
                epochCurrent: controller.currentEpoch === inPlaceRestoreEpoch
              })
            // Placement ack: the retained plan places pre-paint while hidden
            // (driven by the reactive plan generation even though the window
            // object is unchanged) — the hidden settle below must not run
            // before that attempt is observed.
            const inPlacePlacementObserved = await awaitPlanPlacement(inPlaceRestoreEpoch, stillInPlaceTarget)
            if (!inPlacePlacementObserved) {
              failVisibleTransition(inPlaceRestoreEpoch)
              return
            }
            try {
              if (anchorForInPlace) {
                try {
                  if (checkElement(anchorForInPlace) === 'hidden') {
                    await selectMessageForFold(anchorForInPlace)
                  }
                } catch {
                  // fail-closed: commit gate below still verifies residency
                }
                if (!stillInPlaceTarget()) {
                  failVisibleTransition(inPlaceRestoreEpoch)
                  return
                }
                try {
                  const projectionReady = await waitForProjectionCommit(anchorForInPlace, () => !stillInPlaceTarget())
                  if (!projectionReady) {
                    failVisibleTransition(inPlaceRestoreEpoch)
                    return
                  }
                } catch {
                  failVisibleTransition(inPlaceRestoreEpoch)
                  return
                }
                if (!stillInPlaceTarget()) {
                  failVisibleTransition(inPlaceRestoreEpoch)
                  return
                }
                const wantInPlaceOffset =
                  typeof saved?.intraRowOffset === 'number' && Number.isFinite(saved.intraRowOffset)
                    ? saved.intraRowOffset
                    : null
                const inPlaceLive = scrollContainerRef.current
                if (inPlaceLive && wantInPlaceOffset !== null) {
                  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
                  if (!stillInPlaceTarget()) {
                    failVisibleTransition(inPlaceRestoreEpoch)
                    return
                  }
                  const settleInPlaceOnce = (): boolean => {
                    try {
                      const el = getMessageRowById(anchorForInPlace)
                      if (!el || !stillInPlaceTarget()) return false
                      const have = el.getBoundingClientRect().top - inPlaceLive.getBoundingClientRect().top
                      const delta = have - wantInPlaceOffset
                      if (Math.abs(delta) > 1) inPlaceLive.scrollTop += delta
                      return true
                    } catch {
                      return false
                    }
                  }
                  settleInPlaceOnce()
                  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
                  if (!stillInPlaceTarget()) {
                    failVisibleTransition(inPlaceRestoreEpoch)
                    return
                  }
                  settleInPlaceOnce()
                }
              } else {
                // Anchorless bottom: already at bottom pre-paint; settle one
                // frame so late layout lands before the stable commit.
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
              }
            } catch {
              // fail-closed: commit gate below still verifies currency
            } finally {
              // Deferred activation reveal (F2): the layout effect placed
              // pre-paint while hidden and deliberately skipped `revealed()`.
              // Reveal here only after the hidden settle verified effective
              // alignment + projection coverage + required layout settle
              // (fold-reveal + projection wait + direct compensation above,
              // residency re-proven below). Stale epochs never reveal: the
              // session-current gate plus `revealed()`'s own epoch guard keep
              // old completions inert so they can never reveal/release the new
              // transaction. Terminal fail-visible preserves the prior
              // snapshot (no snapshot invented here).
              if (controller.isSessionCurrent(inPlaceRestoreEpoch)) {
                if (anchorForInPlace) {
                  let projectionContains = false
                  try {
                    projectionContains = messagesRef.current.some((m) => m.id === anchorForInPlace)
                  } catch {
                    projectionContains = false
                  }
                  let domConnected = false
                  try {
                    domConnected = getMessageRowById(anchorForInPlace) !== null
                  } catch {
                    domConnected = false
                  }
                  if (
                    !isTopStableCommittable({
                      isAtBottom: !!saved?.isAtBottom,
                      snapshotInvalidForRoute: false,
                      requestedAnchor: anchorForInPlace,
                      projectionContains,
                      domConnected
                    })
                  ) {
                    failVisibleTransition(inPlaceRestoreEpoch)
                    return
                  }
                  let inPlaceRevealed = false
                  try {
                    inPlaceRevealed = controller.revealed(inPlaceRestoreEpoch)
                  } catch {
                    inPlaceRevealed = false
                  }
                  // Bounded rejection: a CURRENT owner's rejected reveal must
                  // not stay hidden (fail-visible preserving snapshot/release
                  // once); a stale owner's failure is inert and never
                  // terminates the new session.
                  if (!inPlaceRevealed) {
                    if (controller.isSessionCurrent(inPlaceRestoreEpoch)) {
                      failVisibleTransition(inPlaceRestoreEpoch)
                    }
                    return
                  }
                  if (!controller.isSessionCurrent(inPlaceRestoreEpoch)) {
                    return
                  }
                  const identityOffset =
                    typeof saved?.intraRowOffset === 'number' && Number.isFinite(saved.intraRowOffset)
                      ? saved.intraRowOffset
                      : null
                  const inPlaceCommitted = commitDisplayedStableWithAnchor(
                    topicIdAtEffect,
                    routeAtEffect,
                    inPlaceRestoreEpoch,
                    anchorForInPlace,
                    identityOffset
                  )
                  if (!inPlaceCommitted) {
                    if (controller.isSessionCurrent(inPlaceRestoreEpoch)) {
                      failVisibleTransition(inPlaceRestoreEpoch)
                    }
                    return
                  }
                } else {
                  // Anchorless bottom: the deferred reveal lands here too —
                  // pre-paint stayed hidden, one settle frame ran above, and
                  // displayed advances only now, immediately before stable.
                  let inPlaceBottomRevealed = false
                  try {
                    inPlaceBottomRevealed = controller.revealed(inPlaceRestoreEpoch)
                  } catch {
                    inPlaceBottomRevealed = false
                  }
                  if (!inPlaceBottomRevealed) {
                    if (controller.isSessionCurrent(inPlaceRestoreEpoch)) {
                      failVisibleTransition(inPlaceRestoreEpoch)
                    }
                    return
                  }
                  if (!controller.isSessionCurrent(inPlaceRestoreEpoch)) {
                    return
                  }
                  const inPlaceBottomCommitted = commitDisplayedStable(
                    topicIdAtEffect,
                    routeAtEffect,
                    inPlaceRestoreEpoch
                  )
                  if (!inPlaceBottomCommitted) {
                    if (controller.isSessionCurrent(inPlaceRestoreEpoch)) {
                      failVisibleTransition(inPlaceRestoreEpoch)
                    }
                    return
                  }
                }
              }
            }
          })()
          return
        }
      } catch {
        // fail-closed: fall through to the full fetch/rebuild below
      }
    }
    // Outgoing freeze (idempotent when the selector already saved) + fetch
    // hold before any fetch: the outgoing viewport stays visible and no
    // write may land under the incoming identity. Dropped-while-owned saves
    // preserve the existing stable snapshot (transients never captured).
    // Adopt the selector's in-flight top session when present (same epoch,
    // same target) so exactly one session owns the transition; otherwise
    // open a top session reading the target's own snapshot.
    saveDisplayedSnapshot()
    const fetchEpoch =
      adoptFetchHold(topicIdAtEffect, routeAtEffect) ??
      beginFetchHold(topicIdAtEffect, routeAtEffect, {
        kind: 'top',
        saved: useRetainedAnchor
          ? {
              scrollTop: saved?.scrollTop ?? 0,
              messageId: saved?.messageId ?? null,
              intraRowOffset: saved?.intraRowOffset ?? null,
              isAtBottom: false
            }
          : undefined
      })
    // Same-session duplicate run (effect re-invoked while this session's
    // fetch is in flight): the running pipeline owns it — never start a
    // second one on the same epoch. Stale markers are harmless: a new
    // target/epoch fails the currency check and proceeds.
    if (routeFetchEpochRef.current !== null && controller.isSessionCurrent(routeFetchEpochRef.current)) return
    routeFetchEpochRef.current = fetchEpoch
    loadedRouteRef.current = claimLoadedRoute(activeBranchId)
    cancelActiveLoads()
    // Incremental: keep the current viewport during the windowed fetch (no
    // topic/reset blank). Only the per-route window cache is dropped.
    windowCacheRef.current.clear()
    void (async () => {
      // Exclusive-anchor restore contract (route-local stable viewport):
      // - Canonical saved anchor is `messageId` (legacy `anchorId` fallback).
      // - Valid anchor → around it; the returned window/projection must
      //   contain it before any placement/stable commit. A delayed
      //   projection/DOM commit is awaited (bounded); never an immediate
      //   vicinity/tail/raw fallback.
      // - Typed NOT_FOUND/out-of-route/deleted → saved snapshot invalid for
      //   this route: explicit route-local terminal default (latest). Only
      //   after that default is placed/stable may it replace the stale
      //   snapshot.
      // - Transport/load failure or supersession → fail visible, preserve the
      //   prior snapshot; uncertainty never becomes a new stable fallback.
      // The current window API guarantees anchor containment on around
      // success for the addressed effective route (branch: effective
      // findIndex; main: owner-equality check), so no restore-owned expansion
      // search is needed beyond the containment gate below — a missing anchor
      // in a successful around response is malformed and fails visible.
      const isNotFoundError = isTopRestoreNotFoundError
      const canonicalAnchor = canonicalSavedAnchorId(saved)
      let routeWindow: FetchMessagesWindowResponse | void
      let snapshotInvalidForRoute = false
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
          } catch (aroundError) {
            // Superseded before classification: fail visible, keep snapshot.
            if (topicIdRef.current !== topicIdAtEffect || routeRef.current !== routeAtEffect) {
              failVisibleTransition(fetchEpoch)
              return
            }
            if (isNotFoundError(aroundError)) {
              // Saved snapshot invalid for this route (deleted/out-of-route):
              // explicit terminal default. The stale snapshot is replaced
              // only by the stable commit of that default below.
              snapshotInvalidForRoute = true
              routeWindow = await dispatch(loadRouteMessagesThunk(topicIdAtEffect, routeAtEffect, { kind: 'latest' }))
            } else {
              // Environmental/transport failure: preserve the prior snapshot.
              throw aroundError
            }
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
        if (!externalRecovery.shouldClear) {
          failVisibleTransition(fetchEpoch)
          return
        }
        try {
          dispatch(newMessagesActions.rebaseRouteMessages({ topicId: topicIdAtEffect, messages: [] }))
        } catch {
          // fail-closed: viewport clear below still removes visible residual
        }
        loadedRouteRef.current = markLoadedRouteFailed(routeAtEffect)
        try {
          const emptyWindow = createLatestMessageWindow([], 1, { hasMoreBefore: false, hasMoreAfter: false })
          viewportDispatch({ type: 'window/apply', window: emptyWindow })
          // Failure clear: the DOM no longer belongs to any route — mark
          // rendered unknown (dirty) so no freeze/write can proceed until a
          // successful target rebase. Ownership release alone never reopens.
          try {
            controller.markRenderedUnknown()
          } catch {
            // fail-closed
          }
        } catch {
          // fail-closed: loaded projection already cleared above
        }
        failVisibleTransition(fetchEpoch)
        return
      }
      if (topicIdRef.current !== topicIdAtEffect || routeRef.current !== routeAtEffect) {
        failVisibleTransition(fetchEpoch)
        return
      }
      try {
        // Superseded/void reads never publish: fail visible, keep snapshot.
        if (!routeWindow || !routeWindow.window) {
          failVisibleTransition(fetchEpoch)
          loadedRouteRef.current = markLoadedRouteFailed(routeAtEffect)
          return
        }
        const loaded = (selectLoadedMessagesForTopic(store.getState(), topicIdAtEffect) ?? []) as Message[]
        const loadedIds = new Set(loaded.map((m) => m.id))
        // Requested-anchor coverage gate: a valid saved anchor must be in
        // both the returned window and the rebased projection. Partial
        // windows are valid only when they cover the anchor; full route
        // materialization is never required.
        if (canonicalAnchor && !snapshotInvalidForRoute) {
          const windowIds = new Set((routeWindow.messages ?? []).map((m) => (m as { id: string }).id))
          if (!windowIds.has(canonicalAnchor) || !loadedIds.has(canonicalAnchor)) {
            logger.error('[routeInvalidation] around window omits the requested anchor', {
              window: routeWindow.window
            } as unknown as Error)
            loadedRouteRef.current = markLoadedRouteFailed(routeAtEffect)
            failVisibleTransition(fetchEpoch)
            return
          }
        }
        // Route-saved-row-anchor (pure decision helper): canonical messageId
        // with legacy anchorId alias; contextAnchor never feeds this. Valid
        // snapshots never fall to vicinity/tail/raw. Empty routes atomically
        // clear (no old-route residual).
        const anchorDecision = decideTopRestoreAnchor({
          canonicalAnchor,
          snapshotInvalidForRoute,
          loadedIds
        })
        if (anchorDecision.mustFailVisible) {
          loadedRouteRef.current = markLoadedRouteFailed(routeAtEffect)
          failVisibleTransition(fetchEpoch)
          return
        }
        const routeSavedRowAnchor = anchorDecision.routeSavedRowAnchor
        if (canonicalAnchor && !snapshotInvalidForRoute && !routeSavedRowAnchor) {
          loadedRouteRef.current = markLoadedRouteFailed(routeAtEffect)
          failVisibleTransition(fetchEpoch)
          return
        }
        const anchor = routeSavedRowAnchor ?? null
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
        let armedTopEpoch: number | null = null
        // Hidden first-position plan, computed BEFORE the visible attempt so
        // the same plan object serves as the single-use hidden fallback
        // payload when the visible union arms (no second plan, no second
        // truth). `wantOffset` below is the hidden path's own saved offset.
        const wantOffset =
          typeof saved?.intraRowOffset === 'number' && Number.isFinite(saved.intraRowOffset)
            ? saved.intraRowOffset
            : null
        const firstPlan: ViewportFirstPositionPlan = chooseTopFirstPositionPlan({
          saved,
          snapshotInvalidForRoute,
          routeSavedRowAnchor
        })
        if (targetWindow) {
          // Top-only visible incremental rebase (fast path, never hidden):
          // shared route-overlap materializer — the preserved chain is the
          // current resident prefix through the saved anchor (which may begin
          // earlier than the target around-window head), verified continuous
          // against the authoritative target response; only the target
          // window's ordered exclusive suffix is appended and the outgoing
          // foreign suffix is removed. The union window covers the preserved
          // prefix plus the suffix exactly, so shared rows keep their mounted
          // DOM nodes and the saved anchor stays at its exact saved offset
          // via the layout compensation below. Any eligibility doubt falls
          // through to the hidden atomic path unchanged (nonresident/
          // exclusive anchor, incomplete projection, need-older-pagination,
          // union-trim/uncovered anchors, unmeasurable offset, folded row, or
          // empty incoming suffix). Numeric-leading UUID/special IDs are
          // supported (raw-ID DOM lookup, never a selector escape).
          // Reconnect activation (wasActivation) never takes the visible fast
          // path: retained display:none geometry on the first frame is not
          // valid until explicit stable alignment — hidden atomic restore only.
          if (routeSavedRowAnchor && !snapshotInvalidForRoute && !wasActivation) {
            try {
              const savedOffset =
                typeof saved?.intraRowOffset === 'number' && Number.isFinite(saved.intraRowOffset)
                  ? saved.intraRowOffset
                  : null
              const domRow = getMessageRowById(routeSavedRowAnchor)
              const rowVisible = (() => {
                try {
                  return checkElement(routeSavedRowAnchor) === 'visible'
                } catch {
                  return domRow !== null
                }
              })()
              if (savedOffset !== null && domRow !== null && rowVisible) {
                const currentWindow = viewportStateRef.current.window
                const currentIdsNewestFirst = currentWindow?.displayMessages?.map((m) => m.id) ?? []
                const targetIdsNewestFirst = targetWindow.displayMessages?.map((m) => m.id) ?? []
                const responseIds = ((routeWindow.messages ?? []) as unknown as Message[]).map((m) => m.id)
                const toOldestFirst = (newestFirst: string[]): string[] => [...newestFirst].reverse()
                const topPlan = planTopVisibleRebase({
                  currentIdsOldestFirst: toOldestFirst(currentIdsNewestFirst),
                  targetResponseIdsOldestFirst: responseIds,
                  targetWindowIdsOldestFirst: toOldestFirst(targetIdsNewestFirst),
                  anchorId: routeSavedRowAnchor,
                  currentHasMoreBefore: currentWindow?.hasMoreOlder ?? false,
                  targetHasMoreAfter: targetWindow.hasMoreNewer,
                  loadedIds
                })
                if (topPlan) {
                  const unionNewestFirst = buildRouteVisibleMessages(
                    currentWindow?.displayMessages ?? [],
                    loaded,
                    topPlan
                  )
                  const unionOldestFirst = [...unionNewestFirst].reverse()
                  const unionModel = createMessageViewportGroupModel(unionOldestFirst)
                  const unionAnchorGroup = unionModel.messageIdToGroup.get(routeSavedRowAnchor)
                  const unionAnchorGroupIndex = unionAnchorGroup ? unionModel.groups.indexOf(unionAnchorGroup) : -1
                  if (unionAnchorGroupIndex >= 0) {
                    const unionWindow = createTargetMessageWindow(
                      unionOldestFirst,
                      routeSavedRowAnchor,
                      unionAnchorGroupIndex + 1,
                      unionModel.groups.length - unionAnchorGroupIndex - 1,
                      { hasMoreBefore: topPlan.hasMoreBefore, hasMoreAfter: topPlan.hasMoreAfter }
                    )
                    const unionExact = isRouteVisibleUnionExact({
                      plan: topPlan,
                      unionOldestFirst,
                      unionNewestFirst,
                      unionWindow,
                      unionModelGroupCount: unionModel.groups.length
                    })
                    if (unionExact && (unionWindow.displayMessages?.length ?? 0) > 0) {
                      const visibleEpoch = commitTopVisibleAtomic(
                        fetchEpoch,
                        topicIdAtEffect,
                        routeAtEffect,
                        unionWindow,
                        { anchorMessageId: routeSavedRowAnchor, wantOffset: savedOffset }
                      )
                      if (visibleEpoch !== null) {
                        // Visible path armed: stash the already-materialized
                        // authoritative hidden target + plan as the single-use
                        // same-epoch fallback (transient attempt data, not a
                        // second controller truth). Post-apply proof loss
                        // rewinds to fetch-hold and commits THIS window/plan
                        // through the existing hidden entry; ownership stays
                        // held until that hidden path settles. The union
                        // window identity is never adopted as hidden proof.
                        topHiddenFallbackRef.current = {
                          ownerEpoch: visibleEpoch,
                          topicId: topicIdAtEffect,
                          routeId: routeAtEffect,
                          targetWindow,
                          firstPlan,
                          anchorMessageId: routeSavedRowAnchor,
                          wantOffset: savedOffset,
                          isAtBottom: !!saved?.isAtBottom
                        }
                        // Visible path armed: the layout effect applies the
                        // first compensation, then the bounded quiet sequence
                        // identity-commits. Skip the hidden stabilizer below
                        // entirely (no positioning, no second commit).
                        return
                      }
                    }
                  }
                }
              }
            } catch {
              // fail-closed: fall through to the hidden path below
            }
          }
          // Atomic route transition: arm hidden-until-positioned together
          // with the target window commit in the same React batch. The old
          // viewport stays visible during the fetch above (incremental);
          // only this commit hides, and the pre-paint layout effect applies
          // the first scroll synchronously before reveal. First placement
          // lives ONLY in that layout effect; the async continuation below
          // runs the bounded stabilizer for post-reveal drift (message
          // restores) or simply releases (bottom/same-route-raw restores).
          // Route-local plans only: valid saved message → message + intra-row
          // offset (even when isAtBottom) with NO missing-row fallback (a
          // missing row with a valid anchor fails visible and preserves the
          // snapshot — intermediate raw geometry never poses as stable);
          // invalid snapshot → deterministic route-local default (`bottom` on
          // the latest window, placed pre-paint then committable after
          // stable); no usable
          // anchor + isAtBottom → bottom; raw-only legacy snapshot
          // (no anchor) → same-route scrollTop; no snapshot → deterministic
          // route-local default (`bottom`). Never outgoing geometry.
          // Provenance-bound atomic commit (single entry): stale epochs
          // refuse with no dispatch, never tearing down the new session.
          const topRestoreEpoch = commitRouteWindowAtomic(
            fetchEpoch,
            topicIdAtEffect,
            routeAtEffect,
            targetWindow,
            firstPlan
          )
          if (topRestoreEpoch === null) {
            failVisibleTransition(fetchEpoch)
            return
          }
          armedTopEpoch = topRestoreEpoch
          // The controller holds the saved message-row anchor from the
          // fetch-hold request (adopted top session); queued pagination
          // snapshots only its stable identity + offset via
          // snapshotPreferredAnchor. Bottom restores carry no row anchor.
          void wantOffset
        }
        // Route-local restore, post-reveal only (never first placement):
        // message → fold-reveal when hidden + bounded stabilizer for late
        // layout drift (even when isAtBottom: exact anchor + offset outranks
        // bottom vicinity); anchorless isAtBottom → already at bottom
        // pre-paint, nothing more; same-route raw scrollTop → already set
        // deterministic bottom default (including the invalid-snapshot
        // path) → already at bottom pre-paint.
        // Target validity is the restore epoch (topic/route/mounted/epoch),
        // never `canHandleUserViewportScroll` (the programmatic token below
        // closes that gate by design and would self-cancel).
        const ownerAtStart = transitionPlanRef.current
        const topRestoreEpoch =
          armedTopEpoch !== null
            ? armedTopEpoch
            : ownerAtStart && ownerAtStart.topicId === topicIdAtEffect && ownerAtStart.routeId === routeAtEffect
              ? ownerAtStart.epoch
              : controller.currentEpoch
        const stillTopTarget = () =>
          isRestoreTargetValid({
            topicMatch: topicIdRef.current === topicIdAtEffect,
            routeMatch: routeRef.current === routeAtEffect,
            mounted: !unmountedRef.current,
            epochCurrent: controller.currentEpoch === topRestoreEpoch
          })
        // Stable-commit gate (pure helper): a valid requested anchor must be
        // covered/resident and post-alignment quiet (stabilizer below) before
        // it may become the route snapshot — even when isAtBottom. Terminal
        // defaults (invalid snapshot) and anchorless bottom restores carry no
        // anchor requirement; an unmet valid anchor fails visible and
        // valid anchor fails visible and preserves the prior snapshot.
        const isTopAnchorCommittable = (): boolean => {
          let projectionContains = false
          try {
            projectionContains = messagesRef.current.some((m) => m.id === (routeSavedRowAnchor as string))
          } catch {
            projectionContains = false
          }
          let domConnected = false
          try {
            if (routeSavedRowAnchor) {
              domConnected = getMessageRowById(routeSavedRowAnchor) !== null
            }
          } catch {
            domConnected = false
          }
          return isTopStableCommittable({
            isAtBottom: !!saved?.isAtBottom,
            snapshotInvalidForRoute,
            requestedAnchor: routeSavedRowAnchor,
            projectionContains,
            domConnected
          })
        }
        try {
          // Placement ack (bounded root repair): the pre-paint layout effect
          // owns first placement; this async completion must not commit or
          // fail before that attempt is observed — a refused-while-
          // `positioning` stable commit would terminate the live plan before
          // it ever placed (branch→main dirty terminal). Stale targets fail
          // visible below exactly as before.
          const placementObserved = await awaitPlanPlacement(topRestoreEpoch, stillTopTarget)
          if (!placementObserved) {
            failVisibleTransition(topRestoreEpoch)
            return
          }
          if (routeSavedRowAnchor && !snapshotInvalidForRoute) {
            const wantOffset =
              typeof saved?.intraRowOffset === 'number' && Number.isFinite(saved.intraRowOffset)
                ? saved.intraRowOffset
                : null
            if (!stillTopTarget()) {
              failVisibleTransition(topRestoreEpoch)
              return
            }
            // Folded targets stay hidden until revealed; reveal first so the
            // keeper measures the real row (transaction scroll itself is
            // skipped — first placement already happened pre-paint).
            try {
              if (checkElement(routeSavedRowAnchor) === 'hidden') {
                await selectMessageForFold(routeSavedRowAnchor)
              }
            } catch {
              // fail-closed: keep the pre-paint vicinity
            }
            if (!stillTopTarget()) {
              failVisibleTransition(topRestoreEpoch)
              return
            }
            // Delayed projection/DOM commit: wait (bounded) for the rebased
            // projection to observably contain the requested anchor before
            // any placement-dependent work. Never fall back immediately —
            // an immediate vicinity/tail commit here would poison the valid
            // unresolved snapshot.
            try {
              const projectionReady = await waitForProjectionCommit(routeSavedRowAnchor, () => !stillTopTarget())
              if (!projectionReady) {
                failVisibleTransition(topRestoreEpoch)
                return
              }
            } catch {
              failVisibleTransition(topRestoreEpoch)
              return
            }
            if (!stillTopTarget()) {
              failVisibleTransition(topRestoreEpoch)
              return
            }
            const live = scrollContainerRef.current
            if (live && wantOffset !== null) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
              if (!stillTopTarget()) {
                failVisibleTransition(topRestoreEpoch)
                return
              }
              // Direct compensation to the saved intra-row offset (single
              // synchronous write, no stabilizer session). The persistent
              // keeper holds this offset across late Markdown/image layout
              // afterwards; the arm's scroll token stays held until the
              // commit below releases it.
              try {
                const settleOnce = (): boolean => {
                  try {
                    const el = getMessageRowById(routeSavedRowAnchor)
                    if (!el || !stillTopTarget()) return false
                    const have = el.getBoundingClientRect().top - live.getBoundingClientRect().top
                    const delta = have - wantOffset
                    if (Math.abs(delta) > 1) live.scrollTop += delta
                    return true
                  } catch {
                    return false
                  }
                }
                settleOnce()
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
                if (!stillTopTarget()) {
                  failVisibleTransition(topRestoreEpoch)
                  return
                }
                settleOnce()
              } catch {
                // fail-closed: commit gate below still verifies residency
              }
            }
          } else if (saved?.isAtBottom) {
            // Anchorless bottom already applied pre-paint; settle one frame
            // so late layout lands, then release. No navigation transaction
            // here: the window above is already the target vicinity and
            // scrollTop is already 0 — a second transaction would re-scroll
            // post-reveal.
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          } else if (saved && typeof saved.scrollTop === 'number' && !snapshotInvalidForRoute && !canonicalAnchor) {
            // Same-route raw scrollTop already applied pre-paint; settle one frame.
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          } else {
            // Deterministic route-local default (`bottom` plan): the committed
            // latest window is already at bottom pre-paint; settle one frame
            // so late layout lands before the stable commit. Invalid
            // snapshots land here too via the deterministic `bottom` plan —
            // only this stable default may replace the stale snapshot.
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          }
        } catch {
          // fail-closed: keep the vicinity window position
        } finally {
          // Restore-owned token/ownership: release only while still the
          // current epoch so every return/error path releases once. The
          // saved-row anchor lifecycle ends here (queued intents already
          // hold their detached snapshot). Stable completion commits the
          // target route's snapshot (no user input required) and advances
          // displayed provenance — including the deterministic-default path
          // above, so the next no-scroll round-trip restores that default.
          // Valid anchors commit by identity (applied anchor + wantOffset,
          // live scrollTop/bottom; never a crossing-first capture); bottom /
          // raw / invalid-snapshot defaults commit the final visible viewport. A
          // valid unresolved anchor never commits a fallback: the gate below
          // fails visible and preserves the prior snapshot. Stale `finally`
          // blocks never touch the new session (session currency gate).
          //
          // Activation deferred reveal (F2, full fallback): ordinary sessions
          // already revealed pre-paint in the layout effect, so this is a
          // harmless idempotent re-assert. Activation sessions skipped that
          // pre-paint reveal and stayed hidden (`positioning` through
          // aligned/searching); reveal here only after the hidden settle
          // above verified residency/coverage, immediately before stable.
          // Old completions never reveal the new session: both `revealed()`
          // and the stable helpers are epoch-guarded.
          if (controller.isSessionCurrent(topRestoreEpoch)) {
            if (!isTopAnchorCommittable()) {
              failVisibleTransition(topRestoreEpoch)
            } else {
              if (controller.isActivationSession) {
                let topRevealed = false
                try {
                  topRevealed = controller.revealed(topRestoreEpoch)
                } catch {
                  topRevealed = false
                }
                // Bounded rejection: CURRENT owner only; stale stays inert.
                if (!topRevealed) {
                  if (controller.isSessionCurrent(topRestoreEpoch)) {
                    failVisibleTransition(topRestoreEpoch)
                  }
                  return
                }
                if (!controller.isSessionCurrent(topRestoreEpoch)) {
                  return
                }
              }
              let topCommitted = false
              if (routeSavedRowAnchor && !snapshotInvalidForRoute) {
                const identityOffset =
                  typeof saved?.intraRowOffset === 'number' && Number.isFinite(saved.intraRowOffset)
                    ? saved.intraRowOffset
                    : null
                // Identity commit (applied anchor + wantOffset, live
                // scrollTop/bottom). commitDisplayedStableWithAnchor advances
                // displayed, ends the token, clears the plan, and releases
                // exactly once.
                topCommitted = commitDisplayedStableWithAnchor(
                  topicIdAtEffect,
                  routeAtEffect,
                  topRestoreEpoch,
                  routeSavedRowAnchor,
                  identityOffset
                )
              } else {
                topCommitted = commitDisplayedStable(topicIdAtEffect, routeAtEffect, topRestoreEpoch)
              }
              // Bounded rejection: a CURRENT owner's rejected stable commit
              // must not stay hidden (fail-visible preserving snapshot/release
              // once); stale stays inert and never terminates the new session.
              if (!topCommitted) {
                if (controller.isSessionCurrent(topRestoreEpoch)) {
                  failVisibleTransition(topRestoreEpoch)
                }
                return
              }
            }
          }
        }
      } catch (error) {
        logger.error('[routeInvalidation] Failed to rebuild viewport window:', error as Error)
      }
    })()
  }, [
    activeBranchId,
    awaitPlanPlacement,
    beginFetchHold,
    beginScroll,
    cancelActiveLoads,
    checkElement,
    commitDisplayedStable,
    commitDisplayedStableWithAnchor,
    commitRouteWindowAtomic,
    commitTopVisibleAtomic,
    deletionFallbackIntent,
    dispatch,
    failVisibleTransition,
    getLegacyMainSavedPosition,
    readTargetSnapshot,
    saveDisplayedSnapshot,
    selectMessageForFold,
    t,
    topic.id,
    viewportConnectionGeneration,
    viewportDispatch,
    waitForProjectionCommit
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
          viewportPhase={viewportPhaseAttr}
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
