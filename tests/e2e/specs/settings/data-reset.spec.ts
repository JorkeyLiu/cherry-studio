/**
 * Data Reset E2E — actual DataSettings Reset UI double-confirm + relaunch.
 *
 * Named outcome: DataSettings actual reset, not merely typed IPC. The test
 * drives the real Reset UI path end to end:
 *   - Sentinel chat data is created through the real UI (typed message send
 *     via the mock provider) with exact IDs captured from Redux.
 *   - A localStorage sentinel plus a non-chat Dexie (`CherryStudio.settings`)
 *     sentinel are seeded through public web APIs (no renderer imports).
 *   - The test arms a test-only interception of ONLY the Main
 *     `app:relaunch-app` IPC handler via `electronApp.evaluate` (established
 *     Main-evaluate pattern): the original handler (`app.relaunch()` +
 *     `app.exit(0)`) is replaced with a recorder that noops. This retains
 *     exact-token process ownership — the app stays alive under the
 *     fixture-owned handle instead of orphaning via `app.relaunch()`. The
 *     relaunched process is a fresh boot with the original handler intact.
 *   - The actual Reset button is clicked and both confirm modals are
 *     confirmed (`Are you sure you want to clear all data?` → `DATA LOST
 *     !!!`), so the real `BackupService.reset` runs: `localStorage.clear()`,
 *     Dexie `clearDatabase()`, typed `resetData()` IPC, success toast, and
 *     the timed relaunch call (intercepted + recorded).
 *   - Recovery is proved through public UI/state: success toast renders,
 *     both sentinels are gone pre-relaunch, the staged `Data.restore/chat.db`
 *     exists, and the intercepted relaunch was requested.
 *   - Same-profile relaunch uses the exact cleanup helpers; post-relaunch
 *     the main window boots (no crash), ChatDb IPC is ready (proves startup
 *     restore consumption — a missing-chat.db stage would fail Main init),
 *     the sentinel topic is gone via IPC, sentinels stay gone (config fresh
 *     boot), and a fresh assistant boot is present.
 *   - Post-exit: authoritative SQLite proof — sentinel topic/messages/blocks
 *     exactly absent, fresh DB valid (fixed batched verification plan).
 *
 * LOCK-001: unique disposable profile only; real profiles untouched.
 * LOCK-002: mock provider only; no live API.
 * LOCK-003: no handrolled fixture/onboarding — shared fixture + prepare-app
 *   helpers only; no screenshots/manual proof. No renderer source/model
 *   files are touched by this spec.
 */
import * as fs from 'fs'
import * as path from 'path'

import {
  expect,
  findProductRequestAfter,
  getChatDbPath,
  getOwnedTmpRoot,
  getRequestSequence,
  getRuntimeAppDataPath,
  getUserDataDir,
  queryChatDbViaElectron,
  test,
  verifyChatDbViaElectron
} from '../../fixtures/electron.fixture'
import { SettingsPage } from '../../pages/settings.page'
import { SidebarPage } from '../../pages/sidebar.page'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import {
  assertChatDbReady,
  assertTextareaReady,
  bypassOnboarding,
  launchElectronApp,
  seedMockProvider,
  waitForHomeReady,
  waitForMainElectronWindow
} from '../../utils/prepare-app'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { probeAndAssertRuntimeAppData } from '../../utils/runtime-app-data'
import { waitForAppReady, waitForNotification, waitForSettingsLoad } from '../../utils/wait-helpers'

// ---------------------------------------------------------------------------
// Spec-local constants + helpers (same house pattern as conversation specs)
// ---------------------------------------------------------------------------

const LOCAL_STORAGE_SENTINEL_KEY = 'e2e-data-reset-sentinel'
const DEXIE_DB_NAME = 'CherryStudio'
const DEXIE_SETTINGS_STORE = 'settings'
const DEXIE_SENTINEL_ID = 'e2e-data-reset-sentinel'
const FIRST_CONFIRM_CONTENT = 'Are you sure you want to clear all data?'
const SECOND_CONFIRM_TITLE = 'DATA LOST !!!'
const RESET_SUCCESS_TOAST = 'Data reset successful'

/** Fail-closed SQLite row accessor: typed outcome is never null. */
function queryRows(dbPath: string, sql: string): any[] {
  const result = queryChatDbViaElectron(dbPath, sql)
  if (!result.ok) throw new Error(`SQLite query failed: ${result.code}`)
  return result.rows as any[]
}

/** Type text into the real textarea and submit via Enter key. */
async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()
  await page.evaluate(
    ({ selector, text }) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement
      if (!el) throw new Error('Textarea not found')
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSetter) throw new Error('No native textarea setter')
      nativeSetter.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { selector: '.inputbar textarea, textarea[placeholder]', text }
  )
  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
}

/** Wait for at least one assistant message to appear for the topic in Redux. */
async function waitForAssistantResponse(
  page: import('@playwright/test').Page,
  topicId: string,
  timeout = 90000
): Promise<void> {
  await page.waitForFunction(
    ({ topicId }: { topicId: string }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
      return msgIds.some((id: string) => s.messages.entities?.[id]?.role === 'assistant')
    },
    { topicId },
    { timeout }
  )
  await page.waitForFunction(
    ({ topicId }: { topicId: string }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      return !s.messages?.loadingByTopic?.[topicId]
    },
    { topicId },
    { timeout }
  )
}

/** Seed a non-chat Dexie sentinel via public IndexedDB (no renderer imports). */
async function writeDexieSentinel(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(
    ({ dbName, store, id }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(dbName)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(store)) {
            db.close()
            reject(new Error(`Dexie store missing: ${store}`))
            return
          }
          const tx = db.transaction(store, 'readwrite')
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => {
            db.close()
            reject(tx.error)
          }
          tx.objectStore(store).put({ id, value: 'sentinel' })
        }
      }),
    { dbName: DEXIE_DB_NAME, store: DEXIE_SETTINGS_STORE, id: DEXIE_SENTINEL_ID }
  )
}

/** True when the non-chat Dexie sentinel record is present. */
async function hasDexieSentinel(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(
    ({ dbName, store, id }) =>
      new Promise<boolean>((resolve, reject) => {
        const req = indexedDB.open(dbName)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(store)) {
            db.close()
            resolve(false)
            return
          }
          const tx = db.transaction(store, 'readonly')
          const get = tx.objectStore(store).get(id)
          get.onsuccess = () => {
            const present = get.result !== undefined
            db.close()
            resolve(present)
          }
          get.onerror = () => {
            db.close()
            reject(get.error)
          }
        }
      }),
    { dbName: DEXIE_DB_NAME, store: DEXIE_SETTINGS_STORE, id: DEXIE_SENTINEL_ID }
  )
}

test.describe('Data Reset — actual Reset UI double-confirm', () => {
  test('actual reset clears renderer state, stages a fresh DB, and relaunch boots empty', async ({
    electronApp,
    mainWindow,
    mockPort
  }) => {
    test.setTimeout(240000)
    const userDataDir = getUserDataDir()
    const ownedTmpRoot = getOwnedTmpRoot()
    let sidebarPage: SidebarPage
    let settingsPage: SettingsPage

    // ── 1. Sentinel durable chat data through the real UI + mock provider ──
    const sentinelText = `data-reset-sentinel-${Date.now()}`
    const requestSeqBefore = getRequestSequence()
    const { topicId: sentinelTopicId } = await mainWindow.evaluate(() => {
      const s = (window as any).store.getState()
      const assistant = s.assistants.assistants[0]
      return { topicId: assistant?.topics?.[0]?.id || '' }
    })
    expect(sentinelTopicId).not.toBe('')
    await uiSendMessage(mainWindow, sentinelText)
    await waitForAssistantResponse(mainWindow, sentinelTopicId)

    // Mock provider actually served the request (real provider path).
    expect(findProductRequestAfter(requestSeqBefore)).toBeDefined()

    const sentinelIds = await mainWindow.evaluate(
      ({ topicId }) => {
        const s = (window as any).store.getState()
        const msgIds: string[] = s.messages?.messageIdsByTopic?.[topicId] || []
        const blockIds: string[] = []
        for (const id of msgIds) {
          const blocks = s.messageBlocks?.blockIdsByMessage?.[id] || []
          blockIds.push(...blocks)
        }
        return { messageIds: msgIds, blockIds }
      },
      { topicId: sentinelTopicId }
    )
    expect(sentinelIds.messageIds.length).toBeGreaterThan(0)
    console.log(`[E2E] [DataReset] sentinel topic=${sentinelTopicId} messages=${sentinelIds.messageIds.length}`)

    // ── 2. Seed renderer-state sentinels (public web APIs only) ──
    await mainWindow.evaluate((key) => localStorage.setItem(key, 'sentinel'), LOCAL_STORAGE_SENTINEL_KEY)
    await writeDexieSentinel(mainWindow)
    expect(await hasDexieSentinel(mainWindow)).toBe(true)

    // ── 3. Arm test-only interception of ONLY the Main relaunch IPC ──
    // The original `app:relaunch-app` handler (`app.relaunch()` + hard
    // `app.exit(0)`, src/main/ipc.ts) would orphan the fixture-owned process
    // handle. The recorder below noops relaunch and records the request; the
    // test then performs the explicit owned close + same-profile relaunch.
    await electronApp.evaluate(({ ipcMain }: typeof import('electron')) => {
      const state = globalThis as unknown as Record<string, unknown>
      if (state.__e2eDataResetRelaunchArmed !== true) {
        state.__e2eDataResetRelaunchArmed = true
        state.__e2eDataResetRelaunchRequested = false
        ipcMain.removeHandler('app:relaunch-app')
        ipcMain.handle('app:relaunch-app', () => {
          state.__e2eDataResetRelaunchRequested = true
        })
      }
    })
    const wasRelaunchRequested = (): Promise<boolean> =>
      electronApp.evaluate(
        () => (globalThis as unknown as Record<string, unknown>).__e2eDataResetRelaunchRequested === true
      )
    expect(await wasRelaunchRequested()).toBe(false)

    // ── 4. Actual Reset UI path: Settings → Data → Reset → double confirm ──
    await waitForAppReady(mainWindow)
    sidebarPage = new SidebarPage(mainWindow)
    settingsPage = new SettingsPage(mainWindow)
    await sidebarPage.goToSettings()
    await waitForSettingsLoad(mainWindow)
    await settingsPage.goToData()
    await waitForSettingsLoad(mainWindow)
    const resetButton = mainWindow.locator('button', { hasText: 'Data Reset' }).first()
    await expect(resetButton).toBeVisible({ timeout: 10000 })
    await resetButton.click()

    // window.modal is antd Modal.useModal: confirm dialogs render buttons in
    // .ant-modal-confirm-btns, NOT .ant-modal-footer (footer exists only on
    // plain Modals). Scope each dialog by its text and click the OK button by
    // role/name — the danger-styled OK keeps the accessible name "OK".
    const firstDialog = mainWindow.getByRole('dialog').filter({ hasText: FIRST_CONFIRM_CONTENT })
    await expect(firstDialog).toBeVisible({ timeout: 15000 })
    await firstDialog.getByRole('button', { name: 'OK', exact: true }).click()

    const secondDialog = mainWindow.getByRole('dialog').filter({ hasText: SECOND_CONFIRM_TITLE })
    await expect(secondDialog).toBeVisible({ timeout: 15000 })
    await secondDialog.getByRole('button', { name: 'OK', exact: true }).click()

    // The real BackupService.reset ran to completion: success toast renders.
    await waitForNotification(mainWindow)
    await expect(mainWindow.locator('.ant-message, .ant-notification')).toContainText(RESET_SUCCESS_TOAST, {
      timeout: 15000
    })

    // Renderer recovery proved through public state: localStorage cleared and
    // the non-chat Dexie sentinel removed by the actual reset function.
    expect(await mainWindow.evaluate((key) => localStorage.getItem(key), LOCAL_STORAGE_SENTINEL_KEY)).toBeNull()
    expect(await hasDexieSentinel(mainWindow)).toBe(false)
    console.log('[E2E] [DataReset] actual reset ran: toast shown, renderer sentinels cleared')

    // The timed relaunch call was issued (intercepted, app still owned).
    const relaunchDeadline = Date.now() + 60000
    let relaunchRequested = false
    while (Date.now() < relaunchDeadline) {
      relaunchRequested = await wasRelaunchRequested()
      if (relaunchRequested) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(relaunchRequested).toBe(true)

    // Staged Data.restore/chat.db exists pre-relaunch at the RUNTIME path.
    const runtimeAppDataPath = getRuntimeAppDataPath()
    expect(runtimeAppDataPath).not.toBeNull()
    const stagedDbPath = path.join(runtimeAppDataPath!, 'Data.restore', 'chat.db')
    expect(fs.existsSync(stagedDbPath)).toBe(true)
    console.log(`[E2E] [DataReset] staged reset DB present at ${stagedDbPath}`)

    // ── 5. Same-profile relaunch with exact cleanup helpers ──
    await electronApp.close()
    await new Promise((resolve) => setTimeout(resolve, 3000))

    const relaunchedApp = await launchElectronApp({ userDataDir, ownedTmpRoot })
    try {
      const relaunchedWindow = await waitForMainElectronWindow(relaunchedApp)
      const probed = await probeAndAssertRuntimeAppData(relaunchedWindow, userDataDir)
      await bypassOnboarding(relaunchedWindow)
      await seedMockProvider(relaunchedWindow, mockPort)
      await waitForHomeReady(relaunchedWindow)
      // Main IPC ready proves startup restore consumption succeeded: a
      // missing-chat.db stage would fail Main chat init (no silent boot).
      await assertChatDbReady(relaunchedWindow)
      await assertTextareaReady(relaunchedWindow)

      // No crash: window booted with the product title and React root.
      expect(await relaunchedWindow.title()).toContain('Cherry')
      await relaunchedWindow.waitForSelector('#root', { state: 'attached', timeout: 30000 })

      // Sentinel topic gone via Main IPC; fresh assistant boot present.
      const postState = await relaunchedWindow.evaluate(
        ({ sentinelTopicId }) => {
          const api = (window as any).api
          const s = (window as any).store.getState()
          const assistants = s.assistants?.assistants || []
          const allTopicIds: string[] = []
          for (const a of assistants) {
            for (const t of a?.topics || []) allTopicIds.push(t.id)
          }
          return api.chatDb.topicExists({ topicId: sentinelTopicId }).then((result: any) => ({
            topicExistsResult: result,
            assistantCount: assistants.length,
            sentinelInRedux: allTopicIds.includes(sentinelTopicId)
          }))
        },
        { sentinelTopicId }
      )
      expect(postState.topicExistsResult?.ok).toBe(true)
      expect(postState.topicExistsResult?.value).toBe(false)
      expect(postState.sentinelInRedux).toBe(false)
      expect(postState.assistantCount).toBeGreaterThan(0)

      // Config fresh boot: renderer sentinels stay gone after relaunch.
      expect(await relaunchedWindow.evaluate((key) => localStorage.getItem(key), LOCAL_STORAGE_SENTINEL_KEY)).toBeNull()
      expect(await hasDexieSentinel(relaunchedWindow)).toBe(false)
      console.log(
        `[E2E] [DataReset] post-relaunch: sentinel gone via IPC, assistants=${postState.assistantCount}, renderer state fresh`
      )

      // ChatDb path is unchanged for the same profile.
      expect(probed.chatDbPath).toBe(getChatDbPath())
    } finally {
      // Exact-clean the relaunched instance; fixture teardown is idempotent.
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => relaunchedApp.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }

    // ── 6. Authoritative post-exit SQLite proof at the runtime path ──
    const chatDbPath = getChatDbPath()
    expect(chatDbPath).not.toBeNull()
    expect(fs.existsSync(chatDbPath!)).toBe(true)
    const esc = (value: string) => value.replace(/'/g, "''")

    const sentinelTopicRows = queryRows(chatDbPath!, `SELECT id FROM topics WHERE id = '${esc(sentinelTopicId)}'`)
    expect(sentinelTopicRows.length).toBe(0)

    if (sentinelIds.messageIds.length > 0) {
      const msgIdList = sentinelIds.messageIds.map((id) => `'${esc(id)}'`).join(',')
      expect(queryRows(chatDbPath!, `SELECT id FROM messages WHERE id IN (${msgIdList})`).length).toBe(0)
    }
    if (sentinelIds.blockIds.length > 0) {
      const blockIdList = sentinelIds.blockIds.map((id) => `'${esc(id)}'`).join(',')
      expect(queryRows(chatDbPath!, `SELECT id FROM message_blocks WHERE id IN (${blockIdList})`).length).toBe(0)
    }

    // Fresh DB is valid: fixed batched verification plan passes.
    const verified = verifyChatDbViaElectron(chatDbPath!)
    expect(verified?.ok).toBe(true)
    console.log('[E2E] [DataReset] post-exit SQLite proof: sentinel absent, fresh DB valid')
  })
})
