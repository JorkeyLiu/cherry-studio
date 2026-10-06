import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import ResizableHandle from '@renderer/components/ResizableHandle'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants, useShowTopics } from '@renderer/hooks/useStore'
import { useActiveTopic } from '@renderer/hooks/useTopic'
import { ensureAssistantTopicsIntegrity } from '@renderer/services/assistantTopicIntegrity'
import { dbService } from '@renderer/services/db'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { isImportProjectionReady } from '@renderer/services/importProjectionReadiness'
import NavigationService from '@renderer/services/NavigationService'
import store from '@renderer/store'
import { addTopic } from '@renderer/store/assistants'
import { newMessagesActions } from '@renderer/store/newMessage'
import { setAssistantsWidth } from '@renderer/store/settings'
import type { Assistant, Topic } from '@renderer/types'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, SECOND_MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { Alert, Button, Spin } from 'antd'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const navigate = useNavigate()

  const location = useLocation()
  const state = location.state

  const [activeAssistant, _setActiveAssistant] = useState<Assistant>(
    state?.assistant || _activeAssistant || assistants[0]
  )
  const { activeTopic, setActiveTopic: _setActiveTopic } = useActiveTopic(activeAssistant?.id ?? '', state?.topic)
  const { showAssistants, showTopics } = useSettings()
  const { setShowAssistants } = useShowAssistants()
  const { toggleShowTopics } = useShowTopics()
  const dispatch = useDispatch()
  const { t } = useTranslation()
  const lastTopicByAssistantRef = useRef<Record<string, string>>({})
  // Runtime integrity gate: a really-empty ordinary assistant (`topics: []`,
  // never `undefined` loading) is repaired via atomic Main find-or-create
  // before any topic-consuming Chat mount. Pending shows the existing
  // loading pattern; genuine failure shows the existing error + retry —
  // never a fake Redux topic, never a central "new topic" CTA.
  const [integrityState, setIntegrityState] = useState<'idle' | 'pending' | 'failed'>('idle')
  const integrityAttemptRef = useRef<string | null>(null)

  // Keep the local selection anchored to the live store row by stable id so
  // a boot/runtime repair (which adds the Main topic to the store) flows
  // into this view without overwriting model/config.
  useEffect(() => {
    if (!activeAssistant?.id) return
    const live = assistants.find((a) => a.id === activeAssistant.id)
    if (live && live !== (activeAssistant as unknown)) {
      _setActiveAssistant(live)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistants])

  // A deleted active assistant (e.g. replace-all import) reselects the first
  // live assistant instead of rendering a stale deleted row.
  useEffect(() => {
    if (!activeAssistant?.id) return
    const stillPresent = assistants.some((a) => a.id === activeAssistant.id)
    if (!stillPresent && assistants.length > 0 && assistants[0]) {
      _setActiveAssistant(assistants[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistants])

  const activeAssistantIsReallyEmpty =
    !!activeAssistant && Array.isArray(activeAssistant.topics) && activeAssistant.topics.length === 0

  useEffect(() => {
    if (!activeAssistantIsReallyEmpty || !activeAssistant) {
      return
    }
    if (!isImportProjectionReady()) return
    if (integrityAttemptRef.current === activeAssistant.id) return
    integrityAttemptRef.current = activeAssistant.id
    let cancelled = false
    setIntegrityState('pending')
    void ensureAssistantTopicsIntegrity(activeAssistant.id, {
      reader: {
        // Fresh-store seam: post-await stale guards must observe the CURRENT
        // store, never the render-captured assistants array.
        findAssistant: (id: string) => (store.getState().assistants?.assistants ?? []).find((a) => a.id === id),
        listAssistants: () => store.getState().assistants?.assistants ?? []
      },
      ensure: (assistantId, candidateTopicId, candidateName) =>
        dbService.ensureAssistantTopics(assistantId, candidateTopicId, candidateName),
      dispatchAddTopic: (assistantId, topic) => {
        dispatch(addTopic({ assistantId, topic: topic as Topic }))
      }
    })
      .then(() => {
        if (!cancelled) setIntegrityState('idle')
      })
      .catch(() => {
        if (!cancelled) setIntegrityState('failed')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAssistantIsReallyEmpty, activeAssistant?.id])

  const retryIntegrity = useCallback(() => {
    integrityAttemptRef.current = null
    setIntegrityState('idle')
    // Re-trigger by clearing the attempt guard; the effect above reruns when
    // the guard clears and the assistant is still really empty.
    if (!activeAssistant) return
    const id = activeAssistant.id
    integrityAttemptRef.current = null
    setIntegrityState('pending')
    void ensureAssistantTopicsIntegrity(id, {
      reader: {
        // Fresh-store seam (same as the effect above): never render-captured.
        findAssistant: (aid: string) => (store.getState().assistants?.assistants ?? []).find((a) => a.id === aid),
        listAssistants: () => store.getState().assistants?.assistants ?? []
      },
      ensure: (assistantId, candidateTopicId, candidateName) =>
        dbService.ensureAssistantTopics(assistantId, candidateTopicId, candidateName),
      dispatchAddTopic: (assistantId, topic) => {
        dispatch(addTopic({ assistantId, topic: topic as Topic }))
      }
    })
      .then(() => setIntegrityState('idle'))
      .catch(() => setIntegrityState('failed'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAssistant?.id])

  const handleLeftResizeEnd = useCallback(
    (width: number) => {
      dispatch(setAssistantsWidth(width))
    },
    [dispatch]
  )

  _activeAssistant = activeAssistant

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
      if (!newAssistant || newAssistant.id === activeAssistant?.id) return
      if (activeAssistant?.id && activeTopic?.id) {
        lastTopicByAssistantRef.current[activeAssistant.id] = activeTopic.id
      }

      startTransition(() => {
        _setActiveAssistant(newAssistant)
        // 同步更新 active topic，避免不必要的重新渲染
        // History selection only when it still belongs to the newly selected
        // live assistant topics; an empty assistant keeps the current topic
        // until the integrity gate normalizes it (never undefined.id).
        const liveTopics = Array.isArray(newAssistant.topics) ? newAssistant.topics : []
        if (liveTopics.length === 0) {
          return
        }
        const lastTopicId = lastTopicByAssistantRef.current[newAssistant.id]
        const newTopic = liveTopics.find((topic) => topic.id === lastTopicId) ?? liveTopics[0]
        if (!newTopic) return
        _setActiveTopic((prev) => (newTopic?.id === prev?.id ? prev : newTopic))
      })
    },
    [_setActiveTopic, activeAssistant?.id, activeTopic?.id]
  )

  const setActiveTopic = useCallback(
    (newTopic: Topic) => {
      if (activeAssistant?.id && newTopic?.id) {
        lastTopicByAssistantRef.current[activeAssistant.id] = newTopic.id
      }

      startTransition(() => {
        _setActiveTopic((prev) => (newTopic?.id === prev?.id ? prev : newTopic))
        dispatch(newMessagesActions.setTopicFulfilled({ topicId: newTopic.id, fulfilled: false }))
      })
    },
    [_setActiveTopic, activeAssistant?.id, dispatch]
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
    // LOCK-002: topics always render on the left; the window can shrink only
    // when both side panels are hidden.
    const canMinimize = !showAssistants && !showTopics
    void window.api.window.setMinimumSize(canMinimize ? SECOND_MIN_WINDOW_WIDTH : MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)

    return () => {
      void window.api.window.resetMinimumSize()
    }
  }, [showAssistants, showTopics])

  // Gate the topic-consuming Chat tree until a normalized topic exists.
  // Stale route props (history topic no longer in the live assistant) wait
  // here instead of throwing on `props.id`.
  const normalizedTopicReady =
    !!activeTopic &&
    !!activeAssistant &&
    Array.isArray(activeAssistant.topics) &&
    activeAssistant.topics.some((topic) => topic.id === activeTopic.id)

  if (activeAssistantIsReallyEmpty || !normalizedTopicReady) {
    if (integrityState === 'failed') {
      return (
        <Container id="home-page">
          <GateContainer data-testid="assistant-integrity-error" role="alert" aria-live="assertive">
            <StyledGateAlert
              type="error"
              showIcon
              message={t('startup.readiness.error.title')}
              description={t('startup.readiness.error.description')}
              action={
                <Button
                  size="small"
                  type="primary"
                  onClick={retryIntegrity}
                  data-testid="assistant-integrity-retry"
                  aria-label={t('startup.readiness.error.retry')}>
                  {t('startup.readiness.error.retry')}
                </Button>
              }
            />
          </GateContainer>
        </Container>
      )
    }
    return (
      <Container id="home-page">
        <GateContainer
          data-testid="assistant-integrity-loading"
          aria-busy="true"
          aria-label={t('startup.readiness.loading')}>
          <Spin tip={t('startup.readiness.loading')} size="default">
            <div style={{ padding: 40 }} />
          </Spin>
        </GateContainer>
      </Container>
    )
  }

  return (
    <Container id="home-page">
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
          <ResizableHandle cssVar="--assistants-width" onResizeEnd={handleLeftResizeEnd} side="left" />
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
    </Container>
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

const GateContainer = styled.div`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  padding: 24px;
`

const StyledGateAlert = styled(Alert)`
  max-width: 560px;
  width: 100%;
`

export default HomePage
