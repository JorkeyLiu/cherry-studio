/**
 * ImportProjectionGate — gates the ordinary chat tree on the one-shot L2
 * navigation projection readiness (LOCK-001, LOCK-PROJECTION).
 *
 * The stale redux-persist navigation must NOT mount Home/useActiveTopic and
 * call Main `fetchMessages` (topic priming) before
 * `applyPendingImportProjection` has replaced/flushed/acked the imported
 * navigation. This gate renders NO children until the import projection
 * readiness settles successfully (`importProjectionReadiness`); while
 * pending it shows a localized accessible loading state (S7.2), and after a
 * failure it shows a localized actionable retry surface — the ordinary chat
 * tree stays unmounted and no stale topic load can occur until a successful
 * settlement. A failure leaves the pending row unacked for next-startup
 * retry; S7.2 also offers an in-session retry that reruns the captured
 * dispatch → flush → ack path without re-notifying ReduxStoreReady.
 *
 * Placement: INSIDE `CatalogHandoffBoundary` (in App.tsx), because the
 * catalog recovery handler must still register at App mount in every window
 * (LOCK-BRIDGE-1 handshake) — the gate only blocks the ordinary
 * TopViewContainer/Router tree.
 */

import { Alert, Button, Spin } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import type { ImportProjectionReadinessState } from '../services/importProjectionReadiness'
import {
  getImportProjectionReadinessState,
  isImportProjectionReady,
  retryImportProjectionReadiness,
  subscribeImportProjectionReadiness
} from '../services/importProjectionReadiness'

const Container = styled.div`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  height: 100vh;
  min-height: 200px;
  padding: 24px;
`

const StyledAlert = styled(Alert)`
  max-width: 560px;
  width: 100%;
`

/**
 * React view of the import projection readiness boolean. `true` only after
 * the projection has safely settled (applied or verified no-pending).
 * Retained for backward compatibility.
 */
export function useImportProjectionReadiness(): boolean {
  const [ready, setReady] = useState<boolean>(() => isImportProjectionReady())

  useEffect(() => {
    if (ready) {
      return
    }
    const unsubscribe = subscribeImportProjectionReadiness(() => {
      setReady(isImportProjectionReady())
    })
    // Re-read in case readiness settled between the initial render and the
    // effect subscription.
    setReady(isImportProjectionReady())
    return unsubscribe
  }, [ready])

  return ready
}

/**
 * React view of the raw readiness state — enables the gate to distinguish
 * `pending` (loading) from `failed` (retry surface) while still preventing
 * children from mounting (LOCK-PROJECTION).
 */
export function useImportProjectionReadinessState(): ImportProjectionReadinessState {
  const [readinessState, setReadinessState] = useState<ImportProjectionReadinessState>(() =>
    getImportProjectionReadinessState()
  )

  useEffect(() => {
    const unsubscribe = subscribeImportProjectionReadiness(() => {
      setReadinessState(getImportProjectionReadinessState())
    })
    // Re-read after subscription in case state settled between render and effect
    setReadinessState(getImportProjectionReadinessState())
    return unsubscribe
  }, [])

  return readinessState
}

export function ImportProjectionGate({ children }: { children: React.ReactNode }) {
  const state = useImportProjectionReadinessState()
  const { t } = useTranslation()
  const [retrying, setRetrying] = useState(false)

  const handleRetry = useCallback(async () => {
    if (retrying) return
    setRetrying(true)
    try {
      await retryImportProjectionReadiness()
    } finally {
      setRetrying(false)
    }
  }, [retrying])

  if (state === 'ready') {
    return <>{children}</>
  }

  if (state === 'failed') {
    return (
      <Container data-testid="startup-readiness-error" role="alert" aria-live="assertive">
        <StyledAlert
          type="error"
          showIcon
          message={t('startup.readiness.error.title')}
          description={t('startup.readiness.error.description')}
          action={
            <Button
              size="small"
              type="primary"
              onClick={handleRetry}
              loading={retrying}
              disabled={retrying}
              data-testid="startup-readiness-retry"
              aria-label={t('startup.readiness.error.retry')}>
              {t('startup.readiness.error.retry')}
            </Button>
          }
        />
      </Container>
    )
  }

  // pending — localized accessible loading while still gating children
  return (
    <Container data-testid="startup-readiness-loading" aria-busy="true" aria-label={t('startup.readiness.loading')}>
      <Spin tip={t('startup.readiness.loading')} size="default">
        <div style={{ padding: 40 }} />
      </Spin>
    </Container>
  )
}

export default ImportProjectionGate
