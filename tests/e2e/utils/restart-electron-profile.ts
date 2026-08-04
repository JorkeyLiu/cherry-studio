/**
 * Same-profile Electron relaunch helper for the L2 genuine import E2E
 * (LOCK-UI4: close the entire app, then relaunch against the SAME disposable
 * `--user-data-dir` and re-assert the imported navigation + messages).
 *
 * Scope is deliberately narrow: the ONLY thing this helper does is launch a
 * fresh Electron instance against an already-existing disposable profile and
 * bring its main window back to a usable state (Redux ready, mock provider
 * present, textarea ready). It never creates/removes profiles and never kills
 * processes — closing the current app is the spec's responsibility via the
 * existing `closeElectronWithExactCleanup` (exact `--user-data-dir` token,
 * LOCK-625).
 *
 * Ownership contract:
 * - The launched app MUST be closed by the caller (exact-token cleanup)
 *   before the test ends — the shared fixture does not know about it.
 * - A failure to bring the relaunched window ready closes the app before the
 *   error propagates (never leaks a half-launched process).
 * - The launch args/env mirror `electron.fixture.ts` exactly (LOCK-001/002):
 *   same `--user-data-dir`, `--no-sandbox`, `--disable-gpu`, and the same
 *   TMPDIR/TMP/TEMP redirection into the owned temp root so production
 *   `os.tmpdir()` keeps resolving inside the owned root.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

// ---------------------------------------------------------------------------
// Pure launch-surface builders (exported for the focused unit test)
// ---------------------------------------------------------------------------

/** Exact Electron launch args mirroring the shared fixture (LOCK-001). */
export function relaunchArgs(userDataDir: string): string[] {
  return ['.', `--user-data-dir=${userDataDir}`, '--no-sandbox', '--disable-gpu']
}

/** Exact Electron launch env mirroring the shared fixture (LOCK-002). */
export function relaunchEnv(ownedTmpRoot: string): Record<string, string> {
  return {
    ...process.env,
    NODE_ENV: 'development',
    ELECTRON_RUN_AS_NODE: '',
    TMPDIR: ownedTmpRoot,
    TMP: ownedTmpRoot,
    TEMP: ownedTmpRoot
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RelaunchSameProfileOptions {
  /** The exact disposable `--user-data-dir` token to reuse (LOCK-625). */
  userDataDir: string
  /** Ownership-safe temp root: production os.tmpdir() resolves here. */
  ownedTmpRoot: string
  /** Mock provider port to (re-)ensure after relaunch (LOCK-002). */
  mockPort: number
}

export interface RelaunchedProfileApp {
  app: ElectronApplication
  /** The main Cherry window, Redux + mock provider + textarea ready. */
  page: Page
}

// ---------------------------------------------------------------------------
// Readiness steps (self-contained — no dependency on fixture internals)
// ---------------------------------------------------------------------------

async function waitForMainWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.waitForEvent('window', {
    predicate: async (win) => {
      try {
        return (await win.title()).includes('Cherry')
      } catch {
        return false
      }
    },
    timeout: 120000
  })
  await page.waitForSelector('#root', { state: 'attached', timeout: 60000 })
  return page
}

/**
 * The `onboarding-completed` localStorage flag survives on the same profile,
 * so onboarding is normally already skipped. This is a bounded safety net:
 * click Skip when the welcome screen is still shown, then re-assert the flag.
 */
async function bypassOnboardingIfShown(page: Page): Promise<void> {
  try {
    const skipBtn = page.getByText('Skip', { exact: false })
    await skipBtn.waitFor({ state: 'visible', timeout: 10000 })
    await skipBtn.click()
    await page.waitForTimeout(2000)
  } catch {
    // Already past onboarding
  }
  await page.evaluate(() => {
    localStorage.setItem('onboarding-completed', 'true')
  })
}

/**
 * Idempotently ensure the mock provider + default model are present in Redux.
 * The `llm` slice survives redux-persist across a same-profile relaunch, so
 * this is normally a no-op; when the persisted state is somehow incomplete it
 * re-seeds using the exact same dispatches as the shared fixture (LOCK-002).
 */
async function ensureMockProvider(page: Page, mockPort: number): Promise<void> {
  await page.waitForFunction(() => typeof (window as any).store !== 'undefined', { timeout: 30000 })

  const alreadySeeded = await page.evaluate(() => {
    const s = (window as any).store?.getState()
    return Boolean(
      s?.llm?.providers?.some((p: any) => p.id === 'mock-openai') && s.llm?.defaultModel?.id === 'mock-model'
    )
  })
  if (alreadySeeded) return

  const apiHost = `http://127.0.0.1:${mockPort}/v1/`
  await page.evaluate(
    ({ apiHost }) => {
      const store = (window as any).store
      const state = store.getState()

      const existing = state.llm.providers.find((p: any) => p.id === 'mock-openai')
      if (existing) {
        store.dispatch({
          type: 'llm/updateProvider',
          payload: { id: 'mock-openai', apiKey: 'test-key', apiHost, enabled: true }
        })
      } else {
        store.dispatch({
          type: 'llm/addProvider',
          payload: {
            id: 'mock-openai',
            type: 'openai',
            name: 'Mock OpenAI',
            apiKey: 'test-key',
            apiHost,
            models: [
              {
                id: 'mock-model',
                provider: 'mock-openai',
                name: 'Mock Model',
                group: 'mock',
                description: 'Mock model for E2E'
              }
            ],
            enabled: true,
            isSystem: false
          }
        })
      }

      const mockModel = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' }
      store.dispatch({ type: 'llm/setDefaultModel', payload: { model: mockModel } })
      store.dispatch({ type: 'llm/setQuickModel', payload: { model: mockModel } })
      store.dispatch({ type: 'llm/setTranslateModel', payload: { model: mockModel } })
    },
    { apiHost }
  )

  await page.waitForTimeout(1000)

  const ok = await page.evaluate(() => {
    const s = (window as any).store.getState()
    return s.llm.providers.some((p: any) => p.id === 'mock-openai') && s.llm.defaultModel?.id === 'mock-model'
  })
  if (!ok) throw new Error('[E2E] Failed to ensure mock provider after same-profile relaunch')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Launch a fresh Electron instance against the SAME disposable profile and
 * wait until the main window is usable (Redux ready, mock provider ensured,
 * home + textarea visible). Returns the new app + page.
 *
 * The caller must close the returned app before the test ends using
 * `closeElectronWithExactCleanup(userDataDir, ...)` (LOCK-625). On any
 * readiness failure the freshly launched app is closed before throwing.
 */
export async function relaunchSameProfile(options: RelaunchSameProfileOptions): Promise<RelaunchedProfileApp> {
  const app = await electron.launch({
    args: relaunchArgs(options.userDataDir),
    env: relaunchEnv(options.ownedTmpRoot),
    timeout: 120000
  })

  try {
    const page = await waitForMainWindow(app)
    await bypassOnboardingIfShown(page)
    await ensureMockProvider(page, options.mockPort)

    // Home readiness (same selector set as the shared fixture's waitForHomeReady).
    await page.waitForSelector(
      ['#chat', '.inputbar-container', '[class*="Inputbar"]', '[class*="Container"]'].join(', '),
      { state: 'visible', timeout: 60000 }
    )
    await page.waitForSelector('.inputbar textarea, textarea[placeholder]', { state: 'visible', timeout: 30000 })
    return { app, page }
  } catch (error) {
    try {
      await app.close()
    } catch {
      // Best-effort close of the failed launch — never mask the original error.
    }
    throw error
  }
}
