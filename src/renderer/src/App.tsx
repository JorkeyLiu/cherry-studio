import '@renderer/databases'

import { loggerService } from '@logger'
import store, { persistor, useAppSelector } from '@renderer/store'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Provider } from 'react-redux'
import { PersistGate } from 'redux-persist/integration/react'

import FreshChatBootstrapGate from './components/FreshChatBootstrapGate'
import TopViewContainer from './components/TopView'
import AntdProvider from './context/AntdProvider'
import { CodeStyleProvider } from './context/CodeStyleProvider'
import { NotificationProvider } from './context/NotificationProvider'
import StyleSheetManager from './context/StyleSheetManager'
import { ThemeProvider } from './context/ThemeProvider'
import Router from './Router'
import {
  normalizeSidebarWidth,
  normalizeWorkspaceSidebarWidth,
  WORKSPACE_SIDEBAR_DEFAULT_WIDTH
} from './store/settings'

const logger = loggerService.withContext('App.tsx')

const formatSidebarWidth = (width: unknown) => `${normalizeSidebarWidth(width)}px`

const formatWorkspaceSidebarWidth = (width: unknown) => `${normalizeWorkspaceSidebarWidth(width)}px`

// 创建 React Query 客户端
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: false
    }
  }
})

/**
 * Reads persisted sidebar widths from Redux and applies them to CSS variables
 * so the layout matches the user's saved preferences on startup.
 */
function SidebarWidthInitializer() {
  const assistantsWidth = useAppSelector((s) => s.settings.assistantsWidth)
  const topicListWidth = useAppSelector((s) => s.settings.topicListWidth)
  const workspaceSidebarWidth = useAppSelector((s) => s.settings.workspaceSidebarWidth)

  useEffect(() => {
    document.documentElement.style.setProperty('--assistants-width', formatSidebarWidth(assistantsWidth))
    document.documentElement.style.setProperty('--topic-list-width', formatSidebarWidth(topicListWidth))
    document.documentElement.style.setProperty(
      '--workspace-sidebar-width',
      formatWorkspaceSidebarWidth(workspaceSidebarWidth ?? WORKSPACE_SIDEBAR_DEFAULT_WIDTH)
    )
  }, [assistantsWidth, topicListWidth, workspaceSidebarWidth])

  return null
}

function App(): React.ReactElement {
  logger.info('App initialized')

  return (
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <StyleSheetManager>
          <ThemeProvider>
            <AntdProvider>
              <NotificationProvider>
                <CodeStyleProvider>
                  <PersistGate loading={null} persistor={persistor}>
                    <SidebarWidthInitializer />
                    <FreshChatBootstrapGate>
                      <TopViewContainer>
                        <Router />
                      </TopViewContainer>
                    </FreshChatBootstrapGate>
                  </PersistGate>
                </CodeStyleProvider>
              </NotificationProvider>
            </AntdProvider>
          </ThemeProvider>
        </StyleSheetManager>
      </QueryClientProvider>
    </Provider>
  )
}

export default App
