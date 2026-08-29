import { Button, Space } from 'antd'
import { Alert } from 'antd'
import type { FC } from 'react'
import type { FallbackProps } from 'react-error-boundary'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'

const Container = styled.div`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 200px;
  padding: 24px;
`

const StyledAlert = styled(Alert)`
  max-width: 560px;
  width: 100%;
`

export const RouteErrorFallback: FC<FallbackProps> = ({ error, resetErrorBoundary }) => {
  const { t } = useTranslation()
  const navigate = useNavigate()

  // Route-local recovery UI must catch only tagged chunk-load failures.
  // Re-throw untagged page render errors so the outer global ErrorBoundary handles them.
  if (error) {
    const taggedError = error as unknown as Record<string, unknown>
    const isTagged = taggedError.isRouteChunkLoadError === true && taggedError.name === 'RouteChunkLoadError'
    if (!isTagged) {
      throw error
    }
  }

  const handleRetry = () => {
    resetErrorBoundary()
  }

  const handleHome = () => {
    resetErrorBoundary()
    navigate('/')
  }

  // Keep error message private but render generic localized description
  void error

  return (
    <Container data-testid="route-error-fallback">
      <StyledAlert
        type="error"
        showIcon
        message={t('route.error.title')}
        description={t('route.error.description')}
        action={
          <Space>
            <Button size="small" onClick={handleRetry} data-testid="route-error-retry">
              {t('route.error.retry')}
            </Button>
            <Button size="small" onClick={handleHome} data-testid="route-error-home">
              {t('route.error.back_to_home')}
            </Button>
          </Space>
        }
      />
    </Container>
  )
}

export default RouteErrorFallback
