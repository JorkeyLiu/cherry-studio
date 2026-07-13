import '@renderer/databases'

import { Spin } from 'antd'
import type { FC } from 'react'
import React, { Suspense, useMemo } from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'
import styled from 'styled-components'

import Sidebar from './components/app/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import TabsContainer from './components/Tab/TabContainer'
import NavigationHandler from './handler/NavigationHandler'
import { useOnboardingState } from './hooks/useOnboardingState'
import { useNavbarPosition } from './hooks/useSettings'
import { OnboardingPage } from './pages/onboarding'

// Lazy-loaded page components for code splitting
const FilesPage = React.lazy(() => import('./pages/files/FilesPage'))
const HomePage = React.lazy(() => import('./pages/home/HomePage'))
const KnowledgePage = React.lazy(() => import('./pages/knowledge/KnowledgePage'))
const LaunchpadPage = React.lazy(() => import('./pages/launchpad/LaunchpadPage'))
const NotesPage = React.lazy(() => import('./pages/notes/NotesPage'))
const SettingsPage = React.lazy(() => import('./pages/settings/SettingsPage'))

const LoadingFallback: FC = () => (
  <LoadingFallbackContainer>
    <Spin />
  </LoadingFallbackContainer>
)

const Router: FC = () => {
  const { onboardingCompleted, completeOnboarding } = useOnboardingState()
  const { navbarPosition } = useNavbarPosition()

  const routes = useMemo(() => {
    return (
      <ErrorBoundary>
        <Suspense fallback={<LoadingFallback />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/knowledge" element={<KnowledgePage />} />
            <Route path="/settings/*" element={<SettingsPage />} />
            <Route path="/launchpad" element={<LaunchpadPage />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    )
  }, [])

  if (!onboardingCompleted) {
    return <OnboardingPage onComplete={completeOnboarding} />
  }

  if (navbarPosition === 'left') {
    return (
      <HashRouter>
        <Sidebar />
        {routes}
        <NavigationHandler />
      </HashRouter>
    )
  }

  return (
    <HashRouter>
      <NavigationHandler />
      <TabsContainer>{routes}</TabsContainer>
    </HashRouter>
  )
}

const LoadingFallbackContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;
`

export default Router
