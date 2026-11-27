import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import SearchPopup from '@renderer/components/Popups/SearchPopup'
import ResizableHandle from '@renderer/components/ResizableHandle'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useFullscreen } from '@renderer/hooks/useFullscreen'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useWorkspaceSidebar } from '@renderer/hooks/useStore'
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
import NavigationService from '@renderer/services/NavigationService'
import { useAppSelector } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import { setWorkspaceSidebarWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '@renderer/store/settings'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { Assistant, Topic } from '@renderer/types'
import { selectDefaultTopic } from '@renderer/utils/sort'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, SECOND_MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { AnimatePresence, motion } from 'motion/react'
import type { Dispatch, FC, SetStateAction } from 'react'
import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDispatch } from 'react-redux'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import Chat from './Chat'
import SidebarToggle from './components/SidebarToggle'
import WorkspaceSidebar from './components/WorkspaceSidebar'

let _activeAssistant: Assistant

// Unified navigation: a single workspace sidebar on the left (assistant
// switcher + topics + app entries). The right topic panel and the Home top
// redundant toolbar are removed; Chat owns the single top bar.
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

  const { messageNavigation } = useSettings()
  const isFullscreen = useFullscreen()
  const { t } = useTranslation()
  const { visible, width, toggleVisible } = useWorkspaceSidebar()
  const dispatch = useDispatch()
  const { pairedMinPair, windowWidth } = usePairedReadingMin()
  const lastTopicByAssistantRef = useRef<Record<string, string>>({})
  // Departure-freeze command: synchronously snapshots the DISPLAYED (old)
  // route under its own key. Fail-closed by controller ownership/provenance —
  // dirty/owned states preserve the stored snapshot instead of overwriting it.
  const { freezeDisplayed } = useRouteViewportCommands()
  // Paired chat floor: independent of the sidebar (minPair + the pair-axis chrome,
  // plus the nav gutter when the navigator is mounted). Window minimum sums
  // the sidebar + the measured fixed chrome + the chat floor — each counted once.
  const chatColumnMin =
    pairedMinPair > 0 ? pairedMinPair + PAIRED_AXIS_FIXED_PX + (messageNavigation ? NAV_GUTTER_WIDTH_PX : 0) : 0
  const sidebarVisibleWidth = visible ? width : 0
  // Live window width (resize-subscribed): the drag clamp is a fixed-window
  // budget, never a render-time snapshot.
  const winW = windowWidth
  // Sidebar drag stops at the remaining chat budget: a fixed window can never be
  // squeezed below the reading minimum by widening the panel.
  const sidebarMaxWidth = winW > 0 ? sidebarDragMax(winW, chatColumnMin) : SIDEBAR_MAX_WIDTH

  const handleSidebarResizeEnd = useCallback(
    (nextWidth: number) => {
      dispatch(setWorkspaceSidebarWidth(nextWidth))
    },
    [dispatch]
  )

  // Unified sidebar: collapse is fully hidden (no narrow rail), so both
  // legacy shortcuts map onto the single visibility toggle.
  useShortcut('toggle_show_assistants', () => {
    toggleVisible()
  })
  useShortcut('toggle_show_topics', () => {
    toggleVisible()
  })

  // Restored from the removed Home top bar: global search lives on the home
  // route only (KnowledgePage registers its own dialog-scoped one).
  useShortcut('search_message', () => {
    void SearchPopup.show()
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
  // writer whenever the visible sidebar or the chat floor change. Updates must
  // NOT reset the floor first: a reset restores the default policy minimum and
  // grows the window out of the closed-sidebar (520) mode. Only a true unmount
  // returns the window to the default policy.
  useEffect(() => {
    // Unified navigation: the window can shrink only when the single sidebar
    // is hidden. Paired minimum lifts the floor: the required width is
    // max(existing policy, measured fixed chrome + visible sidebar + the
    // derived reading minimum). The chat floor itself stays independent of
    // the sidebar; hiding the panel lowers the window.
    const canMinimize = !visible
    const policy = canMinimize ? SECOND_MIN_WINDOW_WIDTH : MIN_WINDOW_WIDTH
    const required = requiredWindowWidth(policy, sidebarVisibleWidth, chatColumnMin)
    void window.api.window.setMinimumSize(Math.ceil(required), MIN_WINDOW_HEIGHT)
  }, [visible, sidebarVisibleWidth, chatColumnMin])

  useEffect(() => {
    return () => {
      void window.api.window.resetMinimumSize()
    }
  }, [])

  return (
    <ContentContainer id="content-container">
      <AnimatePresence initial={false}>
        {visible && (
          <ErrorBoundary>
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{
                width: 'var(--workspace-sidebar-width, 300px)',
                opacity: 1
              }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              style={{ overflow: 'hidden' }}>
              <WorkspaceSidebar
                activeAssistant={activeAssistant}
                activeTopic={activeTopic}
                setActiveAssistant={setActiveAssistant}
                setActiveTopic={setActiveTopic}
              />
            </motion.div>
          </ErrorBoundary>
        )}
      </AnimatePresence>
      {visible && (
        <ResizableHandle
          cssVar="--workspace-sidebar-width"
          minWidth={SIDEBAR_MIN_WIDTH}
          maxWidth={sidebarMaxWidth}
          onResizeEnd={handleSidebarResizeEnd}
          side="left"
          testId="workspace-sidebar-handle"
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
      {/* Single sidebar toggle: one control sliding with the panel. Expanded
          it sits at the sidebar titlebar's right edge (the former collapse
          slot); hidden it rests right of the native traffic lights. Position
          derives from the live sidebar width var so it tracks drags, with the
          same 0.3s ease as the panel — never a second show/hide button.
          Rendered after Chat on purpose: Electron applies the collected
          native region vector in order (union drag, subtract no-drag), so the
          button's no-drag entry must sort after the chat drag entry it
          floats over. Renderer collection order is version-dependent and is
          not asserted here; z-index cannot repair a native overlap. Never
          introduce another drag rect over this button later in the tree. */}
      <SidebarToggle
        visible={visible}
        isFullscreen={isFullscreen}
        title={t(visible ? 'navbar.hide_sidebar' : 'navbar.show_sidebar')}
        onToggle={toggleVisible}
      />
    </ContentContainer>
  )
}

const Container = styled.div`
   display: flex;
   flex: 1;
   flex-direction: column;
   min-height: 0;
   min-width: 0;
 `

const ContentContainer = styled.div`
   position: relative;
   display: flex;
   flex: 1;
   flex-direction: row;
   min-height: 0;
   min-width: 0;
   overflow: hidden;
 `

export default HomePage
