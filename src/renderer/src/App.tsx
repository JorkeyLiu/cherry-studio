import '@renderer/databases'

import { loggerService } from '@logger'
import store, { useAppSelector } from '@renderer/store'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Provider } from 'react-redux'

import TopViewContainer from './components/TopView'
import AntdProvider from './context/AntdProvider'
import { CodeStyleProvider } from './context/CodeStyleProvider'
import { NotificationProvider } from './context/NotificationProvider'
import StyleSheetManager from './context/StyleSheetManager'
import { ThemeProvider } from './context/ThemeProvider'
import Router from './Router'

const logger = loggerService.withContext('App.tsx')

const DEFAULT_SIDEBAR_WIDTH = 275
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 600

const formatSidebarWidth = (width: unknown) => {
  const normalized =
    typeof width === 'number' && Number.isFinite(width)
      ? Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width))
      : DEFAULT_SIDEBAR_WIDTH

  return `${normalized}px`
}

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

  useEffect(() => {
    document.documentElement.style.setProperty('--assistants-width', formatSidebarWidth(assistantsWidth))
    document.documentElement.style.setProperty('--topic-list-width', formatSidebarWidth(topicListWidth))
  }, [assistantsWidth, topicListWidth])

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
                  <SidebarWidthInitializer />
                  <TopViewContainer>
                    <Router />
                  </TopViewContainer>
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
