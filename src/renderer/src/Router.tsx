import '@renderer/databases'

import type { CSSProperties, FC } from 'react'
import { Activity, useEffect, useState } from 'react'
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom'

import Sidebar from './components/app/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LazyRoute } from './components/LazyRoute'
import { importSettingsPage } from './components/routeImporters'
import NavigationHandler from './handler/NavigationHandler'
import HomePage from './pages/home/HomePage'

// S7.1 renderer-only lazy boundary: keep Home eager, defer secondary routes.
// Eager critical path: HomePage, Sidebar, NavigationHandler, HashRouter, App providers remain eager.
// Lazy secondary routes: Files, Notes, Knowledge, Settings, Launchpad each in own chunk.
const importFilesPage = () => import('./pages/files/FilesPage')
const importNotesPage = () => import('./pages/notes/NotesPage')
const importKnowledgePage = () => import('./pages/knowledge/KnowledgePage')
const importLaunchpadPage = () => import('./pages/launchpad/LaunchpadPage')

// Bounded Chat session workspace: after Chat (Home) has mounted, its component
// session (Home/Messages/ThinkingBlock timers, mount-time topic activation)
// survives secondary-route navigation instead of unmount/remount. Home stays
// mounted inside React Activity: while a secondary route is active the Activity
// is hidden, which preserves component state/refs/DOM identity but unmounts
// the hidden subtree's effects — Home global shortcuts/listeners detach and
// the native minimum-size constraint resets via the existing effect cleanup —
// and re-runs them on return. Launching directly into a secondary route mounts
// no Chat until '/' is first visited (no eager Chat data loading); from then
// on the session persists. Request/stream execution lives outside the UI tree
// and is unaffected; Redux projections, SQLite authority, and retention are
// unchanged. The thinking timer needs no change: its wall-clock anchor is a
// retained ref that survives the hidden interval, so the restarted interval
// resumes elapsed time instead of resetting (covered by
// ThinkingBlock.activity.test). Activity owns hidden semantics
// (display:none + AT/focus hiding), so no manual CSS/inert mechanics remain;
// the wrapper div is layout only. Route URLs, Sidebar behavior, and per-route
// lazy bundle splitting are unchanged.
const chatWorkspaceStyle: CSSProperties = {
  display: 'flex',
  flex: 1,
  minWidth: 0,
  minHeight: 0
}

// S7.1 stable test seam: eager Home vs lazy secondary routes.
// AppRoutes is the route outlet without HashRouter/Sidebar/NavigationHandler so
// focused tests can render it inside MemoryRouter with controlled entries.
export const AppRoutes: FC = () => {
  const location = useLocation()
  const isHome = location.pathname === '/'
  const [hasVisitedHome, setHasVisitedHome] = useState(() => isHome)

  useEffect(() => {
    if (isHome) {
      setHasVisitedHome(true)
    }
  }, [isHome])

  // Render Home on '/' (including the navigation that first visits it) and keep
  // it mounted hidden afterwards; never mount it for a direct secondary entry.
  const shouldRenderHome = isHome || hasVisitedHome
  return (
    <ErrorBoundary>
      {shouldRenderHome && (
        <Activity mode={isHome ? 'visible' : 'hidden'}>
          <div data-testid="chat-workspace" style={chatWorkspaceStyle}>
            <HomePage />
          </div>
        </Activity>
      )}
      <Routes>
        <Route path="/files" element={<LazyRoute importer={importFilesPage} />} />
        <Route path="/notes" element={<LazyRoute importer={importNotesPage} />} />
        <Route path="/knowledge" element={<LazyRoute importer={importKnowledgePage} />} />
        <Route path="/settings/*" element={<LazyRoute importer={importSettingsPage} />} />
        <Route path="/launchpad" element={<LazyRoute importer={importLaunchpadPage} />} />
      </Routes>
    </ErrorBoundary>
  )
}

// Fixed product behavior (LOCK-002): navigation always renders on the left
// and the app enters the main window directly (no onboarding gate, LOCK-001).
const Router: FC = () => {
  return (
    <HashRouter>
      <Sidebar />
      <AppRoutes />
      <NavigationHandler />
    </HashRouter>
  )
}

export default Router
