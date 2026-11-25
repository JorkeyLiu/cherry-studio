import '@renderer/databases'

import type { CSSProperties, FC } from 'react'
import { useTranslation } from 'react-i18next'
import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom'

import Sidebar from './components/app/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LazyRoute } from './components/LazyRoute'
import { importSettingsPage } from './components/routeImporters'
import TaskDialog from './components/TaskDialog'
import NavigationHandler from './handler/NavigationHandler'
import HomePage from './pages/home/HomePage'

// Chat-only base with centered in-app modal task dialogs: Home is the only
// full-page route and stays mounted. Secondary tasks (Files, Knowledge,
// Settings) render inside a TaskDialog overlay; the URL stays on the task
// path so shortcut/deeplink/provider query semantics keep working, and close
// navigates explicitly to '/' (never history-back out of the app). Import
// chunk loading/errors stay inside the dialog; home itself stays eager.
// Notes page/entries removed (storage/migration/import compatibility
// preserved); launchpad removed as a full page (legacy entries redirect to
// chat via LaunchpadRedirect below).
const importFilesPage = () => import('./pages/files/FilesPage')
const importKnowledgePage = () => import('./pages/knowledge/KnowledgePage')

// Dialog width buckets: settings narrower, file/knowledge management wider.
const SETTINGS_DIALOG_WIDTH = 1000
const MANAGEMENT_DIALOG_WIDTH = 1100

const chatWorkspaceStyle: CSSProperties = {
  display: 'flex',
  flex: 1,
  minWidth: 0,
  minHeight: 0
}

interface TaskRouteProps {
  importer: () => Promise<{ default: React.ComponentType<any> }>
  titleKey: string
  width: number
}

// Route-dialog overlay: Home stays mounted exactly once (outside <Routes>)
// so opening/switching/closing tasks never remounts it — draft, viewport
// and effects survive. The task owns its centered bounded surface; '/*'
// route shapes (e.g. '/settings/*') reuse the same shell; the task always
// closes to '/'.
const TaskRoute: FC<TaskRouteProps> = ({ importer, titleKey, width }) => {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const handleClose = () => {
    navigate('/')
  }

  return (
    <TaskDialog title={t(titleKey)} width={width} onClose={handleClose}>
      <LazyRoute importer={importer} />
    </TaskDialog>
  )
}

// Launchpad is not a full page: any legacy '/launchpad' entry (bookmark,
// deeplink, persisted history) lands back on chat instead of a blank route.
const LaunchpadRedirect: FC = () => <Navigate to="/" replace />

// Secondary routes keep their paths (/files, /knowledge, /settings/*) so
// shortcut/deeplink/provider query semantics keep working; '/launchpad',
// '/notes' and unknown paths redirect to '/'. AppRoutes is the route outlet
// without HashRouter/Sidebar/NavigationHandler so focused tests can render
// it inside MemoryRouter with controlled entries.
// Chat viewport governance: Home is mounted once and stays visible — secondary
// tasks are dialog overlays, never a hidden Activity workspace. Opening a task
// suspends the in-flight viewport activation; closing it revalidates through
// the existing validated-continuation/read lanes, so no persisted-snapshot save
// runs and no cross-route restore intent is created from the dialog. Unknown
// paths redirect explicitly to '/' (chat-only base: no blank route).
export const AppRoutes: FC = () => {
  return (
    <ErrorBoundary>
      <div data-testid="chat-workspace" style={chatWorkspaceStyle}>
        <HomePage />
      </div>
      <Routes>
        <Route
          path="/files"
          element={<TaskRoute importer={importFilesPage} titleKey="title.files" width={MANAGEMENT_DIALOG_WIDTH} />}
        />
        <Route
          path="/knowledge"
          element={
            <TaskRoute importer={importKnowledgePage} titleKey="title.knowledge" width={MANAGEMENT_DIALOG_WIDTH} />
          }
        />
        <Route
          path="/settings/*"
          element={<TaskRoute importer={importSettingsPage} titleKey="settings.title" width={SETTINGS_DIALOG_WIDTH} />}
        />
        <Route path="/launchpad" element={<LaunchpadRedirect />} />
        <Route path="/launchpad/*" element={<LaunchpadRedirect />} />
        <Route path="/notes" element={<Navigate to="/" replace />} />
        <Route path="/notes/*" element={<Navigate to="/" replace />} />
        <Route path="/" element={null} />
        <Route path="*" element={<Navigate to="/" replace />} />
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
