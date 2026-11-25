import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import ResizableHandle from '@renderer/components/ResizableHandle'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants, useShowTopics } from '@renderer/hooks/useStore'
import { useActiveTopic } from '@renderer/hooks/useTopic'
import { NAV_GUTTER_WIDTH_PX } from '@renderer/pages/home/Messages/MessageOutline'
import {
  PAIRED_AXIS_FIXED_PX,
  requiredWindowWidth,
  sidebarDragMax
} from '@renderer/pages/home/Messages/pairedGroupSizing'
import { PairedReadingMinProvider, usePairedReadingMin } from '@renderer/pages/home/Messages/pairedReadingMinContext'
import {
  isTaskDialogPath,
  RouteViewportProvider,
  useRouteViewportCommands
} from '@renderer/pages/home/Messages/routeViewportContext'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import NavigationService from '@renderer/services/NavigationService'
import { useAppSelector } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import { setAssistantsWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '@renderer/store/settings'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { Assistant, Topic } from '@renderer/types'
import { selectDefaultTopic } from '@renderer/utils/sort'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, SECOND_MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { AnimatePresence, motion } from 'motion/react'
import type { Dispatch, FC, SetStateAction } from 'react'
import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { useDispatch } from 'react-redux'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import Chat from './Chat'
import Navbar from './Navbar'
import HomeTabs from './Tabs'

let _activeAssistant: Assistant

// LOCK-002: navigation always renders on the left, topics always on the right.
const HomePage: FC = () => {
  const { assistants } = useAssistants()

  const location = useLocation()
  const state = location.state

  const [activeAssistant, _setActiveAssistant] = useState<Assistant>(
    state?.assistant || _activeAssistant || assistants[0]
  )
  const { activeTopic, setActiveTopic: _setActiveTopic } = useActiveTopic(activeAssistant?.id ?? '', state?.topic)

  // Provider route input (same semantics as the former Chat-level provider):
  // the selected topic's own active branch. Topic changes arrive via the
  // `topicId` prop (provider syncs displayed); the branch is read fresh here.
  const activeBranchId = useAppSelector((s) => selectActiveBranchId(s, activeTopic.id))
  // Secondary tasks (Files / Knowledge / Settings) render as a centered
  // in-app modal dialog ABOVE the always-visible chat base, so the task path is
  // the single open/close edge the route viewport provider needs for its
  // activation handoff (see `isTaskDialogPath`). The check lives here, once:
  // the conversation tree holds no page-local pathname booleans.
  const taskDialogOpen = isTaskDialogPath(location.pathname)

  _activeAssistant = activeAssistant

  return (
    <Container id="home-page">
      <PairedReadingMinProvider>
        <RouteViewportProvider topicId={activeTopic.id} initialRoute={activeBranchId} taskDialogOpen={taskDialogOpen}>
          <HomeViewportScope
            activeAssistant={activeAssistant}
            activeTopic={activeTopic}
            setActiveAssistantState={_setActiveAssistant}
            setActiveTopicState={_setActiveTopic}
          />
        </RouteViewportProvider>
      </PairedReadingMinProvider>
    </Container>
  )
}

interface HomeViewportScopeProps {
  activeAssistant: Assistant
  activeTopic: Topic
  setActiveAssistantState: (assistant: Assistant) => void
  setActiveTopicState: Dispatch<SetStateAction<Topic>>
}

/**
 * Viewport-scope content: every ordinary active-topic entry converges on the
 * two callbacks below, which run INSIDE the single RouteViewportProvider so
 * the outgoing freeze can execute synchronously BEFORE selected changes.
 */
const HomeViewportScope: FC<HomeViewportScopeProps> = ({
  activeAssistant,
  activeTopic,
  setActiveAssistantState: _setActiveAssistant,
  setActiveTopicState: _setActiveTopic
}) => {
  const navigate = useNavigate()

  const location = useLocation()
  const state = location.state

  const { showAssistants, showTopics, messageNavigation } = useSettings()
  const { setShowAssistants } = useShowAssistants()
  const { toggleShowTopics } = useShowTopics()
  const dispatch = useDispatch()
  const assistantsWidth = useAppSelector((s) => s.settings.assistantsWidth)
  const topicListWidth = useAppSelector((s) => s.settings.topicListWidth)
  const { pairedMinPair, windowWidth } = usePairedReadingMin()
  const lastTopicByAssistantRef = useRef<Record<string, string>>({})
  // Departure-freeze command: synchronously snapshots the DISPLAYED (old)
  // route under its own key. Fail-closed by controller ownership/provenance —
  // dirty/owned states preserve the stored snapshot instead of overwriting it.
  const { freezeDisplayed } = useRouteViewportCommands()
  // Paired chat floor: independent of sidebars (minPair + the pair-axis chrome,
  // plus the nav gutter when the navigator is mounted). Window minimum sums
  // sidebars + the measured fixed chrome + the chat floor — each counted once.
  const chatColumnMin =
    pairedMinPair > 0 ? pairedMinPair + PAIRED_AXIS_FIXED_PX + (messageNavigation ? NAV_GUTTER_WIDTH_PX : 0) : 0
  const leftVisibleWidth = showAssistants ? assistantsWidth : 0
  const rightVisibleWidth = showTopics ? topicListWidth : 0
  // Live window width (resize-subscribed): the drag clamp is a fixed-window
  // budget, never a render-time snapshot.
  const winW = windowWidth
  // Sidebar drag stops at the remaining chat budget: a fixed window can never be
  // squeezed below the reading minimum by widening a panel.
  const leftMaxWidth = winW > 0 ? sidebarDragMax(winW, rightVisibleWidth, chatColumnMin) : SIDEBAR_MAX_WIDTH

  const handleLeftResizeEnd = useCallback(
    (width: number) => {
      dispatch(setAssistantsWidth(width))
    },
    [dispatch]
  )

  useShortcut('toggle_show_assistants', () => {
    if (!showAssistants) {
      setShowAssistants(true)
      requestAnimationFrame(() => {
        void EventEmitter.emit(EVENT_NAMES.SHOW_ASSISTANTS)
      })
      return
    }

    void EventEmitter.emit(EVENT_NAMES.SHOW_ASSISTANTS)
  })

  useShortcut('toggle_show_topics', () => {
    toggleShowTopics()
  })

  const setActiveAssistant = useCallback(
    (newAssistant: Assistant) => {
      if (newAssistant.id === activeAssistant?.id) return
      if (activeAssistant?.id && activeTopic?.id) {
        lastTopicByAssistantRef.current[activeAssistant.id] = activeTopic.id
      }

      // 同步更新 active topic，避免不必要的重新渲染
      const lastTopicId = lastTopicByAssistantRef.current[newAssistant.id]
      const newTopic = selectDefaultTopic(newAssistant.topics, lastTopicId) ?? newAssistant.topics[0]
      // An assistant switch also replaces the topic: freeze the outgoing
      // viewport before the transition. Same topic id never freezes.
      if (newTopic?.id !== activeTopic?.id) {
        freezeDisplayed()
      }
      startTransition(() => {
        _setActiveAssistant(newAssistant)
        _setActiveTopic((prev) => (newTopic?.id === prev?.id ? prev : newTopic))
      })
    },
    [_setActiveAssistant, _setActiveTopic, activeAssistant?.id, activeTopic?.id, freezeDisplayed]
  )

  const setActiveTopic = useCallback(
    (newTopic: Topic) => {
      if (activeAssistant?.id && newTopic?.id) {
        lastTopicByAssistantRef.current[activeAssistant.id] = newTopic.id
      }

      // Same-id is a no-op: never freeze, never transition.
      if (newTopic?.id === activeTopic?.id) return
      // Outgoing freeze BEFORE selected changes: the controller still shows
      // the OLD displayed route (clean-stable captures, owned/dirty preserves).
      freezeDisplayed()
      startTransition(() => {
        _setActiveTopic((prev) => (newTopic?.id === prev?.id ? prev : newTopic))
        dispatch(newMessagesActions.setTopicFulfilled({ topicId: newTopic.id, fulfilled: false }))
      })
    },
    [_setActiveTopic, activeAssistant?.id, activeTopic?.id, dispatch, freezeDisplayed]
  )

  useEffect(() => {
    NavigationService.setNavigate(navigate)
  }, [navigate])

  useEffect(() => {
    state?.assistant && setActiveAssistant(state?.assistant)
    state?.topic && setActiveTopic(state?.topic)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Paired minimum owner: the derived floor is pushed to the single native
  // writer whenever the visible sidebars or the chat floor change. Updates must
  // NOT reset the floor first: a reset restores the default policy minimum and
  // grows the window out of the closed-panels (520) mode. Only a true unmount
  // returns the window to the default policy.
  useEffect(() => {
    // LOCK-002: topics always render on the right; the window can shrink only
    // when both side panels are hidden. Paired minimum lifts the floor: the
    // required width is max(existing policy, measured fixed chrome + visible
    // sidebars + the derived reading minimum). The chat floor itself stays
    // independent of sidebars; closing panels lowers the window.
    const canMinimize = !showAssistants && !showTopics
    const policy = canMinimize ? SECOND_MIN_WINDOW_WIDTH : MIN_WINDOW_WIDTH
    const required = requiredWindowWidth(policy, leftVisibleWidth, rightVisibleWidth, chatColumnMin)
    void window.api.window.setMinimumSize(Math.ceil(required), MIN_WINDOW_HEIGHT)
  }, [showAssistants, showTopics, leftVisibleWidth, rightVisibleWidth, chatColumnMin])

  useEffect(() => {
    return () => {
      void window.api.window.resetMinimumSize()
    }
  }, [])

  return (
    <>
      <Navbar
        activeAssistant={activeAssistant}
        activeTopic={activeTopic}
        setActiveTopic={setActiveTopic}
        setActiveAssistant={setActiveAssistant}
        position="left"
      />
      <ContentContainer id="content-container">
        <AnimatePresence initial={false}>
          {showAssistants && (
            <ErrorBoundary>
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 'var(--assistants-width, 275px)', opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
                style={{ overflow: 'hidden' }}>
                <HomeTabs
                  activeAssistant={activeAssistant}
                  activeTopic={activeTopic}
                  setActiveAssistant={setActiveAssistant}
                  setActiveTopic={setActiveTopic}
                  position="left"
                />
              </motion.div>
            </ErrorBoundary>
          )}
        </AnimatePresence>
        {showAssistants && (
          <ResizableHandle
            cssVar="--assistants-width"
            minWidth={SIDEBAR_MIN_WIDTH}
            maxWidth={leftMaxWidth}
            onResizeEnd={handleLeftResizeEnd}
            side="left"
          />
        )}
        <ErrorBoundary>
          <Chat
            assistant={activeAssistant}
            activeTopic={activeTopic}
            setActiveTopic={setActiveTopic}
            setActiveAssistant={setActiveAssistant}
            chatColumnMin={chatColumnMin}
          />
        </ErrorBoundary>
      </ContentContainer>
    </>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  max-width: calc(100vw - var(--sidebar-width));
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  overflow: hidden;
`

export default HomePage
