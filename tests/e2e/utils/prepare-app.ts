/**
 * Shared Electron launch and main-window preparation steps used by the E2E
 * fixture (`tests/e2e/fixtures/electron.fixture.ts`) and the `ui:observe`
 * observation harness (`scripts/ui-observe/`).
 *
 * Every function here is a verbatim, parameterized move of the fixture's
 * proven setup obligations so the observation harness and the E2E fixture
 * share one code path:
 *
 *   - LOCK-001: unique disposable profile via `--user-data-dir`
 *   - LOCK-OBS-003: runtime appDataPath assertion BEFORE any mutation
 *     (see `runtime-app-data.ts`)
 *   - onboarding bypass (first-launch gate removed; legacy flag is an inert
 *     no-op write for profile-format compatibility)
 *   - mock OpenAI-compatible provider seeding into the running Redux store
 *   - home / ChatDb IPC / textarea readiness, fail-fast
 *
 * The functions are side-effect free: they take explicit inputs and return
 * results; callers own any module state.
 */
import type { ElectronApplication, Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'

export interface LaunchElectronOptions {
  /** Unique disposable profile dir passed as `--user-data-dir=<dir>`. */
  userDataDir: string
  /**
   * Ownership-safe temp root; TMPDIR/TMP/TEMP point here so production
   * `os.tmpdir()` resolves inside the owned root for exact cleanup.
   */
  ownedTmpRoot: string | null
}

/** Launch the built Cherry Chat app with the disposable profile and owned temp env. */
export function launchElectronApp(options: LaunchElectronOptions): Promise<ElectronApplication> {
  // Ownership-safe: pass TMPDIR/TMP/TEMP so production os.tmpdir() resolves
  // inside the owned temp root. This ensures all production temp artifacts
  // (cherry-import-*, etc.) land under our owned root for cleanup.
  const tmpEnv: Record<string, string> = {}
  if (options.ownedTmpRoot) {
    tmpEnv.TMPDIR = options.ownedTmpRoot
    tmpEnv.TMP = options.ownedTmpRoot
    tmpEnv.TEMP = options.ownedTmpRoot
  }

  return electron.launch({
    args: ['.', `--user-data-dir=${options.userDataDir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, NODE_ENV: 'development', ELECTRON_RUN_AS_NODE: '', ...tmpEnv },
    timeout: 120000
  })
}

/** Wait for the main `Cherry Chat` window with the React root attached. */
export async function waitForMainElectronWindow(electronApp: ElectronApplication): Promise<Page> {
  const mainWindow = await electronApp.waitForEvent('window', {
    predicate: async (window) => {
      try {
        const title = await window.title()
        return title === 'Cherry Chat' || title.includes('Cherry')
      } catch {
        return false
      }
    },
    timeout: 120000
  })
  await mainWindow.waitForSelector('#root', { state: 'attached', timeout: 60000 })
  await mainWindow.waitForLoadState('domcontentloaded')
  return mainWindow
}

/**
 * LOCK-001: the first-launch onboarding gate is removed — fresh launches enter
 * the main app directly. The legacy `onboarding-completed` localStorage flag is
 * inert; kept as a no-op write for profile-format compatibility.
 */
export async function bypassOnboarding(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem('onboarding-completed', 'true')
  })
}

/**
 * Seed the mock provider and default model into the Redux store.
 * Seeds directly into the running store (no page reload).
 */
export async function seedMockProvider(page: Page, port: number): Promise<void> {
  await page.waitForFunction(() => typeof (window as any).store !== 'undefined', { timeout: 30000 })
  await page.waitForFunction(
    () => {
      const s = (window as any).store?.getState()
      return s && s.llm && Array.isArray(s.llm.providers)
    },
    { timeout: 30000 }
  )

  const apiHost = `http://127.0.0.1:${port}/v1/`

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
  if (!ok) throw new Error('Failed to seed mock provider')
}

/** Wait for the home/chat UI to be ready. */
export async function waitForHomeReady(page: Page, timeout = 60000): Promise<void> {
  await page.waitForSelector('#root', { state: 'attached', timeout })
  await page.waitForSelector(
    ['#chat', '.inputbar-container', '[class*="Inputbar"]', '[class*="Container"]'].join(', '),
    { state: 'visible', timeout }
  )
  await page.waitForTimeout(1000)
}

/**
 * Verify ChatDb IPC is available and the native module loads correctly.
 * Throws immediately if any check fails (fail-fast).
 */
export async function assertChatDbReady(page: Page): Promise<void> {
  // 1. Verify IPC chatDb API is exposed
  const apiCheck = await page.evaluate(async () => {
    try {
      const api = (window as any).api
      if (!api?.chatDb) return { ok: false, error: 'window.api.chatDb not found' }
      if (typeof api.chatDb.fetchMessages !== 'function')
        return { ok: false, error: 'chatDb.fetchMessages not a function' }
      if (typeof api.chatDb.appendMessage !== 'function')
        return { ok: false, error: 'chatDb.appendMessage not a function' }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  if (!apiCheck.ok) {
    throw new Error(`ChatDb IPC not ready: ${apiCheck.error}`)
  }

  // 2. Verify ChatDb can execute a probe query and returns a valid ChatDbResult envelope
  //    topicExists returns ChatDbResult<boolean> = { ok: true, value: boolean } | { ok: false, error }
  const probeResult = await page.evaluate(async () => {
    try {
      const api = (window as any).api
      const result = await api.chatDb.topicExists({ topicId: '__e2e_probe__' })
      // Validate ChatDbResult envelope structure
      if (!result || typeof result !== 'object') {
        return { ok: false, error: 'Result is not an object' }
      }
      if (typeof result.ok !== 'boolean') {
        return { ok: false, error: `Result.ok is not boolean: ${typeof result.ok}` }
      }
      if (!result.ok) {
        return { ok: false, error: `ChatDb returned failure: ${JSON.stringify(result.error)}` }
      }
      // For topicExists, value must be a boolean
      if (typeof result.value !== 'boolean') {
        return { ok: false, error: `topicExists value is not boolean: ${typeof result.value}` }
      }
      return { ok: true, value: result.value }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  if (!probeResult.ok) {
    throw new Error(`ChatDb IPC probe failed (possible ABI mismatch): ${probeResult.error}`)
  }
}

/** Assert that the textarea is ready for input (real Ant Design TextArea). */
export async function assertTextareaReady(page: Page): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 30000 })
}
