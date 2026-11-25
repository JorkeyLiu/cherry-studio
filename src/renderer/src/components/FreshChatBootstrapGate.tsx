import { Alert, Button } from 'antd'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { APP_NAME, AppLogo } from '../config/env'
import {
  getFreshChatBootstrapReadinessState,
  runFreshChatBootstrap,
  subscribeFreshChatBootstrapReadiness
} from '../services/freshChatBootstrap'

const Container = styled.div`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  height: 100vh;
  min-height: 200px;
  padding: 24px;
`

const Welcome = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  width: 100%;
  max-width: 480px;
  text-align: center;
`

const WelcomeLogo = styled.img`
  width: clamp(72px, 16vw, 112px);
  height: auto;
`

const WelcomeTitle = styled.h1`
  margin: 0;
  color: var(--color-text);
  font-size: clamp(24px, 4vw, 32px);
  font-weight: 600;
  line-height: 1.25;
`

const WelcomeMessage = styled.p`
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 1.5;
`

const StyledAlert = styled(Alert)`
  max-width: 560px;
  width: 100%;
`

/**
 * Keep the ordinary chat tree unmounted until a pending fresh-profile bootstrap
 * has established SQLite ownership for its initial topics. Existing profiles
 * are ready immediately and render children without a loading frame.
 */
export function FreshChatBootstrapGate({ children }: { children: React.ReactNode }) {
  const state = useSyncExternalStore(
    subscribeFreshChatBootstrapReadiness,
    getFreshChatBootstrapReadinessState,
    getFreshChatBootstrapReadinessState
  )
  const { t } = useTranslation()
  const [retrying, setRetrying] = useState(false)

  const handleRetry = useCallback(async () => {
    if (retrying) return
    setRetrying(true)
    try {
      await runFreshChatBootstrap()
    } catch {
      // The shared readiness state exposes the failure and keeps the marker.
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

  return (
    <Container data-testid="startup-readiness-loading" aria-busy="true" aria-label={t('startup.readiness.loading')}>
      <Welcome role="status" aria-live="polite">
        <WelcomeLogo src={AppLogo} alt={APP_NAME} />
        <WelcomeTitle>{APP_NAME}</WelcomeTitle>
        <WelcomeMessage>{t('startup.readiness.loading')}</WelcomeMessage>
      </Welcome>
    </Container>
  )
}

export default FreshChatBootstrapGate
