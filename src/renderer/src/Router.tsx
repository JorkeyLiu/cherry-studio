import '@renderer/databases'

import type { FC } from 'react'
import { useMemo } from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'

import Sidebar from './components/app/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LazyRoute } from './components/LazyRoute'
import NavigationHandler from './handler/NavigationHandler'
import HomePage from './pages/home/HomePage'

// S7.1 renderer-only lazy boundary: keep Home eager, defer secondary routes.
// Eager critical path: HomePage, Sidebar, NavigationHandler, HashRouter, App providers remain eager.
// Lazy secondary routes: Files, Notes, Knowledge, Settings, Launchpad each in own chunk.
const importFilesPage = () => import('./pages/files/FilesPage')
const importNotesPage = () => import('./pages/notes/NotesPage')
const importKnowledgePage = () => import('./pages/knowledge/KnowledgePage')
const importSettingsPage = () => import('./pages/settings/SettingsPage')
const importLaunchpadPage = () => import('./pages/launchpad/LaunchpadPage')

// S7.1 stable test seam: eager Home vs lazy secondary routes.
// AppRoutes is the route outlet without HashRouter/Sidebar/NavigationHandler so
// focused tests can render it inside MemoryRouter with controlled entries.
export const AppRoutes: FC = () => {
  const routes = useMemo(() => {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/files" element={<LazyRoute importer={importFilesPage} />} />
          <Route path="/notes" element={<LazyRoute importer={importNotesPage} />} />
          <Route path="/knowledge" element={<LazyRoute importer={importKnowledgePage} />} />
          <Route path="/settings/*" element={<LazyRoute importer={importSettingsPage} />} />
          <Route path="/launchpad" element={<LazyRoute importer={importLaunchpadPage} />} />
        </Routes>
      </ErrorBoundary>
    )
  }, [])
  return routes
}

// Fixed product behavior (LOCK-002): navigation always renders on the left
// and the app enters the main window directly (no onboarding gate, LOCK-001).
const Router: FC = () => {
  const routes = useMemo(() => <AppRoutes />, [])

  return (
    <HashRouter>
      <Sidebar />
      {routes}
      <NavigationHandler />
    </HashRouter>
  )
}

export default Router
