import { Spin } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
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

const RouteLoadingFallback: FC = () => {
  const { t } = useTranslation()
  return (
    <Container data-testid="route-loading-fallback" aria-busy="true" aria-label={t('route.loading')}>
      <Spin tip={t('route.loading')} size="default">
        <div style={{ padding: 40 }} />
      </Spin>
    </Container>
  )
}

export default RouteLoadingFallback
