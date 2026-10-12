/**
 * Removed capabilities regression — MCP / external+provider-native websearch / global memory / OCR.
 *
 * User-authorized full removal; retained: MinerU document processing
 * (PreprocessSettings on the real `/settings/docprocess` route), model native
 * image input, knowledge base, inputbar native webpage context (Anthropic
 * webFetch_20260209 / Google urlContext), ordinary chat, old-data
 * compatibility. No live network, no API keys, no user data, no manual
 * Electron launch — standard shared fixture only.
 *
 * Source vs legacy/schema vs authority (README §7/§11):
 * - Source: current SettingsPage routes/menu, preload `window.api`, Redux
 *   slices, Inputbar tool registry ordering, Assistant type fields.
 * - Legacy/schema: pre-227 `persist:cherry-studio` payload (mcp/memory/
 *   websearch/ocr slices + assistant legacy fields + inputTools legacy keys,
 *   `_persist.version=225`) run through migrations 226+227 on same-profile
 *   relaunch (227 strips the ocr slice; 226 strips the other three).
 * - Authority: ordinary chat SQLite `chat.db` via `queryChatDbViaElectron` at
 *   the runtime path; mock request logs prove the AI SDK actually sent the
 *   request; Redux/UI alone are never persistence proof.
 *
 * Coverage (cross UI / persistence / IPC / native request):
 * 1. Settings menu + docprocess route + assistant popup + inputbar absence;
 *    preload/store expose none of the four capabilities; preprocess/MinerU,
 *    urlContext + knowledge retained (real DOM, not source grep).
 * 2. Same-profile legacy persist injection → relaunchSameProfile proves
 *    migration 227 strips all four slices, retains urlContext + preprocess
 *    MinerU configs, and the same profile still sends ordinary chat (real
 *    input + mock request + ChatDb).
 * 3. Mock Anthropic provider + real urlContext toggle + URL send proves the
 *    final Anthropic payload carries the native web_fetch tool and no
 *    web_search/MCP/memory/OCR injection; mock reply only (no real fetch claim).
 * 4. Knowledge route + toolbar entry smoke only (retrieval covered by unit).
 *
 * No new Gemini endpoint and no new vision/image mock facility: aiCore
 * already covers urlContext via mock factory (2 cases). Mock helper
 * unchanged: `parsed` already exposes tool fields and
 * `findAnthropicRequestAfter` already inspects them.
 */
import * as fs from 'fs'

import {
  clearRequestLog,
  expect,
  findAnthropicRequestAfter,
  findProductRequestAfter,
  getChatDbPath,
  getRequestSequence,
  getRuntimeAppDataPath,
  getUserDataDir,
  queryChatDbViaElectron,
  test
} from '../../fixtures/electron.fixture'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { relaunchSameProfile } from '../../utils/restart-electron-profile'
import { waitForAppReady } from '../../utils/wait-helpers'

test.describe('Removed capabilities regression (MCP / websearch / memory / OCR)', () => {
  test.setTimeout(300000)

  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
  })

  // ---------------------------------------------------------------------------
  // Shared helpers (ordinary-chat production path, verbatim)
  // ---------------------------------------------------------------------------

  async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
    const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
    await textarea.waitFor({ state: 'visible', timeout: 15000 })
    await textarea.click()
    await page.evaluate(
      ({ text }) => {
        const el = document.querySelector('.inputbar textarea, textarea[placeholder]') as HTMLTextAreaElement
        if (!el) throw new Error('Textarea not found')
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        if (!nativeSetter) throw new Error('No native textarea setter')
        nativeSetter.call(el, text)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      },
      { text }
    )
    await expect(textarea).toHaveValue(text, { timeout: 5000 })
    await textarea.press('Enter')
  }

  async function waitForAssistantResponseComplete(
    page: import('@playwright/test').Page,
    topicId: string,
    previousAssistantCount: number,
    timeout = 60000
  ): Promise<void> {
    await page.waitForFunction(
      ({ topicId, prevCount }: { topicId: string; prevCount: number }) => {
        const s = (window as any).store?.getState()
        if (!s) return false
        const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
        let count = 0
        for (const id of msgIds) {
          if (s.messages.entities?.[id]?.role === 'assistant') count++
        }
        return count > prevCount
      },
      { topicId, prevCount: previousAssistantCount },
      { timeout }
    )
    await page.waitForFunction(
      ({ topicId }: { topicId: string }) => {
        const s = (window as any).store?.getState()
        if (!s || s.messages?.loadingByTopic?.[topicId]) return false
        const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
        let latest: string | null = null
        for (let i = msgIds.length - 1; i >= 0; i--) {
          if (s.messages.entities?.[msgIds[i]]?.role === 'assistant') {
            latest = msgIds[i]
            break
          }
        }
        if (!latest) return false
        const msg = s.messages.entities[latest]
        if (msg.status !== 'success' && msg.status !== 'error') return false
        const blocks = msg.blocks || []
        if (blocks.length === 0) return false
        return blocks.every((blockId: string) => {
          const block = s.messageBlocks?.entities?.[blockId]
          return block && (block.status === 'success' || block.status === 'error')
        })
      },
      { topicId },
      { timeout }
    )
  }

  async function getActiveTopicId(page: import('@playwright/test').Page): Promise<string> {
    return page.evaluate(() => {
      const s = (window as any).store.getState()
      const assistant = s.assistants.assistants[0]
      return assistant?.topics?.[0]?.id ?? ''
    })
  }

  async function assistantCount(page: import('@playwright/test').Page, topicId: string): Promise<number> {
    return page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      const msgIds = s.messages.messageIdsByTopic[tid] || []
      let count = 0
      for (const id of msgIds) {
        if (s.messages.entities[id]?.role === 'assistant') count++
      }
      return count
    }, topicId)
  }

  // ---------------------------------------------------------------------------
  // 1. Removal surface + retention (settings menu / assistant popup / inputbar /
  //    preload+store; urlContext + knowledge retained)
  // ---------------------------------------------------------------------------

  test('removed settings entries absent, capability surfaces stripped, docprocess retained without OCR, urlContext+knowledge retained', async ({
    mainWindow
  }) => {
    const page = mainWindow

    await test.step('real sidebar click opens settings', async () => {
      await page.getByTestId('sidebar-nav-settings').click()
      await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: 15000 })
    })

    await test.step('settings menu has no MCP/websearch/memory/OCR href entries (structural, not translation)', async () => {
      // Accurate locators: structural hrefs on real <a> links + link roles.
      await expect(page.locator('a[href*="/settings/mcp"]')).toHaveCount(0)
      await expect(page.locator('a[href*="/settings/memory"]')).toHaveCount(0)
      await expect(page.locator('a[href*="/settings/websearch"]')).toHaveCount(0)
      await expect(page.locator('a[href*="/settings/ocr"]')).toHaveCount(0)
      // Retention: the document-processing route keeps exactly one menu entry.
      await expect(page.locator('a[href*="/settings/docprocess"]')).toHaveCount(1)
      // Exhaustive menu inventory: no settings link may point at removed routes.
      const hrefs = await page
        .locator('a[href*="/settings/"]')
        .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute('href') ?? ''))
      expect(hrefs.length).toBeGreaterThan(0)
      for (const href of hrefs) {
        expect(href).not.toMatch(/\/settings\/(mcp|memory|websearch|ocr)/)
      }
      // Role dimension: the settings menu renders real links; none carries a
      // removed accessible destination.
      const linkCount = await page.getByRole('link').count()
      expect(linkCount).toBeGreaterThan(0)
      // Direct navigation to a removed route must not produce removed content.
      await page.evaluate(() => {
        window.location.hash = '#/settings/mcp'
      })
      await page.waitForTimeout(800)
      await expect(page.locator('a[href*="/settings/mcp"]')).toHaveCount(0)
      await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: 15000 })
    })

    await test.step('preload and store expose no MCP/memory/search/OCR capability', async () => {
      const surfaces = await page.evaluate(() => {
        const api = (window as any).api ?? {}
        const state = (window as any).store?.getState() ?? {}
        return {
          hasMcpApi: typeof api.mcp !== 'undefined',
          hasMemoryApi: typeof api.memory !== 'undefined',
          hasSearchServiceApi: typeof api.searchService !== 'undefined',
          hasOcrApi: typeof api.ocr !== 'undefined',
          apiKeys: Object.keys(api),
          hasMcpSlice: typeof state.mcp !== 'undefined',
          hasMemorySlice: typeof state.memory !== 'undefined',
          hasWebsearchSlice: typeof state.websearch !== 'undefined',
          hasOcrSlice: typeof state.ocr !== 'undefined'
        }
      })
      expect(surfaces.hasMcpApi, `window.api must not expose mcp (keys: ${surfaces.apiKeys.join(',')})`).toBe(false)
      expect(surfaces.hasMemoryApi, 'window.api must not expose memory').toBe(false)
      expect(surfaces.hasSearchServiceApi, 'window.api must not expose searchService').toBe(false)
      expect(surfaces.hasOcrApi, `window.api must not expose ocr (keys: ${surfaces.apiKeys.join(',')})`).toBe(false)
      expect(surfaces.hasMcpSlice, 'Redux must not retain mcp slice').toBe(false)
      expect(surfaces.hasMemorySlice, 'Redux must not retain memory slice').toBe(false)
      expect(surfaces.hasWebsearchSlice, 'Redux must not retain websearch slice').toBe(false)
      expect(surfaces.hasOcrSlice, 'Redux must not retain ocr slice').toBe(false)
    })

    await test.step('real docprocess route retains preprocess/MinerU with no OCR surface (real DOM)', async () => {
      // Real route confirmed in SettingsPage (`/settings/docprocess`): the
      // document-processing entry point stays, only the OCR service goes.
      await page.evaluate(() => {
        window.location.hash = '#/settings/docprocess'
      })
      await expect(page).toHaveURL(/.*#\/settings\/docprocess.*/, { timeout: 10000 })
      await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: 15000 })
      // OCR absence on the real rendered DOM (all locales: en + zh-cn +
      // zh-tw), not a source grep: neither the OCR section title nor the OCR
      // image-provider row may render. (PaddleOCR-as-preprocess is a separate
      // provider surface and is never asserted absent here.)
      await expect(page.getByText(/OCR\s*服|OCR service/i)).toHaveCount(0)
      await expect(page.getByText(/OCR\s*服.{0,3}提供|OCR\s*服.{0,3}供應|OCR service provider/i)).toHaveCount(0)
      // Preprocess retention on the real rendered DOM: the content-area
      // provider row label (the menu shows only the section title) plus the
      // default MinerU selection and a real select control.
      await expect(page.getByText(/文档处理服务商|文件處理供應商|Document Processing Provider/i).first()).toBeVisible({
        timeout: 15000
      })
      await expect(page.locator('.ant-select').first()).toBeVisible({ timeout: 15000 })
      await expect(page.getByText('MinerU', { exact: false }).first()).toBeVisible({ timeout: 15000 })
      // Redux oracle for the same retention: preprocess slice keeps MinerU.
      const preprocess = await page.evaluate(() => {
        const s = (window as any).store.getState()
        return {
          retained: typeof s.preprocess !== 'undefined',
          defaultProvider: s.preprocess?.defaultProvider ?? null,
          providerIds: Array.isArray(s.preprocess?.providers) ? s.preprocess.providers.map((p: any) => p?.id) : []
        }
      })
      expect(preprocess.retained, 'Redux must retain preprocess slice').toBe(true)
      expect(preprocess.defaultProvider).toBe('mineru')
      expect(preprocess.providerIds).toContain('mineru')
    })

    await test.step('assistant popup exposes only prompt/model/knowledge_base tabs', async () => {
      // Real UI path: right-click the live assistant row, take the first
      // context-menu item (Edit — locale-independent position, same pattern as
      // provider-endpoint-mode.spec.ts), then read structural menu keys.
      const assistantName = await page.evaluate(
        () => (window as any).store.getState().assistants.assistants[0]?.name ?? ''
      )
      expect(assistantName).not.toBe('')
      // Return home first: the assistant list lives on the home route.
      await page.evaluate(() => {
        window.location.hash = '#/'
      })
      await expect(page.locator('#home-page')).toBeVisible({ timeout: 15000 })
      const row = page.getByText(assistantName, { exact: false }).first()
      await expect(row).toBeVisible({ timeout: 15000 })
      await row.click({ button: 'right' })
      const editItem = page.locator('[role="menu"] [role="menuitem"]').first()
      await expect(editItem).toBeVisible({ timeout: 10000 })
      await editItem.click()
      const modal = page.locator('.ant-modal').last()
      await expect(modal).toBeVisible({ timeout: 10000 })
      // Structural keys: Ant Menu synthesizes `data-menu-id` as
      // `rc-menu-uuid-<instance>-<key>` (e.g. `rc-menu-uuid-78553-2-model`);
      // the stable source keys live in AssistantSettings `items`
      // (`model`/`prompt`/`knowledge_base`, no `messages`). Normalize the
      // dynamic uuid prefix, then assert exact element equality (never
      // substring) for both retained and forbidden keys.
      const rawMenuKeys = await modal
        .locator('.ant-menu-item[data-menu-id]')
        .evaluateAll((els) => els.map((el) => (el as HTMLElement).getAttribute('data-menu-id') ?? ''))
      expect(rawMenuKeys.length).toBeGreaterThan(0)
      const normalizeMenuKey = (k: string): string => k.replace(/^rc-menu-uuid-[\d-]+-/, '')
      const menuKeys = rawMenuKeys.map(normalizeMenuKey)
      expect(menuKeys).toContain('model')
      expect(menuKeys).toContain('prompt')
      expect(menuKeys).toContain('knowledge_base')
      expect(
        menuKeys,
        'assistant popup has no messages tab (source items carry only model/prompt/knowledge_base)'
      ).not.toContain('messages')
      for (const forbidden of ['mcp', 'memory', 'web_search', 'websearch', 'mcp_tools', 'ocr']) {
        expect(menuKeys, `assistant popup must not contain ${forbidden}`).not.toContain(forbidden)
      }
      // Role dimension: real menuitem roles exist for the retained tabs.
      expect(await modal.getByRole('menuitem').count()).toBe(menuKeys.length)
      // Close via the real modal close button (footer is null on this popup;
      // Escape alone is focus-dependent and flaky after menu interaction).
      const closeButton = modal.locator('.ant-modal-close').first()
      await expect(closeButton).toBeVisible({ timeout: 10000 })
      await closeButton.click()
      await expect(modal).toBeHidden({ timeout: 10000 })
    })

    await test.step('inputbar ordering carries no removed keys; knowledge entry retained', async () => {
      const tools = await page.evaluate(() => {
        const s = (window as any).store.getState()
        return {
          visible: s.inputTools?.toolOrder?.visible ?? [],
          hidden: s.inputTools?.toolOrder?.hidden ?? []
        }
      })
      for (const key of ['web_search', 'mcp_tools']) {
        expect(tools.visible, `inputTools.visible must not contain ${key}`).not.toContain(key)
        expect(tools.hidden, `inputTools.hidden must not contain ${key}`).not.toContain(key)
      }
      expect(tools.visible).toContain('knowledge_base')
      // Knowledge toolbar entry renders (role button + aria-label contract);
      // the popover exposes the locale-independent kb-add entry point.
      await page.evaluate(() => {
        window.location.hash = '#/'
      })
      await expect(page.locator('#home-page')).toBeVisible({ timeout: 15000 })
      const kbButton = page.getByRole('button', { name: /知识库|知識庫|Knowledge/i }).first()
      await expect(kbButton).toBeVisible({ timeout: 15000 })
      await kbButton.click()
      await expect(page.getByTestId('kb-add')).toBeVisible({ timeout: 10000 })
      await page.keyboard.press('Escape')
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Legacy persist migration + same-profile ordinary chat authority
  // ---------------------------------------------------------------------------

  test('pre-227 legacy persist migrates on same-profile relaunch; same profile still chats', async ({
    electronApp,
    mainWindow,
    mockPort,
    userDataDir,
    ownedTmpRoot
  }) => {
    const page = mainWindow
    const chatDbPath = getChatDbPath()
    expect(chatDbPath, 'fixture must have captured the disposable chat.db path').toBeTruthy()
    let relaunched: Awaited<ReturnType<typeof relaunchSameProfile>> | null = null
    let bodyFailure: unknown = null
    const cleanupErrors: string[] = []

    try {
      await test.step('inject pre-227 legacy persist payload (same key, old schema only)', async () => {
        // Same protected key `persist:cherry-studio`; only values mutate.
        // Legacy schema: mcp/memory/websearch/ocr slices + assistant legacy
        // fields + inputTools legacy ordering keys, pinned to version 225 so
        // the terminal 226+227 scrubs run on the next launch.
        // Writer guard (mirrors disposable-seed-zip seedLocalStorageProjection
        // steps 0/3): PAUSE the app's own redux-persist writer and drain any
        // already-scheduled write BEFORE touching the wire — otherwise the live
        // writer overwrites the injected legacy payload before close and the
        // migration never runs. No direct persistor reference from the spec;
        // the store dispatch is the existing owned surface.
        const injected = await page.evaluate(async () => {
          const KEY = 'persist:cherry-studio'
          ;(window as { store?: { dispatch?: (action: { type: string }) => void } }).store?.dispatch?.({
            type: 'persist/PAUSE'
          })
          await new Promise((resolve) => setTimeout(resolve, 500))
          const raw = localStorage.getItem(KEY)
          if (!raw) throw new Error('persist:cherry-studio missing')
          const outer = JSON.parse(raw) as Record<string, unknown>
          const parseSlice = (k: string): any => {
            const v = outer[k]
            if (typeof v !== 'string') return null
            try {
              return JSON.parse(v)
            } catch {
              return null
            }
          }
          const writeSlice = (k: string, v: unknown): void => {
            outer[k] = JSON.stringify(v)
          }
          const assistantsSlice = parseSlice('assistants')
          if (!assistantsSlice || !Array.isArray(assistantsSlice.assistants)) {
            throw new Error('assistants slice shape unexpected')
          }
          const legacyAssistantPatch = {
            enableWebSearch: true,
            webSearchProviderId: 'tavily',
            mcpMode: 'manual',
            mcpServers: [{ id: 'legacy-mcp', name: 'legacy-mcp' }],
            enableMemory: true,
            enableUrlContext: true,
            knowledge_bases: []
          }
          Object.assign(assistantsSlice.assistants[0], legacyAssistantPatch)
          if (assistantsSlice.assistantDefaults && typeof assistantsSlice.assistantDefaults === 'object') {
            Object.assign(assistantsSlice.assistantDefaults, {
              enableWebSearch: true,
              mcpMode: 'manual',
              enableMemory: true,
              enableUrlContext: true
            })
          }
          writeSlice('assistants', assistantsSlice)
          const inputToolsSlice = parseSlice('inputTools') ?? { toolOrder: { visible: [], hidden: [] } }
          const visible = Array.isArray(inputToolsSlice.toolOrder?.visible)
            ? [...inputToolsSlice.toolOrder.visible]
            : ['new_topic', 'attachment', 'thinking', 'url_context', 'knowledge_base']
          if (!visible.includes('web_search')) visible.push('web_search')
          if (!visible.includes('mcp_tools')) visible.push('mcp_tools')
          inputToolsSlice.toolOrder = { visible, hidden: inputToolsSlice.toolOrder?.hidden ?? [] }
          writeSlice('inputTools', inputToolsSlice)
          writeSlice('mcp', { servers: [{ id: 'legacy-mcp', name: 'legacy-mcp' }] })
          writeSlice('memory', { memoryConfig: { llmApiClient: 'legacy', embedderApiClient: 'legacy' } })
          writeSlice('websearch', {
            providers: [{ id: 'tavily', apiKey: 'legacy' }],
            maxResults: 5,
            searchWithTime: true
          })
          writeSlice('ocr', {
            providers: [
              { id: 'system', name: 'System' },
              { id: 'tesseract', name: 'Tesseract' }
            ],
            imageProviderId: 'system'
          })
          const persistRaw = outer._persist
          if (typeof persistRaw === 'string') {
            const persistObj = JSON.parse(persistRaw)
            persistObj.version = 225
            outer._persist = JSON.stringify(persistObj)
          } else if (persistRaw && typeof persistRaw === 'object') {
            ;(persistRaw as Record<string, unknown>).version = 225
          } else {
            outer._persist = JSON.stringify({ version: 225, rehydrated: true })
          }
          localStorage.setItem(KEY, JSON.stringify(outer))
          // Readback proof (seed step 3): the exact wire now carries version
          // 225 + all four legacy slices before close.
          const readback = localStorage.getItem(KEY)
          if (readback !== JSON.stringify(outer)) throw new Error('legacy persist readback mismatch')
          const checkOuter = JSON.parse(readback) as Record<string, unknown>
          const checkPersistRaw = checkOuter._persist
          const checkVersion =
            typeof checkPersistRaw === 'string'
              ? (JSON.parse(checkPersistRaw) as Record<string, unknown>).version
              : (checkPersistRaw as Record<string, unknown> | null)?.version
          if (checkVersion !== 225) throw new Error(`legacy persist version readback mismatch: ${String(checkVersion)}`)
          for (const k of ['mcp', 'memory', 'websearch', 'ocr']) {
            if (typeof checkOuter[k] !== 'string') throw new Error(`legacy slice ${k} missing on the wire`)
          }
          return {
            assistantId: assistantsSlice.assistants[0]?.id ?? '',
            versionSet: 225
          }
        })
        expect(injected.assistantId).not.toBe('')
        expect(injected.versionSet).toBe(225)
        // Stability proof: the paused writer must not overwrite the legacy
        // wire before close. Poll (never fixed-sleep-gated) that the wire
        // version stays 225.
        await page.waitForFunction(
          (key: string) => {
            try {
              const raw = localStorage.getItem(key)
              if (!raw) return false
              const outer = JSON.parse(raw)
              const persistRaw = (outer as Record<string, unknown>)._persist
              const version =
                typeof persistRaw === 'string'
                  ? (JSON.parse(persistRaw) as Record<string, unknown>).version
                  : ((persistRaw as Record<string, unknown> | null)?.version ?? null)
              return version === 225
            } catch {
              return false
            }
          },
          'persist:cherry-studio',
          { timeout: 10000 }
        )
      })

      await test.step('close, relaunch same disposable profile, prove 227 scrub', async () => {
        // Close handshake triggers Main ↔ renderer save-data (`persistor.flush`
        // + ack). The writer is paused, so the flush is a no-op over the
        // already-queued keys and the injected legacy wire survives; the
        // graceful close then durably commits Chromium LevelDB to disk.
        await closeElectronWithExactCleanup(userDataDir, {
          close: () => electronApp.close(),
          findExactProcesses: findProcessesByUserDataDir,
          terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
        })
        await new Promise((resolve) => setTimeout(resolve, 2000))
        relaunched = await relaunchSameProfile({ userDataDir, ownedTmpRoot, mockPort })
        const rpage = relaunched.page
        await rpage.waitForFunction(() => typeof (window as any).store !== 'undefined', { timeout: 30000 })
        // Effectiveness criterion 1 (Redux): rehydration completed on the
        // migrated state. The relaunch helper only guarantees home/textarea —
        // migration settlement must be polled, never read immediately.
        await rpage.waitForFunction(() => (window as any).store?.getState()?._persist?.rehydrated === true, {
          timeout: 60000
        })
        await rpage.waitForFunction(
          () => {
            const s = (window as any).store?.getState()
            if (!s) return false
            return (
              typeof s.mcp === 'undefined' &&
              typeof s.memory === 'undefined' &&
              typeof s.websearch === 'undefined' &&
              typeof s.ocr === 'undefined'
            )
          },
          undefined,
          { timeout: 60000 }
        )
        // Effectiveness criterion 2 (wire): the persist writer has written back
        // the migrated state — outer version 227. Poll, never immediate read.
        await rpage.waitForFunction(
          (key: string) => {
            try {
              const raw = localStorage.getItem(key)
              if (!raw) return false
              const outer = JSON.parse(raw)
              const persistRaw = (outer as Record<string, unknown>)._persist
              const version =
                typeof persistRaw === 'string'
                  ? (JSON.parse(persistRaw) as Record<string, unknown>).version
                  : (((persistRaw as Record<string, unknown> | null)?.version ?? null) as unknown)
              return version === 227
            } catch {
              return false
            }
          },
          'persist:cherry-studio',
          { timeout: 60000 }
        )
        // Dual-state evidence (Redux + wire captured together): Redux stripped
        // AND wire version 227 AND wire stripped jointly prove migration 227
        // executed at runtime. No direct persistor reference is available from
        // the spec; the polled Redux/wire states are the existing surfaces.
        const scrub = await rpage.evaluate(() => {
          const s = (window as any).store.getState()
          const a = s.assistants.assistants[0] ?? {}
          const raw = localStorage.getItem('persist:cherry-studio') ?? ''
          let version: unknown = null
          let wireHasMcp = false
          let wireHasMemory = false
          let wireHasWebsearch = false
          let wireHasOcr = false
          try {
            const outer = JSON.parse(raw)
            const persistRaw = (outer as Record<string, unknown>)._persist
            version =
              typeof persistRaw === 'string'
                ? (JSON.parse(persistRaw) as Record<string, unknown>).version
                : ((persistRaw as Record<string, unknown>)?.version ?? null)
            wireHasMcp = typeof (outer as Record<string, unknown>).mcp !== 'undefined'
            wireHasMemory = typeof (outer as Record<string, unknown>).memory !== 'undefined'
            wireHasWebsearch = typeof (outer as Record<string, unknown>).websearch !== 'undefined'
            wireHasOcr = typeof (outer as Record<string, unknown>).ocr !== 'undefined'
          } catch {
            version = null
          }
          return {
            version,
            wireHasMcp,
            wireHasMemory,
            wireHasWebsearch,
            wireHasOcr,
            rehydrated: (s._persist as { rehydrated?: unknown } | undefined)?.rehydrated ?? null,
            reduxVersion: (s._persist as { version?: unknown } | undefined)?.version ?? null,
            hasMcpSlice: typeof s.mcp !== 'undefined',
            hasMemorySlice: typeof s.memory !== 'undefined',
            hasWebsearchSlice: typeof s.websearch !== 'undefined',
            hasOcrSlice: typeof s.ocr !== 'undefined',
            preprocess: {
              retained: typeof s.preprocess !== 'undefined',
              defaultProvider: s.preprocess?.defaultProvider ?? null,
              providerIds: Array.isArray(s.preprocess?.providers) ? s.preprocess.providers.map((p: any) => p?.id) : []
            },
            assistant: {
              enableWebSearch: (a as Record<string, unknown>).enableWebSearch,
              webSearchProviderId: (a as Record<string, unknown>).webSearchProviderId,
              mcpMode: (a as Record<string, unknown>).mcpMode,
              mcpServers: (a as Record<string, unknown>).mcpServers,
              enableMemory: (a as Record<string, unknown>).enableMemory,
              enableUrlContext: (a as Record<string, unknown>).enableUrlContext
            },
            toolOrder: s.inputTools?.toolOrder ?? null
          }
        })
        expect(scrub.rehydrated).toBe(true)
        expect(scrub.reduxVersion).toBe(227)
        expect(scrub.version).toBe(227)
        expect(scrub.wireHasMcp).toBe(false)
        expect(scrub.wireHasMemory).toBe(false)
        expect(scrub.wireHasWebsearch).toBe(false)
        expect(scrub.wireHasOcr).toBe(false)
        expect(scrub.hasMcpSlice).toBe(false)
        expect(scrub.hasMemorySlice).toBe(false)
        expect(scrub.hasWebsearchSlice).toBe(false)
        expect(scrub.hasOcrSlice).toBe(false)
        expect(scrub.assistant.enableWebSearch).toBeUndefined()
        expect(scrub.assistant.webSearchProviderId).toBeUndefined()
        expect(scrub.assistant.mcpMode).toBeUndefined()
        expect(scrub.assistant.mcpServers).toBeUndefined()
        expect(scrub.assistant.enableMemory).toBeUndefined()
        // Retention: urlContext survives the scrub; preprocess MinerU configs
        // are not damaged by the four-slice strip.
        expect(scrub.assistant.enableUrlContext).toBe(true)
        expect(scrub.preprocess.retained, 'migration 227 must retain preprocess slice').toBe(true)
        expect(scrub.preprocess.defaultProvider).toBe('mineru')
        expect(scrub.preprocess.providerIds).toContain('mineru')
        const visible: unknown[] = Array.isArray((scrub.toolOrder as any)?.visible)
          ? (scrub.toolOrder as any).visible
          : []
        const hidden: unknown[] = Array.isArray((scrub.toolOrder as any)?.hidden) ? (scrub.toolOrder as any).hidden : []
        for (const key of ['web_search', 'mcp_tools']) {
          expect(visible).not.toContain(key)
          expect(hidden).not.toContain(key)
        }
        expect(visible).toContain('url_context')
      })

      await test.step('same relaunched profile sends ordinary chat (UI + mock + ChatDb authority)', async () => {
        const rpage = relaunched!.page
        clearRequestLog()
        const before = getRequestSequence()
        const topicId = await getActiveTopicId(rpage)
        expect(topicId).not.toBe('')
        const prevCount = await assistantCount(rpage, topicId)
        const text = 'E2E removed-caps migration ordinary chat probe'
        await uiSendMessage(rpage, text)
        await waitForAssistantResponseComplete(rpage, topicId, prevCount)
        const req = findProductRequestAfter(before)
        expect(req).not.toBeNull()
        expect(req!.method).toBe('POST')
        expect(req!.url).toBe('/v1/chat/completions')
        expect((req!.parsed as any)?.model).toBe('mock-model')
        const messages = (req!.parsed as any)?.messages as Array<{ role: string; content: string }>
        expect(Array.isArray(messages)).toBe(true)
        expect(messages.filter((m) => m.role === 'user').at(-1)?.content).toBe(text)
        // Redux oracle (independent of the mock log).
        const reduxOk = await rpage.evaluate(
          ({ tid, expected }: { tid: string; expected: string }) => {
            const s = (window as any).store.getState()
            const msgIds = s.messages.messageIdsByTopic[tid] || []
            for (const id of msgIds) {
              const msg = s.messages.entities[id]
              if (msg?.role === 'assistant') {
                const blockId = msg.blocks?.[0]
                const content = s.messageBlocks?.entities?.[blockId]?.content ?? ''
                if (typeof content === 'string' && content.includes(expected)) return true
              }
            }
            return false
          },
          { tid: topicId, expected: text }
        )
        expect(reduxOk).toBe(true)
        // Authority: post-exit SQLite at the runtime path (same disposable DB).
        const runtimeAppDataPath = getRuntimeAppDataPath()
        expect(runtimeAppDataPath).not.toBeNull()
        const dbPath = getChatDbPath()
        expect(dbPath).not.toBeNull()
        expect(fs.existsSync(dbPath!)).toBe(true)
        const relaunchedToClose = relaunched!
        await closeElectronWithExactCleanup(userDataDir, {
          close: () => relaunchedToClose.app.close(),
          findExactProcesses: findProcessesByUserDataDir,
          terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
        })
        relaunched = null
        await new Promise((resolve) => setTimeout(resolve, 3000))
        const esc = (v: string): string => v.replace(/'/g, "''")
        const msgResult = queryChatDbViaElectron(
          dbPath!,
          `SELECT id, topic_id, role FROM messages WHERE topic_id = '${esc(topicId)}' ORDER BY sort_order`
        )
        if (!msgResult.ok) throw new Error(`SQLite messages query failed: ${msgResult.code}`)
        const rows = msgResult.rows as Array<{ topic_id: string; role: string }>
        expect(rows.length).toBeGreaterThanOrEqual(2)
        for (const row of rows) expect(row.topic_id).toBe(topicId)
        expect(rows.some((r) => r.role === 'user')).toBe(true)
        expect(rows.some((r) => r.role === 'assistant')).toBe(true)
      })
    } catch (error) {
      bodyFailure = error
      throw error
    } finally {
      if (relaunched) {
        try {
          await closeElectronWithExactCleanup(getUserDataDir(), {
            close: () => relaunched!.app.close(),
            findExactProcesses: findProcessesByUserDataDir,
            terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
          })
        } catch (err) {
          cleanupErrors.push(`relaunched cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        relaunched = null
      }
      if (cleanupErrors.length > 0) {
        const note = bodyFailure ? ` (body also failed: ${String(bodyFailure)})` : ''
        throw new Error(`E2E cleanup failed: ${cleanupErrors.join('; ')}${note}`)
      }
    }
  })

  // ---------------------------------------------------------------------------
  // 3. Anthropic native urlContext (real toggle + URL send, mock reply only)
  // ---------------------------------------------------------------------------

  test('anthropic native web_fetch retained; no web_search/MCP/memory/OCR injection', async ({
    mainWindow,
    mockPort
  }) => {
    const page = mainWindow
    const PROVIDER_ID = 'mock-anthropic-url'
    const MODEL_ID = 'claude-e2e-url-context'
    const URL_TEXT = 'Summarize https://example.com/e2e-url-context-7788 for E2E urlContext'

    await test.step('seed mock Anthropic connection and claude model (mock endpoint only)', async () => {
      const apiHost = `http://127.0.0.1:${mockPort}/v1/`
      await page.evaluate(
        ({ providerId, modelId, apiHost }) => {
          const store = (window as any).store
          const state = store.getState()
          const models = [
            { id: modelId, provider: providerId, name: modelId, group: 'e2e', description: 'E2E urlContext model' }
          ]
          const existing = state.llm.providers.find((p: any) => p.id === providerId)
          if (existing) {
            store.dispatch({
              type: 'llm/updateProvider',
              payload: { id: providerId, apiKey: 'test-key', apiHost, enabled: true, models }
            })
          } else {
            store.dispatch({
              type: 'llm/addProvider',
              payload: {
                id: providerId,
                type: 'anthropic',
                name: 'Mock Anthropic URL',
                apiKey: 'test-key',
                apiHost,
                models,
                enabled: true,
                isSystem: false
              }
            })
          }
          const assistant = store.getState().assistants.assistants[0]
          if (!assistant) throw new Error('no assistant')
          store.dispatch({
            type: 'assistants/setModel',
            payload: {
              assistantId: assistant.id,
              model: { id: modelId, provider: providerId, name: modelId, group: 'e2e' }
            }
          })
          store.dispatch({
            type: 'assistants/updateAssistant',
            payload: { id: assistant.id, enableUrlContext: false }
          })
        },
        { providerId: PROVIDER_ID, modelId: MODEL_ID, apiHost }
      )
      await page.waitForFunction(
        ({ modelId, providerId }) => {
          const s = (window as any).store?.getState()
          const a = s?.assistants?.assistants?.[0]
          return a?.model?.id === modelId && a?.model?.provider === providerId && a?.enableUrlContext === false
        },
        { modelId: MODEL_ID, providerId: PROVIDER_ID },
        { timeout: 15000 }
      )
    })

    await test.step('real webpage-context toggle enables urlContext', async () => {
      // The DnD ToolWrapper div carries `data-key="url_context"` and a button
      // role; the real UrlContext toggle is the inner ActionIconButton (antd
      // Button) carrying `aria-label` + `aria-pressed`. Scope into the wrapper
      // and locate the actual `button[aria-pressed]` — no new testid, backed
      // by Redux state below, never a translation-only claim.
      const toolWrapper = page.locator('[data-key="url_context"]')
      await expect(toolWrapper).toHaveCount(1, { timeout: 20000 })
      const urlButton = toolWrapper.locator('button[aria-pressed]')
      await expect(urlButton).toHaveCount(1, { timeout: 20000 })
      await expect(urlButton).toHaveAttribute('aria-label', /URL Context|网页上下文|網頁上下文/i, {
        timeout: 20000
      })
      await expect(urlButton).toBeVisible({ timeout: 20000 })
      await expect(urlButton).toHaveAttribute('aria-pressed', 'false')
      await urlButton.click()
      await page.waitForFunction(
        () => (window as any).store.getState().assistants.assistants[0]?.enableUrlContext === true,
        undefined,
        { timeout: 15000 }
      )
      await expect(urlButton).toHaveAttribute('aria-pressed', 'true')
    })

    await test.step('real URL send carries native web_fetch and returns mock reply', async () => {
      clearRequestLog()
      const before = getRequestSequence()
      const topicId = await getActiveTopicId(page)
      expect(topicId).not.toBe('')
      const prevCount = await assistantCount(page, topicId)
      await uiSendMessage(page, URL_TEXT)
      await waitForAssistantResponseComplete(page, topicId, prevCount)
      const req = findAnthropicRequestAfter(before)
      expect(req, 'Anthropic /messages request must reach the mock').not.toBeNull()
      expect(req!.method).toBe('POST')
      expect(req!.url).toBe('/v1/messages')
      const parsed = req!.parsed as any
      expect(parsed?.model).toBe(MODEL_ID)
      // Native tool presence: recursive search for the Anthropic web_fetch
      // channel (webFetch_20260209 serializes as web_fetch on the wire).
      const bodyLower = JSON.stringify(parsed ?? {}).toLowerCase()
      expect(bodyLower).toContain('web_fetch')
      const tools = Array.isArray(parsed?.tools) ? parsed.tools : []
      expect(tools.length, 'Anthropic request must carry provider tools').toBeGreaterThan(0)
      const toolsLower = JSON.stringify(tools).toLowerCase()
      expect(toolsLower).toContain('web_fetch')
      // Absence: no external/provider-native websearch, MCP, memory, or OCR injection.
      expect(toolsLower).not.toContain('web_search')
      expect(toolsLower).not.toContain('websearch')
      expect(toolsLower).not.toContain('mcp')
      expect(toolsLower).not.toContain('memory')
      expect(toolsLower).not.toContain('ocr')
      expect(bodyLower).not.toContain('web_search')
      expect(bodyLower).not.toContain('mcp_tools')
      expect(bodyLower).not.toContain('memory_search')
      // The user URL travels in the Anthropic messages.
      const lastUser = Array.isArray(parsed?.messages)
        ? (parsed.messages as any[]).filter((m) => m?.role === 'user').at(-1)
        : null
      expect(JSON.stringify(lastUser ?? {})).toContain('https://example.com/e2e-url-context-7788')
      // Mock reply only: deterministic echo, no real provider fetch claim.
      const content = await page.evaluate((tid: string) => {
        const s = (window as any).store.getState()
        const msgIds = s.messages.messageIdsByTopic[tid] || []
        let last = ''
        for (const id of msgIds) {
          const msg = s.messages.entities[id]
          if (msg?.role === 'assistant') {
            const blockId = msg.blocks?.[0]
            const c = s.messageBlocks?.entities?.[blockId]?.content || ''
            if (c) last = c
          }
        }
        return last
      }, topicId)
      expect(content).toContain('Mock')
      expect(content).toContain('e2e-url-context-7788')
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Knowledge route + toolbar smoke (no new vector infrastructure)
  // ---------------------------------------------------------------------------

  test('knowledge route and toolbar entry retained (smoke only)', async ({ mainWindow }) => {
    const page = mainWindow

    await test.step('real sidebar click opens knowledge route', async () => {
      await page.getByTestId('sidebar-nav-knowledge').click()
      await expect(page).toHaveURL(/.*#\/knowledge.*/, { timeout: 10000 })
      await expect(page.getByTestId('knowledge-page')).toBeVisible({ timeout: 15000 })
      await expect(page.getByTestId('route-error-fallback')).toHaveCount(0)
    })

    await test.step('knowledge Redux slice retained', async () => {
      const hasKnowledge = await page.evaluate(() => typeof (window as any).store.getState().knowledge !== 'undefined')
      expect(hasKnowledge).toBe(true)
    })
  })
})
