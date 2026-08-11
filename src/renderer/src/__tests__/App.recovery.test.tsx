/**
 * App recovery-surface gate tests (LOCK-CAT-2, LOCK-PROMO-7, LOCK-CAT-8,
 * LOCK-F2).
 *
 * Verifies the App bootstrap wiring:
 * - The catalog recovery handler is registered at mount in BOTH modes (the
 *   normal window also needs the boundary for promotion capture/apply).
 * - When the window URL carries `cherryImportRecovery=1`, the ORDINARY
 *   application surface (TopViewContainer → useAppInit services, Router →
 *   every route) is NOT mounted — only the minimal static recovery surface
 *   renders (LOCK-CAT-2: normal routes/services stay unavailable until
 *   convergence).
 * - The recovery surface uses the i18n keys (LOCK-CAT-8: no hardcoded
 *   user-visible strings).
 * - LOCK-F2 terminal repair state: when the URL additionally carries
 *   `cherryRecoveryTerminal=1&cherryRecoveryCode=<code>`, the surface shows
 *   ONLY the bounded i18n repair text + the machine code (no paths/names/
 *   content/IDs) and ordinary UI stays unmounted.
 * - A normal window URL renders the ordinary application surface and shows no
 *   recovery text.
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockOnRequest, mockRespond } = vi.hoisted(() => ({
  mockOnRequest: vi.fn(),
  mockRespond: vi.fn()
}))

vi.mock('@renderer/databases', () => ({ default: {}, db: {} }))

vi.mock('@renderer/store', () => ({
  default: {},
  persistor: {},
  useAppSelector: () => ({ settings: {} })
}))

// The real ImportProjectionGate is exercised; the readiness singleton is
// pre-settled to `ready` so the gate renders the ordinary tree immediately.
// The gate's gating/failure behavior is covered by
// ImportProjectionGate.test.tsx.
vi.mock('@renderer/services/importProjectionReadiness', () => ({
  isImportProjectionReady: () => true,
  getImportProjectionReadinessState: () => 'ready' as const,
  subscribeImportProjectionReadiness: () => () => undefined,
  settleImportProjectionReadiness: vi.fn(),
  resetImportProjectionReadiness: vi.fn(),
  runImportProjectionBoot: vi.fn()
}))

vi.mock('@tanstack/react-query', () => {
  class MockQueryClient {
    defaultOptions = {}
  }
  return {
    QueryClient: MockQueryClient,
    QueryClientProvider: ({ children }: { children: React.ReactNode }) => children
  }
})

vi.mock('react-redux', () => ({
  Provider: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('redux-persist/integration/react', () => ({
  PersistGate: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@renderer/context/AntdProvider', () => ({
  default: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('@renderer/context/NotificationProvider', () => ({
  NotificationProvider: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('@renderer/context/CodeStyleProvider', () => ({
  CodeStyleProvider: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('@renderer/context/StyleSheetManager', () => ({
  default: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('@renderer/components/TopView', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="topview">{children}</div>
}))

vi.mock('@renderer/Router', () => ({
  default: () => <div data-testid="router" />
}))

import App from '@renderer/App'

function stubCatalogApi() {
  ;(window as unknown as { api: { cherryImport: { catalog: { onRequest: unknown; respond: unknown } } } }).api = {
    cherryImport: {
      catalog: {
        onRequest: mockOnRequest.mockImplementation(() => () => undefined),
        respond: mockRespond
      }
    }
  }
}

function resetUrl() {
  window.history.replaceState({}, '', '/')
}

describe('App recovery surface gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubCatalogApi()
    resetUrl()
  })

  it('registers the catalog recovery handler at mount (normal window)', () => {
    render(<App />)
    expect(mockOnRequest).toHaveBeenCalled()
  })

  it('registers the catalog recovery handler at mount (recovery window)', () => {
    window.history.replaceState({}, '', '/?cherryImportRecovery=1')
    render(<App />)
    expect(mockOnRequest).toHaveBeenCalled()
  })

  it('renders ONLY the recovery surface in recovery mode — ordinary UI/services stay unmounted', () => {
    window.history.replaceState({}, '', '/?cherryImportRecovery=1')
    render(<App />)
    // Recovery surface shows the i18n-keyed messages (LOCK-CAT-8).
    expect(screen.getByText('import.cherrystudio.catalog_recovery.title')).toBeInTheDocument()
    expect(screen.getByText('import.cherrystudio.catalog_recovery.description')).toBeInTheDocument()
    // LOCK-CAT-2: the ordinary application surface is NOT mounted.
    expect(screen.queryByTestId('topview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('router')).not.toBeInTheDocument()
  })

  it('renders the ordinary application surface with no recovery text in a normal window', () => {
    render(<App />)
    expect(screen.getByTestId('topview')).toBeInTheDocument()
    expect(screen.getByTestId('router')).toBeInTheDocument()
    expect(screen.queryByText('import.cherrystudio.catalog_recovery.title')).not.toBeInTheDocument()
    expect(screen.queryByText('import.cherrystudio.catalog_recovery.repair_required.title')).not.toBeInTheDocument()
  })

  it('renders ONLY the bounded terminal repair surface in the terminal state (LOCK-F2)', () => {
    window.history.replaceState(
      {},
      '',
      '/?cherryImportRecovery=1&cherryRecoveryTerminal=1&cherryRecoveryCode=READY_TIMEOUT'
    )
    render(<App />)
    // Bounded i18n text only (LOCK-CAT-8) + the machine code (LOCK-F2).
    expect(screen.getByText('import.cherrystudio.catalog_recovery.repair_required.title')).toBeInTheDocument()
    expect(screen.getByText('import.cherrystudio.catalog_recovery.repair_required.description')).toBeInTheDocument()
    expect(screen.getByText('import.cherrystudio.catalog_recovery.error_code')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-terminal-code').textContent).toBe('READY_TIMEOUT')
    // The recovery "please wait" surface is NOT shown in the terminal state.
    expect(screen.queryByText('import.cherrystudio.catalog_recovery.title')).not.toBeInTheDocument()
    // LOCK-CAT-2 / LOCK-F2: ordinary UI stays unmounted.
    expect(screen.queryByTestId('topview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('router')).not.toBeInTheDocument()
  })

  it('interprets the terminal marker ONLY inside the recovery surface (LOCK-F2 isolation)', () => {
    // A stray terminal marker on an ordinary window URL must NOT flip the
    // ordinary surface into the repair state — recovery-only state is scoped
    // to the recovery surface.
    window.history.replaceState({}, '', '/?cherryRecoveryTerminal=1&cherryRecoveryCode=READY_TIMEOUT')
    render(<App />)
    expect(screen.getByTestId('topview')).toBeInTheDocument()
    expect(screen.getByTestId('router')).toBeInTheDocument()
    expect(screen.queryByText('import.cherrystudio.catalog_recovery.repair_required.title')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recovery-terminal-code')).not.toBeInTheDocument()
  })

  it('shows the recovery "please wait" surface without any terminal code when the terminal marker is absent', () => {
    window.history.replaceState({}, '', '/?cherryImportRecovery=1')
    render(<App />)
    expect(screen.getByText('import.cherrystudio.catalog_recovery.title')).toBeInTheDocument()
    expect(screen.queryByTestId('recovery-terminal-code')).not.toBeInTheDocument()
    expect(screen.queryByText('import.cherrystudio.catalog_recovery.repair_required.title')).not.toBeInTheDocument()
  })
})
