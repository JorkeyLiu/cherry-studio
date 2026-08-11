import '@renderer/databases'

import { loggerService } from '@logger'
import store, { persistor, useAppSelector } from '@renderer/store'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Provider } from 'react-redux'
import { PersistGate } from 'redux-persist/integration/react'

import ImportProjectionGate from './components/ImportProjectionGate'
import TopViewContainer from './components/TopView'
import AntdProvider from './context/AntdProvider'
import { CodeStyleProvider } from './context/CodeStyleProvider'
import { NotificationProvider } from './context/NotificationProvider'
import StyleSheetManager from './context/StyleSheetManager'
import { ThemeProvider } from './context/ThemeProvider'
import Router from './Router'
import { isCatalogRecoverySurface, registerCatalogRecoveryHandler } from './services/catalogRecoveryService'

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

/**
 * Reads the bounded terminal repair code from the recovery URL (LOCK-F2).
 * Only a bounded machine code travels on the wire — never paths/names/
 * content/IDs. Null when the window is not in the terminal repair state.
 */
function readRecoveryTerminalCode(): string | null {
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('cherryRecoveryTerminal') !== '1') return null
    const code = params.get('cherryRecoveryCode')
    if (typeof code !== 'string' || code.length === 0 || code.length > 64) return 'UNEXPECTED'
    return code
  } catch {
    return null
  }
}

/**
 * L2 catalog handoff surface (Phase 2, LOCK-PROMO-5/7).
 *
 * Registers the catalog request handler once at bootstrap — the minimal
 * renderer/Dexie recovery surface that lets Main snapshot/apply/restore the
 * live files catalog. When the window was launched in recovery mode
 * (`cherryImportRecovery=1`), the ORDINARY application UI is replaced by a
 * static blocking surface: normal application window/data flows become
 * available only after Main completes the catalog handoff (journal reaches
 * `replacement-verified`) or the old rollback completes, then reloads this
 * window without the recovery parameter.
 *
 * LOCK-F2 terminal state: when Main exhausted its bounded retry budget it
 * navigates the recovery window to the terminal repair URL; this surface then
 * shows ONLY bounded i18n text + the machine code (no paths/names/content/
 * IDs) and ordinary UI stays unmounted.
 */
function CatalogHandoffBoundary({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  useEffect(() => {
    const unsubscribe = registerCatalogRecoveryHandler()
    return () => unsubscribe()
  }, [])

  if (isCatalogRecoverySurface()) {
    const terminalCode = readRecoveryTerminalCode()
    if (terminalCode !== null) {
      logger.error(`Catalog recovery terminal (${terminalCode}) — repair surface shown (LOCK-F2)`)
      return (
        <div
          style={{
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 12,
            fontFamily: 'system-ui, sans-serif',
            color: '#666'
          }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            {t('import.cherrystudio.catalog_recovery.repair_required.title')}
          </div>
          <div style={{ fontSize: 13 }}>{t('import.cherrystudio.catalog_recovery.repair_required.description')}</div>
          <div style={{ fontSize: 12, opacity: 0.72 }}>
            <span>{t('import.cherrystudio.catalog_recovery.error_code')}</span>
            {': '}
            <span data-testid="recovery-terminal-code">{terminalCode}</span>
          </div>
        </div>
      )
    }
    logger.warn('App booted in catalog recovery surface mode (LOCK-PROMO-7): ordinary UI blocked')
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 12,
          fontFamily: 'system-ui, sans-serif',
          color: '#666'
        }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{t('import.cherrystudio.catalog_recovery.title')}</div>
        <div style={{ fontSize: 13 }}>{t('import.cherrystudio.catalog_recovery.description')}</div>
      </div>
    )
  }
  return <>{children}</>
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
                    <CatalogHandoffBoundary>
                      {/* LOCK-001/LOCK-PROJECTION: the ordinary chat tree must
                          not mount until the one-shot L2 navigation projection
                          has safely settled (applied or verified no-pending),
                          so stale redux-persist navigation can never prime
                          messages before the imported navigation replaces it.
                          Kept INSIDE CatalogHandoffBoundary: the catalog
                          handoff listener must still register at App mount in
                          every window (LOCK-BRIDGE-1). */}
                      <ImportProjectionGate>
                        <TopViewContainer>
                          <Router />
                        </TopViewContainer>
                      </ImportProjectionGate>
                    </CatalogHandoffBoundary>
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
