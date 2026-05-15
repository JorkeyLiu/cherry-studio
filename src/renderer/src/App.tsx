import '@renderer/databases'

import { loggerService } from '@logger'
import store, { persistor, useAppSelector } from '@renderer/store'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Provider } from 'react-redux'
import { PersistGate } from 'redux-persist/integration/react'

import TopViewContainer from './components/TopView'
import AntdProvider from './context/AntdProvider'
import { CodeStyleProvider } from './context/CodeStyleProvider'
import { NotificationProvider } from './context/NotificationProvider'
import StyleSheetManager from './context/StyleSheetManager'
import { ThemeProvider } from './context/ThemeProvider'
import Router from './Router'

const logger = loggerService.withContext('App.tsx')

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
    document.documentElement.style.setProperty('--assistants-width', `${assistantsWidth}px`)
    document.documentElement.style.setProperty('--topic-list-width', `${topicListWidth}px`)
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
                  <PersistGate loading={null} persistor={persistor}>
                    <SidebarWidthInitializer />
                    <TopViewContainer>
                      <Router />
                    </TopViewContainer>
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
