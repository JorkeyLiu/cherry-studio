import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import ResizableHandle from '@renderer/components/ResizableHandle'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants, useShowTopics } from '@renderer/hooks/useStore'
import { useActiveTopic } from '@renderer/hooks/useTopic'
import {
  isTaskDialogPath,
  RouteViewportProvider,
  useRouteViewportCommands
} from '@renderer/pages/home/Messages/routeViewportContext'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import NavigationService from '@renderer/services/NavigationService'
import { useAppSelector } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import { setAssistantsWidth, SIDEBAR_MIN_WIDTH } from '@renderer/store/settings'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { Assistant, Topic } from '@renderer/types'
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
      <RouteViewportProvider topicId={activeTopic.id} initialRoute={activeBranchId} taskDialogOpen={taskDialogOpen}>
        <HomeViewportScope
          activeAssistant={activeAssistant}
          activeTopic={activeTopic}
          setActiveAssistantState={_setActiveAssistant}
          setActiveTopicState={_setActiveTopic}
        />
      </RouteViewportProvider>
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

  const { showAssistants, showTopics } = useSettings()
  const { setShowAssistants } = useShowAssistants()
  const { toggleShowTopics } = useShowTopics()
  const dispatch = useDispatch()
  const lastTopicByAssistantRef = useRef<Record<string, string>>({})
  // Departure-freeze command: synchronously snapshots the DISPLAYED (old)
  // route under its own key. Fail-closed by controller ownership/provenance —
  // dirty/owned states preserve the stored snapshot instead of overwriting it.
  const { freezeDisplayed } = useRouteViewportCommands()

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
      const newTopic = newAssistant.topics.find((topic) => topic.id === lastTopicId) ?? newAssistant.topics[0]
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

  useEffect(() => {
    // LOCK-002: topics always render on the right; the window can shrink only
    // when both side panels are hidden.
    const canMinimize = !showAssistants && !showTopics
    void window.api.window.setMinimumSize(canMinimize ? SECOND_MIN_WINDOW_WIDTH : MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)

    return () => {
      void window.api.window.resetMinimumSize()
    }
  }, [showAssistants, showTopics])

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
