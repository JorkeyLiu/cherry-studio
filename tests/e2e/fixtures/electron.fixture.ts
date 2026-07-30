/**
 * Electron E2E fixture with disposable profile and mock provider seeding.
 *
 * LOCK-001: Unique disposable profile; real profiles untouched.
 * LOCK-002: No paid/live external API; mock OpenAI-compatible endpoint.
 * LOCK-003: Minimal selector additions; no i18n changes.
 *
 * Fail-fast diagnostics:
 *   - Asserts ChatDb IPC availability before any test step
 *   - Verifies better-sqlite3 ABI matches Electron before launch
 *   - Post-shutdown SQLite verification via Electron binary (ABI 145)
 */
import type { ElectronApplication, Page } from '@playwright/test'
import { _electron as electron, test as base } from '@playwright/test'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { getRequiredRunToken, registerOwnedProfile } from '../utils/run-ownership'
import {
  clearRequestLog,
  createMockServer,
  findProductRequest,
  findProductRequestAfter,
  getRequestLog,
  getRequestSequence,
  stopMockServer
} from './mock-openai-server'

export type ElectronFixtures = {
  electronApp: ElectronApplication
  mainWindow: Page
  mockPort: number
  userDataDir: string
}

let _mockPort: number
let _userDataDir: string

// Exposed for post-shutdown SQLite verification
let _chatDbPath: string | null = null

// Runtime appDataPath captured from the running Electron process.
// Set after app launch via probeRuntimeAppDataPath().
let _runtimeAppDataPath: string | null = null

/**
 * Returns the path to chat.db for the current disposable profile.
 * Computed from the runtime appDataPath captured from the running app,
 * NOT predicted from the fixture's userDataDir.
 */
export function getChatDbPath(): string | null {
  return _chatDbPath
}

/**
 * Returns the runtime appDataPath captured from the running Electron app
 * via getAppInfo(). Returns null if not yet captured.
 */
export function getRuntimeAppDataPath(): string | null {
  return _runtimeAppDataPath
}

/**
 * Returns the disposable base userDataDir passed to Electron via --user-data-dir.
 */
export function getUserDataDir(): string {
  return _userDataDir
}

/**
 * Query SQLite database via Electron binary (ABI compatible).
 * Returns parsed JSON result from the verification script.
 *
 * Uses a temp file for the query script and spawnSync argument array
 * (no shell interpolation) for portability and actionable diagnostics.
 * Resolves better-sqlite3 path portably via require.resolve().
 */
export function queryChatDbViaElectron(dbPath: string, sql: string): Record<string, unknown> | null {
  const electronPath = require('electron') as string
  // Resolve better-sqlite3 path portably (no hard-coded absolute path)
  const bsPath = require.resolve('better-sqlite3')

  // Escape the SQL for safe embedding in a JS string literal
  const escapedSql = sql.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const escapedDbPath = dbPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const escapedBsPath = bsPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

  const script = `
    const Database = require('${escapedBsPath}');
    try {
      const db = new Database('${escapedDbPath}', { readonly: true });
      const result = db.prepare('${escapedSql}').all();
      console.log(JSON.stringify({ ok: true, rows: result }));
      db.close();
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: err.message }));
    }
  `
  // Use a temp file for the script to avoid shell escaping issues with complex SQL
  const tmpScript = path.join(os.tmpdir(), `e2e-sqlite-query-${Date.now()}-${Math.random().toString(36).slice(2)}.js`)
  fs.writeFileSync(tmpScript, script, 'utf-8')
  try {
    // spawnSync with argument array — no shell interpolation
    const result = spawnSync(electronPath, [tmpScript], {
      timeout: 15000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })

    if (result.error) {
      // spawnSync itself failed (e.g. electron binary not found)
      console.error(`[E2E] queryChatDbViaElectron spawn error: ${result.error.message}`)
      return null
    }

    if (result.status !== 0) {
      // Non-zero exit: surface stderr for diagnostics
      const stderr = result.stderr?.trim() || '(no stderr)'
      console.error(`[E2E] queryChatDbViaElectron exited ${result.status}: ${stderr.slice(0, 500)}`)
      return null
    }

    // Find the JSON line in output (last line is typically the result)
    const output = result.stdout || ''
    const lines = output.trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.startsWith('{')) {
        return JSON.parse(line) as Record<string, unknown>
      }
    }
    return null
  } finally {
    try {
      fs.unlinkSync(tmpScript)
    } catch {
      // ignore cleanup failure
    }
  }
}

/**
 * Probe the running Electron app for its actual runtime userData/appData path.
 * Uses the existing getAppInfo() IPC API (test-neutral, no production changes).
 * Sets _runtimeAppDataPath and derives _chatDbPath from it.
 *
 * LOCK-002: Asserts the actual disposable Dev path before any send/seed.
 */
async function probeRuntimeAppDataPath(page: Page): Promise<void> {
  const info = await page.evaluate(async () => {
    try {
      const api = (window as any).api
      const appInfo = await api.getAppInfo()
      if (!appInfo || typeof appInfo !== 'object') {
        return { ok: false, error: 'getAppInfo() returned non-object' }
      }
      if (!appInfo.appDataPath || typeof appInfo.appDataPath !== 'string') {
        return { ok: false, error: `appDataPath is not a string: ${typeof appInfo.appDataPath}` }
      }
      return { ok: true, appDataPath: appInfo.appDataPath }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  if (!info.ok) {
    throw new Error(`Failed to probe runtime appDataPath: ${info.error}`)
  }

  _runtimeAppDataPath = info.appDataPath

  // Derive chatDb path from the ACTUAL runtime path.
  // Use the raw runtime path (Electron may report /private/var/... which is valid).
  _chatDbPath = path.join(_runtimeAppDataPath, 'Data', 'chat.db')

  // LOCK-002: Assert the runtime path matches the expected disposable Dev path.
  // This ensures no config.json redirect to live user data.
  // NOTE: macOS resolves /var → /private/var via symlink. We resolve the parent
  // tmpdir (which always exists) and join the child name, since realpathSync
  // fails on non-existent paths.
  const devDirName = path.basename(_userDataDir) + 'Dev'
  const resolvedTmpdir = fs.realpathSync(path.dirname(_userDataDir))
  const expectedDevPath = path.join(resolvedTmpdir, devDirName)
  const resolvedRuntime = fs.realpathSync(path.dirname(_runtimeAppDataPath))
  const runtimeChildName = path.basename(_runtimeAppDataPath)
  if (resolvedRuntime !== resolvedTmpdir || runtimeChildName !== devDirName) {
    throw new Error(
      `LOCK-002 VIOLATION: Runtime appDataPath "${_runtimeAppDataPath}" ` +
        `(resolved parent: "${resolvedRuntime}", child: "${runtimeChildName}") ` +
        `does not match expected disposable Dev path "${expectedDevPath}" ` +
        `(resolved parent: "${resolvedTmpdir}", child: "${devDirName}"). ` +
        `A config.json override may be redirecting to live data.`
    )
  }

  console.log(`[E2E] Runtime appDataPath: ${_runtimeAppDataPath}`)
  console.log(`[E2E] Derived chatDb path: ${_chatDbPath}`)
}

/**
 * Verify ChatDb IPC is available and the native module loads correctly.
 * Throws immediately if any check fails (fail-fast).
 */
async function assertChatDbReady(page: Page): Promise<void> {
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

  console.log('[E2E] ChatDb IPC readiness: PASS (envelope ok=true, value=boolean)')
}

async function launchElectron(): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.', `--user-data-dir=${_userDataDir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, NODE_ENV: 'development', ELECTRON_RUN_AS_NODE: '' },
    timeout: 120000
  })
}

async function waitForMainElectronWindow(electronApp: ElectronApplication): Promise<Page> {
  const mainWindow = await electronApp.waitForEvent('window', {
    predicate: async (window) => {
      try {
        const title = await window.title()
        return title === 'Cherry Studio' || title.includes('Cherry')
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
 * Bypass onboarding: click "Skip" button on the welcome page, then
 * set localStorage so future loads skip it too.
 */
async function bypassOnboarding(page: Page): Promise<void> {
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
 * Seed the mock provider and default model into the Redux store.
 * Seeds directly into the running store (no page reload).
 */
async function seedMockProvider(page: Page, port: number): Promise<void> {
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

/**
 * Wait for the home/chat UI to be ready.
 */
async function waitForHomeReady(page: Page, timeout = 60000): Promise<void> {
  await page.waitForSelector('#root', { state: 'attached', timeout })
  await page.waitForSelector(
    ['#chat', '.inputbar-container', '[class*="Inputbar"]', '[class*="Container"]'].join(', '),
    { state: 'visible', timeout }
  )
  await page.waitForTimeout(1000)
}

/**
 * Assert that the textarea is ready for input (real Ant Design TextArea).
 */
async function assertTextareaReady(page: Page): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 30000 })
}

export const test = base.extend<ElectronFixtures>({
  userDataDir: async ({}, use) => {
    const runToken = getRequiredRunToken()
    const profileToken = `${runToken}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    _userDataDir = path.join(os.tmpdir(), `cherry-e2e-${profileToken}`)
    fs.mkdirSync(_userDataDir, { recursive: true })

    // LOCK-004: Register this profile in the invocation-owned registry.
    registerOwnedProfile(_userDataDir, runToken)

    // Do NOT pre-compute chatDbPath here — it will be set by probeRuntimeAppDataPath()
    // after app launch, using the actual runtime appDataPath from the running Electron process.
    _chatDbPath = null
    _runtimeAppDataPath = null

    await use(_userDataDir)

    // LOCK-003: Fixture-owned cleanup is primary. Remove and verify exact owned
    // base+Dev paths. Propagate aggregate errors after Electron/mock closure.
    const cleanupErrors: string[] = []
    const devDir = _userDataDir + 'Dev'

    // 1. Remove base dir
    try {
      fs.rmSync(_userDataDir, { recursive: true, force: true })
    } catch (err: any) {
      cleanupErrors.push(`Failed to remove base dir "${_userDataDir}": ${err.message}`)
    }

    // 2. Remove Dev dir
    try {
      fs.rmSync(devDir, { recursive: true, force: true })
    } catch (err: any) {
      cleanupErrors.push(`Failed to remove Dev dir "${devDir}": ${err.message}`)
    }

    // 3. Verify both paths are actually gone
    if (fs.existsSync(_userDataDir)) {
      cleanupErrors.push(`Base dir "${_userDataDir}" still exists after rmSync`)
    }
    if (fs.existsSync(devDir)) {
      cleanupErrors.push(`Dev dir "${devDir}" still exists after rmSync`)
    }

    // 4. Propagate aggregate errors — do not swallow
    if (cleanupErrors.length > 0) {
      console.error('[E2E] Cleanup errors:', cleanupErrors.join('; '))
      throw new Error(`Fixture cleanup failed (${cleanupErrors.length} error(s)): ${cleanupErrors.join('; ')}`)
    }

    _chatDbPath = null
    _runtimeAppDataPath = null
  },

  mockPort: async ({}, use) => {
    const server = await createMockServer()
    _mockPort = server.port
    await use(server.port)
    stopMockServer()
  },

  electronApp: async ({ userDataDir, mockPort }, use) => {
    _userDataDir = userDataDir
    _mockPort = mockPort
    const electronApp = await launchElectron()
    await use(electronApp)
    // Close Electron and wait for WAL flush
    await electronApp.close()
    await new Promise((resolve) => setTimeout(resolve, 3000))
    clearRequestLog()
  },

  mainWindow: async ({ electronApp, mockPort }, use) => {
    const mainWindow = await waitForMainElectronWindow(electronApp)

    // LOCK-001: Probe runtime appDataPath IMMEDIATELY after window/root readiness
    // and BEFORE any bypassOnboarding/seedMockProvider/localStorage/Redux mutation.
    // This ensures we detect any config.json redirect to live data before we touch anything.
    await probeRuntimeAppDataPath(mainWindow)

    await bypassOnboarding(mainWindow)
    await seedMockProvider(mainWindow, mockPort)
    await waitForHomeReady(mainWindow)
    await assertChatDbReady(mainWindow)
    await assertTextareaReady(mainWindow)
    await use(mainWindow)
  }
})

export { expect } from '@playwright/test'
export { getRequestLog, clearRequestLog, findProductRequest, findProductRequestAfter, getRequestSequence }
export { getRuntimeAppDataPath, getUserDataDir }
