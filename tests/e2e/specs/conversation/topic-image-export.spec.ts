/**
 * Topic image export — complete-topic / complete-route regression asset.
 *
 * Reported regression guarded here: Topic menu → Export → Export as image used
 * to capture only the resident viewport slice. The contract now is: image
 * export reads Main's one-shot whole-topic snapshot for the route the user is
 * currently viewing, renders it caller-locally in a detached offscreen tree,
 * captures that tree, and leaves the loaded window projection, the viewport
 * window and the live scroll container untouched.
 *
 * Frozen operation sequences:
 *   1. seed N (>> the loaded window) → activate → right-click topic → Export →
 *      Export as image → PNG written through the production saveImage path.
 *   2. seed N → create a branch at an interior anchor → seed branch-owned
 *      messages → activate the branch route → same menu export.
 *
 * Assertions bound the coverage:
 * - the written PNG is far taller than the viewport (not a viewport slice),
 * - the export render held every seeded marker (first..last), i.e. messages the
 *   loaded projection never had,
 * - for a branch route the export holds exactly the inherited prefix plus the
 *   branch-owned messages, and none of the main route's own suffix,
 * - the loaded window, rendered row count and scroll position are identical
 *   before/after, and the transient export host/styles are gone afterwards.
 *
 * Instrumentation is spec-local and diagnostic only: Main's save dialog is
 * redirected into the fixture-owned temp root (no personal path, no native
 * dialog) and the capture canvas is sampled through a page-level
 * `toDataURL` probe to observe the export render before it is torn down.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect, test } from '../../fixtures/electron.fixture'
import { activateTopic } from '../../utils/branch-route-setup'
import { waitForAppReady } from '../../utils/wait-helpers'

const TOTAL_MESSAGES = 40

/** Interior anchor of the branch scenario (index into the main route seed). */
const BRANCH_ANCHOR_INDEX = 14
/** Branch-owned messages appended after the inherited prefix. */
const BRANCH_OWN_COUNT = 20
/** Inherited prefix of the branch route: main route through the anchor. */
const BRANCH_PREFIX_COUNT = BRANCH_ANCHOR_INDEX + 1
/** Complete branch route = inherited prefix + branch-owned messages. */
const BRANCH_ROUTE_TOTAL = BRANCH_PREFIX_COUNT + BRANCH_OWN_COUNT

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

const marker = (prefix: string, index: number): string => `${prefix}-${pad(index, 3)}`

const parsePngSize = (buffer: Buffer): { width: number; height: number } | null => {
  if (buffer.length < 24) return null
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

const projectionState = (page: any, topicId: string) =>
  page.evaluate((topicId: string) => {
    const container = document.querySelector('#messages') as HTMLElement | null
    const state = (window as any).store.getState()
    const ids: string[] = state.messages?.messageIdsByTopic?.[topicId] ?? []
    return {
      loadedIds: [...ids],
      activeRoute: state.topicBranch?.activeBranchIdByTopic?.[topicId] ?? null,
      domCount: document.querySelectorAll('#messages [data-message-id]').length,
      scrollTop: container ? Math.round(container.scrollTop) : null,
      clientHeight: container ? container.clientHeight : null,
      leftoverHosts: document.querySelectorAll('[data-topic-export-host]').length,
      liveHideScrollbar: container ? container.classList.contains('hide-scrollbar') : null
    }
  }, topicId)

interface SeedEntry {
  message: Record<string, unknown>
  blocks: Array<Record<string, unknown>>
}

const buildEntries = (
  topicId: string,
  assistantId: string,
  count: number,
  markerPrefix: string,
  idPrefix: string
): SeedEntry[] => {
  const entries: SeedEntry[] = []
  for (let index = 0; index < count; index++) {
    const messageId = `${topicId}-${idPrefix}-msg-${pad(index, 5)}`
    const blockId = `${topicId}-${idPrefix}-block-${pad(index, 5)}`
    entries.push({
      message: {
        id: messageId,
        topicId,
        role: index % 2 === 0 ? 'user' : 'assistant',
        assistantId,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'success',
        blocks: [blockId],
        sortOrder: index
      },
      blocks: [
        {
          id: blockId,
          messageId,
          type: 'main_text',
          content: `${marker(markerPrefix, index)} ${'content '.repeat(20)}`,
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    })
  }
  return entries
}

const seedMarkedTopic = async (
  page: any,
  assistantId: string,
  topicId: string,
  name: string,
  count: number,
  markerPrefix: string,
  entriesFactory: (
    topicId: string,
    assistantId: string,
    count: number,
    markerPrefix: string,
    idPrefix: string
  ) => SeedEntry[] = buildEntries
): Promise<string[]> => {
  const added = await page.evaluate(
    ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
      try {
        ;(window as any).store.dispatch({
          type: 'assistants/addTopic',
          payload: {
            assistantId,
            topic: {
              id: topicId,
              assistantId,
              name,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            }
          }
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, err: String(error) }
      }
    },
    { topicId, assistantId, name }
  )
  expect(added.ok, `addTopic failed: ${(added as any).err}`).toBe(true)

  const entries = entriesFactory(topicId, assistantId, count, markerPrefix, 'main')

  const persisted = await page.evaluate(
    async ({
      topicId,
      assistantId,
      name,
      entries
    }: {
      topicId: string
      assistantId: string
      name: string
      entries: SeedEntry[]
    }) => {
      try {
        const chatDb = (window as any).api?.chatDb
        const ensured = await chatDb.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
        const pasted = await chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (error) {
        return { ok: false, err: String(error) }
      }
    },
    { topicId, assistantId, name, entries }
  )
  expect(persisted.ok, `seed failed: ${(persisted as any).err}`).toBe(true)
  return entries.map((entry) => entry.message.id as string)
}

/** Seeds messages owned by an existing branch route (never the main route). */
const seedOwnedBranchMessages = async (
  page: any,
  assistantId: string,
  topicId: string,
  branchId: string,
  count: number,
  markerPrefix: string
): Promise<string[]> => {
  const entries = buildEntries(topicId, assistantId, count, markerPrefix, 'branch')
  const pasted = await page.evaluate(
    async ({ topicId, branchId, entries }: { topicId: string; branchId: string; entries: SeedEntry[] }) => {
      try {
        const res = await (window as any).api?.chatDb?.pasteMessagesToTopic({ topicId, entries, branchId })
        return res?.ok === true ? { ok: true } : { ok: false, err: JSON.stringify(res) }
      } catch (error) {
        return { ok: false, err: String(error) }
      }
    },
    { topicId, branchId, entries }
  )
  expect(pasted.ok, `branch seed failed: ${(pasted as any).err}`).toBe(true)
  return entries.map((entry) => entry.message.id as string)
}

/** Creates a true branch off the main route at `anchorMessageId`. */
const createBranchAtAnchor = async (page: any, topicId: string, anchorMessageId: string): Promise<string> => {
  const created = await page.evaluate(
    async ({ topicId, anchorMessageId }: { topicId: string; anchorMessageId: string }) => {
      try {
        const res = await (window as any).api?.chatDb?.createBranch({ topicId, anchorMessageId, name: 'Branch Route' })
        return res?.ok === true ? { ok: true, branchId: res.value.branch.id } : { ok: false, err: JSON.stringify(res) }
      } catch (error) {
        return { ok: false, err: String(error) }
      }
    },
    { topicId, anchorMessageId }
  )
  expect(created.ok, `createBranch failed: ${(created as any).err}`).toBe(true)
  return created.branchId as string
}

/** Switches the viewed route of a topic (production route intent action). */
const setActiveRoute = async (page: any, topicId: string, branchId: string | null): Promise<void> => {
  await page.evaluate(
    ({ tid, bid }: { tid: string; bid: string | null }) => {
      ;(window as any).store.dispatch({ type: 'topicBranch/activeBranchSet', payload: { topicId: tid, branchId: bid } })
    },
    { tid: topicId, bid: branchId }
  )
  await page.waitForFunction(
    ({ tid, bid }: { tid: string; bid: string | null }) => {
      const state = (window as any).store.getState()
      const route = state.topicBranch?.activeBranchIdByTopic?.[tid] ?? null
      const ids = state.messages?.messageIdsByTopic?.[tid]
      return route === bid && Array.isArray(ids) && ids.length > 0 && state.messages?.loadingByTopic?.[tid] !== true
    },
    { tid: topicId, bid: branchId },
    { timeout: 30000 }
  )
}

/** Production save path, redirected into the fixture-owned temp root. */
const redirectSaveDialog = async (electronApp: any, ownedTmpRoot: string, fileName = 'topic.png'): Promise<string> => {
  const pngPath = path.join(ownedTmpRoot, 'topic-image-export', fileName)
  fs.mkdirSync(path.dirname(pngPath), { recursive: true })
  await electronApp.evaluate(({ dialog }: any, target: string) => {
    dialog.showSaveDialogSync = () => target
  }, pngPath)
  return pngPath
}

/**
 * Observes the export render at capture time: the host is removed right after
 * the capture, so the probe records the markers from the real capture canvas.
 */
const installCaptureProbe = async (page: any, markerPattern: string): Promise<void> => {
  await page.evaluate((pattern: string) => {
    ;(window as any).__exportProbe = null
    const original = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = function probedToDataURL(
      this: HTMLCanvasElement,
      ...args: [type?: string, quality?: number]
    ) {
      try {
        const host = document.querySelector('[data-topic-export-host]')
        if (host && this.width > 200 && this.height > 200) {
          const text = host.textContent ?? ''
          const markers = text.match(new RegExp(pattern, 'g')) ?? []
          // The export root owns its own antd scope, so its resolved tokens are
          // sampled here (before teardown) and compared with the live page.
          const header = host.querySelector('.message-thought-container .ant-collapse-header') as HTMLElement | null
          const headerText = header?.querySelector('.ant-collapse-header-text') as HTMLElement | null
          const content = host.querySelector('[data-topic-export-content]') as HTMLElement | null
          ;(window as any).__exportProbe = {
            canvasWidth: this.width,
            canvasHeight: this.height,
            markers,
            hostDomRowCount: host.querySelectorAll('[data-message-id]').length,
            exportHeaderColor: header ? getComputedStyle(header).color : null,
            exportHeaderTextColor: headerText ? getComputedStyle(headerText).color : null,
            exportBodyColor: content ? getComputedStyle(content).color : null,
            // Thinking-body expansion inside the export render: the export-only
            // override decides it, never the live chat toggle.
            exportThinkingBody: (() => {
              const item = host.querySelector('.message-thought-container .ant-collapse-item') as HTMLElement | null
              if (!item) return null
              const content = item.querySelector('.ant-collapse-content') as HTMLElement | null
              return {
                active: item.classList.contains('ant-collapse-item-active'),
                contentHeight: content ? Math.round(content.getBoundingClientRect().height) : 0,
                contentDisplay: content ? getComputedStyle(content).display : null,
                hostReasoningVisible: (host.textContent ?? '').includes('reasoning ')
              }
            })()
          }
        }
      } catch {
        // probe failure must never break the production capture
      }
      return original.apply(this, args)
    }
  }, markerPattern)
}

/** Visible menu layers (parent dropdowns and submenu popups) currently mounted. */
const visibleMenuLayerCount = (page: any) =>
  page.evaluate(
    () =>
      Array.from(document.querySelectorAll('.ant-dropdown, .ant-dropdown-menu-submenu-popup')).filter((node) => {
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden'
      }).length
  )

/**
 * Best-effort dismissal of the menu a topic action opened, through the
 * interactions a user performs: Escape first, then an outside click. The topic
 * list unmounts when the settings route replaces the sidebar, and a menu still
 * mounted at that moment can survive as an orphaned portal that no later Escape
 * or outside click can dismiss, so dismissal never gates the export.
 */
const closeTopicActionMenu = async (page: any): Promise<void> => {
  for (let attempt = 0; attempt < 2 && (await visibleMenuLayerCount(page)) > 0; attempt++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    if ((await visibleMenuLayerCount(page)) === 0) break
    // Outside click on neutral conversation space, as a user dismisses a menu.
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    await page.mouse.click(Math.round(viewport.width / 2), Math.round(viewport.height / 2))
    await page.waitForTimeout(200)
  }
}

/** The visible dropdown anchored to a trigger, never a leftover portal elsewhere. */
const dropdownAnchoredTo = async (page: any, trigger: any): Promise<any> => {
  const triggerBox = await trigger.boundingBox()
  const dropdowns = page.locator('.ant-dropdown:visible')
  const count = await dropdowns.count()
  if (!triggerBox || count === 0) return dropdowns.last()
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < count; index++) {
    const box = await dropdowns.nth(index).boundingBox()
    if (!box) continue
    const distance = Math.abs(box.x - triggerBox.x) + Math.abs(box.y - triggerBox.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  return dropdowns.nth(best)
}

/** Real user action: topic menu → Export → Export as image. */
const exportTopicImageViaMenu = async (page: any, topicItem: any): Promise<void> => {
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.click({ button: 'right' })
  const exportParent = page
    .locator('.ant-dropdown-menu-submenu')
    .filter({ hasText: /^(导出|Export)$/ })
    .first()
  await exportParent.waitFor({ state: 'visible', timeout: 15000 })
  const imageItem = page
    .locator('.ant-dropdown-menu-submenu-popup .ant-dropdown-menu-item:visible')
    .filter({ hasText: /^(导出为图片|Export as image)$/ })
    .first()
  // rc-menu opens the submenu on hover after a short delay; a theme switch keeps
  // the popup motion running, so hover again until the popup actually shows.
  for (let attempt = 0; attempt < 3; attempt++) {
    await exportParent.hover()
    const shown = await imageItem
      .waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false)
    if (shown) break
  }
  await imageItem.waitFor({ state: 'visible', timeout: 15000 })
  // The submenu enters with an antd motion; the pointer must already rest on
  // the item (a theme switch keeps that motion running longer) before clicking,
  // otherwise rc-menu closes the popup mid-click.
  const box = await imageItem.boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(300)
  await imageItem.click()
  await closeTopicActionMenu(page)
}

/** Index of the seeded assistant message that carries a real thinking block. */
const THINKING_INDEX = 1
const THINKING_SEED_TOTAL = 4

/**
 * Seeds a route where one assistant message carries a real thinking block, so
 * the export render includes the antd `Collapse` header the regression was
 * reported on.
 */
const buildThinkingEntries = (
  topicId: string,
  assistantId: string,
  count: number,
  markerPrefix: string,
  idPrefix: string
): SeedEntry[] =>
  buildEntries(topicId, assistantId, count, markerPrefix, idPrefix).map((entry, index) => {
    if (index !== THINKING_INDEX) return entry
    const thinkingBlockId = `${entry.blocks[0].id}-thinking`
    return {
      message: { ...entry.message, blocks: [thinkingBlockId, ...(entry.message.blocks as string[])] },
      blocks: [
        {
          id: thinkingBlockId,
          messageId: entry.message.id,
          type: 'thinking',
          content: `${marker(markerPrefix, index)} reasoning ${'detail '.repeat(30)}`,
          status: 'success',
          thinking_millsec: 1200,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        ...entry.blocks
      ]
    }
  })

/** Dispatches the production theme intent (settings → `api.setTheme` → main). */
const dispatchThemeIntent = async (page: any, mode: 'dark' | 'light'): Promise<void> => {
  await page.evaluate((mode: string) => {
    ;(window as any).store.dispatch({ type: 'settings/setTheme', payload: mode })
  }, mode)
}

const appliedTheme = (page: any) => page.evaluate(() => document.body.getAttribute('theme-mode'))

/**
 * Switches the effective theme of the running app and waits until the page
 * really renders it.
 *
 * A theme switch is only delivered to the renderer (`ThemeUpdated` → actual
 * theme → body[theme-mode] + user-theme CSS variables + antd algorithm) when
 * the resolved native mode changes, and this environment may already resolve
 * to the requested mode. The production intent is dispatched first; only when
 * that produced no transition is the main-process native mode nudged through
 * the opposite value and back, so the renderer receives the real event instead
 * of the test writing theme state by hand.
 */
const setThemeMode = async (page: any, mode: 'dark' | 'light', electronApp: any): Promise<void> => {
  await dispatchThemeIntent(page, mode)
  if ((await appliedTheme(page)) === mode) return

  await electronApp.evaluate(
    ({ nativeTheme }: any, opposite: string) => {
      nativeTheme.themeSource = opposite
    },
    mode === 'dark' ? 'light' : 'dark'
  )
  await page.waitForFunction(
    (opposite: string) => document.body.getAttribute('theme-mode') === opposite,
    mode === 'dark' ? 'light' : 'dark',
    { timeout: 20000 }
  )
  await electronApp.evaluate(({ nativeTheme }: any, mode: string) => {
    nativeTheme.themeSource = mode
  }, mode)
  await page.waitForFunction((mode: string) => document.body.getAttribute('theme-mode') === mode, mode, {
    timeout: 20000
  })
}

/** Relative luminance of a computed `rgb()/rgba()` color, for "not black" checks. */
const colorLuminance = (color: string | null): number => {
  if (!color) return Number.NaN
  const match = color.match(/rgba?\(([^)]+)\)/)
  if (!match) return Number.NaN
  const [r, g, b] = match[1].split(',').map((value) => Number.parseFloat(value))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Samples the live thinking-block header colors of the rendered topic. */
const liveThinkingHeader = (page: any) =>
  page.evaluate(() => {
    const header = document.querySelector(
      '#messages .message-thought-container .ant-collapse-header'
    ) as HTMLElement | null
    const text = header?.querySelector('.ant-collapse-header-text') as HTMLElement | null
    return {
      appliedTheme: document.body.getAttribute('theme-mode'),
      headerColor: header ? getComputedStyle(header).color : null,
      textColor: text ? getComputedStyle(text).color : null
    }
  })

/**
 * Reads the live header colors once antd's change transition has settled.
 *
 * antd animates `color` (motionDurationMid), so sampling right after the theme
 * switch would read an interpolated mid-transition value instead of the token.
 */
const waitForSettledLiveHeader = async (page: any) => {
  let previous: { headerColor: string | null; textColor: string | null } | null = null
  let stable = 0
  for (let attempt = 0; attempt < 40; attempt++) {
    const sample = await liveThinkingHeader(page)
    if (previous && sample.headerColor === previous.headerColor && sample.textColor === previous.textColor) {
      stable += 1
      if (stable >= 2) return sample
    } else {
      stable = 0
    }
    previous = sample
    await page.waitForTimeout(150)
  }
  return liveThinkingHeader(page)
}

/* ------------------------------------------------------------------ *
 * Export options surface (settings page, default directory, thinking) *
 * ------------------------------------------------------------------ */

/** The app's own strings for the export surface, resolved in the running locale. */
const exportLabels = async (page: any) => {
  const language: string = await page.evaluate(() => (window as any).store.getState().settings.language ?? 'en-US')
  const zh = /^zh/i.test(language)
  return {
    zh,
    dataSettingsTitle: zh ? '数据设置' : 'Data Settings',
    exportOptionsTitle: zh ? '话题导出选项' : 'Topic Export Options',
    pathTitle: zh ? '默认导出路径' : 'Default Export Path',
    pathPlaceholder: zh ? '导出路径' : 'Export Path',
    select: zh ? '选择' : 'Select',
    includeThinking: zh ? '包含思考内容' : 'Include thinking content',
    excludeCitations: zh ? '不导出引用内容' : 'Exclude Citations',
    standardizeCitations: zh ? '标准化引用格式' : 'Standardize Citation Format',
    removedSwitches: zh
      ? ['显示模型名称', '显示模型提供商', '强制使用', '使用话题命名']
      : ['Show Model Name', 'Show Model Provider', 'Use topic naming'],
    removedPages: ['markdown_export', 'export_menu', 'settings.data.export_menu'],
    exportMenuTitle: zh ? '导出' : 'Export',
    exportImage: zh ? '导出为图片' : 'Export as image',
    exportMarkdown: zh ? '导出为 Markdown' : 'Export as markdown',
    exportJson: zh ? '导出为 JSON' : 'Export as JSON'
  }
}

/** Real user navigation: sidebar → Settings → Data Settings → Export Options. */
const openExportOptionsPage = async (page: any): Promise<void> => {
  const labels = await exportLabels(page)
  await page.locator('[data-testid="sidebar-nav-settings"]').click()
  const panel = page.locator('[data-testid="settings-page"]')
  await panel.waitFor({ state: 'visible', timeout: 30000 })
  await panel.getByText(labels.dataSettingsTitle, { exact: true }).first().click()
  await panel.getByText(labels.exportOptionsTitle, { exact: true }).first().click()
  await panel.getByText(labels.pathTitle, { exact: true }).first().waitFor({ state: 'visible', timeout: 20000 })
}

/** Real user navigation back to the conversation after a settings visit. */
const backToChat = async (page: any): Promise<void> => {
  await page.locator('[data-testid="sidebar-nav-assistants"]').click()
  await page.waitForFunction(() => location.hash.replace('#', '') === '/' || location.pathname === '/', undefined, {
    timeout: 20000
  })
}

/**
 * Stubs every native export dialog. The folder picker answers with `target`
 * (the fixture-owned directory); image/text save dialogs are counted and
 * cancelled, so any export that still needs a dialog is observable.
 */
const stubExportDialogs = async (electronApp: any, target: string): Promise<void> => {
  fs.mkdirSync(target, { recursive: true })
  await electronApp.evaluate(({ dialog }: any, dir: string) => {
    const calls = { open: 0, save: 0 }
    ;(globalThis as any).__exportDialogCalls = calls
    dialog.showOpenDialog = async () => {
      calls.open += 1
      return { canceled: false, filePaths: [dir] }
    }
    const cancelled = () => {
      calls.save += 1
      return { canceled: true, filePath: undefined, filePaths: [] }
    }
    dialog.showSaveDialog = async () => cancelled()
    dialog.showSaveDialogSync = () => {
      calls.save += 1
      return ''
    }
  }, target)
}

const exportDialogCalls = (electronApp: any) =>
  electronApp.evaluate(() => (globalThis as any).__exportDialogCalls ?? { open: 0, save: 0 })

/** Picks the preconfigured export directory through the production folder picker. */
const selectExportPathViaUi = async (page: any, expectedDir: string): Promise<void> => {
  const labels = await exportLabels(page)
  const panel = page.locator('[data-testid="settings-page"]')
  await panel.getByRole('button', { name: labels.select }).first().click()
  await expect
    .poll(() => page.evaluate(() => (window as any).store.getState().settings.exportPath), { timeout: 20000 })
    .toBe(expectedDir)
  await expect(panel.locator(`input[placeholder="${labels.pathPlaceholder}"]`).first()).toHaveValue(expectedDir)
}

/** Directory listing of the preconfigured export destination, oldest first. */
const listExportDir = (dir: string): Array<{ name: string; size: number; mtime: number }> => {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name))
      return { name, size: stat.size, mtime: stat.mtimeMs }
    })
    .sort((a, b) => a.mtime - b.mtime)
}

/** Snapshot of the directory keyed by name+size+mtime: exports overwrite a same-named file. */
const exportDirNames = (dir: string): Set<string> =>
  new Set(listExportDir(dir).map((entry) => `${entry.name}|${entry.size}|${entry.mtime}`))

/** Waits for one newly written file with the given extension and returns its path. */
const waitForNewExportFile = async (dir: string, extension: string, previous: Set<string>): Promise<string> => {
  const found: { name: string } = { name: '' }
  await expect
    .poll(
      () => {
        const match = listExportDir(dir).filter(
          (entry) =>
            entry.name.toLowerCase().endsWith(extension) && !previous.has(`${entry.name}|${entry.size}|${entry.mtime}`)
        )
        found.name = match.length > 0 ? match[match.length - 1].name : ''
        return found.name
      },
      { timeout: 90000 }
    )
    .not.toBe('')
  return path.join(dir, found.name)
}

/** Real user action: topic menu → Export, returning the offered item labels. */
const openTopicExportSubmenu = async (page: any, topicItem: any, title: string): Promise<string[]> => {
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.click({ button: 'right' })
  const parent = page.locator('.ant-dropdown-menu-submenu').filter({ hasText: title }).first()
  await parent.waitFor({ state: 'visible', timeout: 15000 })
  await parent.hover()
  await page
    .locator('.ant-dropdown-menu-submenu-popup .ant-dropdown-menu-item:visible')
    .first()
    .waitFor({ timeout: 15000 })
  return (await page.locator('.ant-dropdown-menu-submenu-popup .ant-dropdown-menu-item:visible').allInnerTexts()).map(
    (text: string) => text.trim()
  )
}

const clickMenuItem = async (page: any, label: string): Promise<void> => {
  await page
    .locator('.ant-dropdown-menu-submenu-popup .ant-dropdown-menu-item:visible')
    .filter({ hasText: label })
    .first()
    .click()
  await closeTopicActionMenu(page)
}

/** Real user action: bring a message row into the conversation viewport. */
const revealMessageRow = async (page: any, messageId: string): Promise<void> => {
  const row = page.locator(`#messages [data-message-id="${messageId}"]`).first()
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await page.waitForTimeout(300)
}

/** Real user action: message menubar → Export → Export as image. */
const exportMessageImageViaMenu = async (
  page: any,
  messageId: string,
  title: string,
  imageLabel: string
): Promise<void> => {
  const row = page.locator(`#messages [data-message-id="${messageId}"]`).first()
  // The menu this click owns is resolved from the message's own trigger: a topic
  // menu can still be mounted behind the sidebar, so the visible dropdown nearest
  // the clicked button is selected instead of the last one in the document.
  await row.hover()
  const moreBtn = row.locator('[data-testid="message-more-menu-btn"]')
  await moreBtn.waitFor({ state: 'visible', timeout: 15000 })
  await moreBtn.click()
  const parent = (await dropdownAnchoredTo(page, moreBtn))
    .locator('.ant-dropdown-menu-submenu')
    .filter({ hasText: title })
    .first()
  await parent.waitFor({ state: 'visible', timeout: 15000 })
  await parent.hover()
  // Resolve the popup this submenu title owns. An orphaned topic menu can still be
  // mounted behind the sidebar, so picking the last popup globally selects it.
  const submenuId = await parent.getAttribute('aria-controls')
  const popups = page.locator('.ant-dropdown-menu-submenu-popup:visible')
  let submenu = submenuId ? page.locator(`[id="${submenuId}"]`) : popups.last()
  if ((await submenu.count()) === 0) {
    const parentBox = await parent.boundingBox()
    let chosen = popups.last()
    if (parentBox) {
      let best = Number.POSITIVE_INFINITY
      for (let index = 0; index < (await popups.count()); index++) {
        const box = await popups.nth(index).boundingBox()
        if (!box) continue
        const gap = Math.max(box.x - (parentBox.x + parentBox.width), 0) + Math.abs(box.y - parentBox.y)
        if (gap < best) {
          best = gap
          chosen = popups.nth(index)
        }
      }
    }
    submenu = chosen
  }
  const imageItem = submenu.locator('.ant-dropdown-menu-item:visible').filter({ hasText: imageLabel }).first()
  await imageItem.waitFor({ timeout: 15000 })
  // The submenu popup only hosts the pointer once its motion has settled; a
  // pointer resting on the item keeps it open, so re-enter it until the item is
  // really the element under the pointer before clicking.
  for (let attempt = 0; attempt < 3; attempt++) {
    await parent.hover()
    const itemBox = await imageItem.boundingBox()
    const ownsPointer = itemBox
      ? await page.evaluate(
          ({ x, y }: { x: number; y: number }) =>
            Boolean((document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-menu-id]')),
          { x: itemBox.x + itemBox.width / 2, y: itemBox.y + itemBox.height / 2 }
        )
      : false
    if (ownsPointer) break
    await page.waitForTimeout(300)
  }
  await imageItem.click()
}

/** Live thinking-body visibility of the rendered conversation (never the export tree). */
const liveThinkingBody = (page: any) =>
  page.evaluate(() => {
    const body = document.querySelector(
      '#messages .message-thought-container .ant-collapse-content'
    ) as HTMLElement | null
    if (!body) return null
    const rect = body.getBoundingClientRect()
    return {
      height: Math.round(rect.height),
      display: getComputedStyle(body).display,
      hiddenClass: body.classList.contains('ant-collapse-content-hidden')
    }
  })
test.describe('topic image export', () => {
  test('exports the complete topic from a detached render and leaves the loaded window untouched', async ({
    mainWindow,
    electronApp,
    ownedTmpRoot
  }) => {
    const page = mainWindow
    test.setTimeout(180000)
    await waitForAppReady(page)
    await page.waitForFunction(() => Boolean((window as any).store), undefined, { timeout: 60000 })

    const topicId = `e2e-image-export-${Date.now()}`
    const topicName = `Image Export ${topicId}`

    const assistantId = await page.evaluate(
      () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
    )
    expect(assistantId, 'a live assistant is required for seeding').toBeTruthy()
    await seedMarkedTopic(page, assistantId as string, topicId, topicName, TOTAL_MESSAGES, 'EXPORTMARK')

    // Activate the topic and wait for the bounded window projection.
    const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
    await topicItem.waitFor({ state: 'attached', timeout: 20000 })
    await topicItem.scrollIntoViewIfNeeded()
    await topicItem.click()
    await page.waitForFunction(
      (topicId: string) => {
        const state = (window as any).store.getState()
        const ids = state.messages?.messageIdsByTopic?.[topicId]
        return Array.isArray(ids) && ids.length > 0 && state.messages?.loadingByTopic?.[topicId] !== true
      },
      topicId,
      { timeout: 30000 }
    )
    await page.waitForFunction(() => document.querySelectorAll('#messages [data-message-id]').length > 0, undefined, {
      timeout: 30000
    })

    const before = await projectionState(page, topicId)
    expect(
      before.loadedIds.length,
      `the loaded window must stay bounded below the seeded total (was ${before.loadedIds.length})`
    ).toBeLessThan(TOTAL_MESSAGES)

    const pngPath = await redirectSaveDialog(electronApp, ownedTmpRoot)
    await installCaptureProbe(page, 'EXPORTMARK-\\d{3}')

    await exportTopicImageViaMenu(page, topicItem)

    await expect
      .poll(() => (fs.existsSync(pngPath) ? fs.statSync(pngPath).size : 0), { timeout: 90000 })
      .toBeGreaterThan(0)

    const pngSize = parsePngSize(fs.readFileSync(pngPath))
    expect(pngSize, 'exported file must be a PNG').not.toBeNull()
    const viewportHeight = before.clientHeight ?? 0
    expect(pngSize!.width).toBeGreaterThan(200)
    expect(pngSize!.height, 'exported image must be far taller than the viewport').toBeGreaterThan(viewportHeight * 3)

    const probe = await page.evaluate(() => (window as any).__exportProbe ?? null)
    expect(probe, 'the export render must have been captured').not.toBeNull()
    expect(probe.markers.length, 'every seeded message must reach the export render').toBe(TOTAL_MESSAGES)
    expect(probe.markers[0]).toBe('EXPORTMARK-000')
    expect(probe.markers[probe.markers.length - 1]).toBe(`EXPORTMARK-${pad(TOTAL_MESSAGES - 1, 3)}`)
    expect(probe.canvasHeight).toBe(pngSize!.height)
    // The export render must not publish live `message-<id>` anchors.
    expect(probe.hostDomRowCount, 'export render must not duplicate live message anchors').toBe(0)

    const after = await projectionState(page, topicId)
    expect(after.loadedIds, 'the loaded window projection must not change').toEqual(before.loadedIds)
    expect(after.domCount, 'rendered rows must not change').toBe(before.domCount)
    expect(after.scrollTop, 'the viewport must not move').toBe(before.scrollTop)
    expect(after.leftoverHosts, 'the transient export host must be removed').toBe(0)
    expect(after.liveHideScrollbar, 'no capture style may leak onto the live container').toBe(false)

    console.log(
      `[E2E] topic image export png=${pngSize!.width}x${pngSize!.height} markers=${probe.markers.length} loaded=${before.loadedIds.length}/${TOTAL_MESSAGES} scrollTop=${before.scrollTop}`
    )
  })

  test('exports the viewed branch route (inherited prefix + branch messages) without the main route suffix', async ({
    mainWindow,
    electronApp,
    ownedTmpRoot
  }) => {
    const page = mainWindow
    test.setTimeout(240000)
    await waitForAppReady(page)
    await page.waitForFunction(() => Boolean((window as any).store), undefined, { timeout: 60000 })

    const topicId = `e2e-branch-image-export-${Date.now()}`
    const topicName = `Branch Export ${topicId}`

    const assistantId = await page.evaluate(
      () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
    )
    expect(assistantId, 'a live assistant is required for seeding').toBeTruthy()

    // Main route seed: MAINMARK-000..039.
    const mainIds = await seedMarkedTopic(page, assistantId as string, topicId, topicName, TOTAL_MESSAGES, 'MAINMARK')

    // True branch at an interior main-route anchor, then branch-owned messages.
    const branchId = await createBranchAtAnchor(page, topicId, mainIds[BRANCH_ANCHOR_INDEX])
    await seedOwnedBranchMessages(page, assistantId as string, topicId, branchId, BRANCH_OWN_COUNT, 'BRANCHMARK')

    // Activate the topic, then view the branch route.
    await activateTopic(page, topicId, 1)
    await setActiveRoute(page, topicId, branchId)

    const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
    await topicItem.waitFor({ state: 'attached', timeout: 20000 })

    const before = await projectionState(page, topicId)
    expect(before.activeRoute, 'the viewed route must be the branch').toBe(branchId)
    expect(
      before.loadedIds.length,
      `the loaded window must stay bounded below the complete branch route (was ${before.loadedIds.length}/${BRANCH_ROUTE_TOTAL})`
    ).toBeLessThan(BRANCH_ROUTE_TOTAL)
    // The projection really is the branch route: no main-only suffix row loaded.
    const mainOnlyIds = new Set(mainIds.slice(BRANCH_PREFIX_COUNT))
    expect(
      before.loadedIds.filter((id: string) => mainOnlyIds.has(id)),
      'the loaded window must not hold main-route-only rows while viewing the branch'
    ).toEqual([])

    const pngPath = await redirectSaveDialog(electronApp, ownedTmpRoot)
    await installCaptureProbe(page, '(?:MAINMARK|BRANCHMARK)-\\d{3}')

    await exportTopicImageViaMenu(page, topicItem)

    await expect
      .poll(() => (fs.existsSync(pngPath) ? fs.statSync(pngPath).size : 0), { timeout: 120000 })
      .toBeGreaterThan(0)

    const pngSize = parsePngSize(fs.readFileSync(pngPath))
    expect(pngSize, 'exported file must be a PNG').not.toBeNull()
    const viewportHeight = before.clientHeight ?? 0
    expect(pngSize!.width).toBeGreaterThan(200)
    expect(pngSize!.height, 'exported image must be far taller than the viewport').toBeGreaterThan(viewportHeight * 3)

    const probe = await page.evaluate(() => (window as any).__exportProbe ?? null)
    expect(probe, 'the export render must have been captured').not.toBeNull()
    const exportedMarkers: string[] = probe.markers

    // Complete viewed route: inherited prefix followed by the branch's own messages.
    expect(
      exportedMarkers.length,
      `the export must hold the complete branch route (${BRANCH_PREFIX_COUNT} inherited + ${BRANCH_OWN_COUNT} branch)`
    ).toBe(BRANCH_ROUTE_TOTAL)
    expect(exportedMarkers).toHaveLength(BRANCH_ROUTE_TOTAL)
    expect(BRANCH_ROUTE_TOTAL, 'the branch route must exceed any resident window').toBeGreaterThan(10)

    for (let index = 0; index < BRANCH_PREFIX_COUNT; index++) {
      expect(exportedMarkers, `inherited prefix ${marker('MAINMARK', index)} must be exported`).toContain(
        marker('MAINMARK', index)
      )
    }
    for (let index = 0; index < BRANCH_OWN_COUNT; index++) {
      expect(exportedMarkers, `branch message ${marker('BRANCHMARK', index)} must be exported`).toContain(
        marker('BRANCHMARK', index)
      )
    }
    // Main-route-only suffix (rows the branch route does not contain).
    for (let index = BRANCH_PREFIX_COUNT; index < TOTAL_MESSAGES; index++) {
      expect(exportedMarkers, `main-route-only ${marker('MAINMARK', index)} must not be exported`).not.toContain(
        marker('MAINMARK', index)
      )
    }
    // Ordered: prefix, then the branch's own messages immediately after the anchor.
    expect(exportedMarkers[0]).toBe(marker('MAINMARK', 0))
    const anchorPosition = exportedMarkers.indexOf(marker('MAINMARK', BRANCH_ANCHOR_INDEX))
    expect(anchorPosition, 'the branch anchor must be the last inherited prefix row').toBe(BRANCH_PREFIX_COUNT - 1)
    expect(exportedMarkers[anchorPosition + 1]).toBe(marker('BRANCHMARK', 0))
    expect(exportedMarkers[exportedMarkers.length - 1]).toBe(marker('BRANCHMARK', BRANCH_OWN_COUNT - 1))
    expect(probe.canvasHeight).toBe(pngSize!.height)
    expect(probe.hostDomRowCount, 'export render must not duplicate live message anchors').toBe(0)

    const after = await projectionState(page, topicId)
    expect(after.activeRoute, 'the viewed route must not change').toBe(branchId)
    expect(after.loadedIds, 'the loaded branch window must not change').toEqual(before.loadedIds)
    expect(after.domCount, 'rendered rows must not change').toBe(before.domCount)
    expect(after.scrollTop, 'the viewport must not move').toBe(before.scrollTop)
    expect(after.leftoverHosts, 'the transient export host must be removed').toBe(0)
    expect(after.liveHideScrollbar, 'no capture style may leak onto the live container').toBe(false)

    console.log(
      `[E2E] branch topic image export png=${pngSize!.width}x${pngSize!.height} route=${branchId} markers=${exportedMarkers.length} (prefix=${BRANCH_PREFIX_COUNT} branch=${BRANCH_OWN_COUNT}) loaded=${before.loadedIds.length}/${BRANCH_ROUTE_TOTAL} scrollTop=${before.scrollTop}`
    )
  })

  /**
   * Reported regression guarded here: the exported thinking-block header used
   * to come out with the light-theme heading color while the page was dark,
   * because the detached export root re-applied no antd theme scope.
   *
   * The export render must resolve the same antd tokens as the live page (same
   * computed header colors) in both themes, and must not fall back to the light
   * heading color in dark mode. The PNG itself is written through the production
   * save path and must be a non-empty image.
   */
  test('renders the exported thinking-block header with the live theme colors in dark and light', async ({
    mainWindow,
    electronApp,
    ownedTmpRoot
  }) => {
    const page = mainWindow
    test.setTimeout(240000)
    await waitForAppReady(page)
    await page.waitForFunction(() => Boolean((window as any).store), undefined, { timeout: 60000 })

    const topicId = `e2e-theme-image-export-${Date.now()}`
    const topicName = `Theme Export ${topicId}`

    const assistantId = await page.evaluate(
      () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
    )
    expect(assistantId, 'a live assistant is required for seeding').toBeTruthy()
    await seedMarkedTopic(
      page,
      assistantId as string,
      topicId,
      topicName,
      THINKING_SEED_TOTAL,
      'THINKMARK',
      buildThinkingEntries
    )

    const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
    await topicItem.waitFor({ state: 'attached', timeout: 20000 })
    await topicItem.scrollIntoViewIfNeeded()
    await topicItem.click()
    await page.waitForFunction(
      (topicId: string) => {
        const state = (window as any).store.getState()
        const ids = state.messages?.messageIdsByTopic?.[topicId]
        return Array.isArray(ids) && ids.length > 0 && state.messages?.loadingByTopic?.[topicId] !== true
      },
      topicId,
      { timeout: 30000 }
    )
    await page.waitForFunction(
      () => Boolean(document.querySelector('#messages .message-thought-container .ant-collapse-header')),
      undefined,
      { timeout: 30000 }
    )

    const rounds = [
      { mode: 'dark' as const, fileName: 'topic-dark.png', darkText: true },
      { mode: 'light' as const, fileName: 'topic-light.png', darkText: false }
    ]
    const samples: Record<string, { live: string; exported: string }> = {}

    for (const round of rounds) {
      await setThemeMode(page, round.mode, electronApp)

      const live = await waitForSettledLiveHeader(page)
      expect(live.appliedTheme, `the page must render the ${round.mode} theme`).toBe(round.mode)
      expect(live.headerColor, `the live ${round.mode} thinking header must be rendered`).not.toBeNull()

      const pngPath = await redirectSaveDialog(electronApp, ownedTmpRoot, round.fileName)
      await installCaptureProbe(page, 'THINKMARK-\\d{3}')

      await exportTopicImageViaMenu(page, topicItem)

      await expect
        .poll(() => (fs.existsSync(pngPath) ? fs.statSync(pngPath).size : 0), { timeout: 90000 })
        .toBeGreaterThan(0)

      const pngSize = parsePngSize(fs.readFileSync(pngPath))
      expect(pngSize, `the ${round.mode} export must be a PNG`).not.toBeNull()
      expect(pngSize!.width).toBeGreaterThan(200)
      expect(pngSize!.height).toBeGreaterThan(200)

      const probe = await page.evaluate(() => (window as any).__exportProbe ?? null)
      expect(probe, `the ${round.mode} export render must have been captured`).not.toBeNull()
      expect(probe.markers, 'every seeded message must reach the export render').toContain(
        `THINKMARK-${pad(THINKING_SEED_TOTAL - 1, 3)}`
      )
      expect(probe.exportHeaderColor, `the ${round.mode} export must contain the thinking header`).not.toBeNull()

      // Same antd scope as the live page: identical resolved header colors.
      expect(probe.exportHeaderColor, `the ${round.mode} export header must use the live heading color`).toBe(
        live.headerColor
      )
      expect(probe.exportHeaderTextColor, `the ${round.mode} export header text must use the live text color`).toBe(
        live.textColor
      )

      const luminance = colorLuminance(probe.exportHeaderColor)
      expect(Number.isFinite(luminance), 'the header color must resolve to a computed rgb() color').toBe(true)
      if (round.darkText) {
        expect(luminance, 'the dark-theme exported header must not be black').toBeGreaterThan(128)
      } else {
        expect(luminance, 'the light-theme exported header must keep dark text').toBeLessThan(128)
      }

      samples[round.mode] = { live: live.headerColor as string, exported: probe.exportHeaderColor as string }

      console.log(
        `[E2E] themed topic image export theme=${round.mode} png=${pngSize!.width}x${pngSize!.height} liveHeader=${live.headerColor} exportHeader=${probe.exportHeaderColor}`
      )
    }

    // The dark export must not reuse the light heading color (the regression).
    expect(samples.dark.exported, 'the dark export must not fall back to the light-theme heading color').not.toBe(
      samples.light.live
    )

    const leftoverHosts = await page.evaluate(() => document.querySelectorAll('[data-topic-export-host]').length)
    expect(leftoverHosts, 'the transient export host must be removed').toBe(0)
  })

  test('export options settings page is the only export configuration surface', async ({ mainWindow }) => {
    const page = mainWindow
    test.setTimeout(120000)
    await waitForAppReady(page)
    await page.waitForFunction(() => Boolean((window as any).store), undefined, { timeout: 60000 })

    const labels = await exportLabels(page)
    await openExportOptionsPage(page)

    const panel = page.locator('[data-testid="settings-page"]')
    // One export page, reachable from the data settings menu.
    await expect(panel.getByText(labels.exportOptionsTitle, { exact: true }).first()).toBeVisible()
    // The path label is export-generic (it serves Markdown, JSON and images).
    await expect(panel.getByText(labels.pathTitle, { exact: true })).toBeVisible()
    await expect(panel.locator(`input[placeholder="${labels.pathPlaceholder}"]`)).toHaveCount(1)

    // Exactly the retained switches: include-thinking + the two citation toggles.
    const switches = panel.locator('.ant-switch')
    await expect(switches).toHaveCount(3)
    await expect(panel.getByText(labels.includeThinking, { exact: true })).toBeVisible()
    await expect(panel.getByText(labels.excludeCitations, { exact: true })).toBeVisible()
    await expect(panel.getByText(labels.standardizeCitations, { exact: true })).toBeVisible()

    // Fresh profile: thinking is not exported unless the user opts in.
    const includeChecked = await page.evaluate(
      () => (window as any).store.getState().settings.exportIncludeThinking === true
    )
    expect(includeChecked, 'include-thinking must default to off').toBe(false)
    await expect(switches.nth(0)).not.toBeChecked()

    // The removed export switches and the deleted per-menu export settings page
    // must not be reachable from here.
    const panelText: string = await panel.innerText()
    for (const removed of labels.removedSwitches) {
      expect(panelText.includes(removed), `removed export setting "${removed}" must be gone`).toBe(false)
    }
    for (const removedKey of labels.removedPages) {
      expect(panelText.includes(removedKey), `removed export settings key "${removedKey}" must not render`).toBe(false)
    }

    // The switch is the live control for the shared export option.
    await switches.nth(0).click()
    await expect
      .poll(() => page.evaluate(() => (window as any).store.getState().settings.exportIncludeThinking), {
        timeout: 15000
      })
      .toBe(true)
    await switches.nth(0).click()
    await expect
      .poll(() => page.evaluate(() => (window as any).store.getState().settings.exportIncludeThinking), {
        timeout: 15000
      })
      .toBe(false)

    console.log('[E2E] export options page switches=3 includeDefault=false removedSettings=absent')
  })

  test('exports image, markdown and topic JSON into the configured directory with the thinking option applied', async ({
    mainWindow,
    electronApp,
    ownedTmpRoot
  }) => {
    const page = mainWindow
    test.setTimeout(300000)
    await waitForAppReady(page)
    await page.waitForFunction(() => Boolean((window as any).store), undefined, { timeout: 60000 })
    // A conventional desktop width is required for a real pointer interaction: in
    // the narrow fixture window the message action row overflows into its own
    // horizontal scroll control, and its trailing buttons end up underneath it.
    await (electronApp as any).evaluate(async ({ BrowserWindow }: any) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      win.setSize(1600, 1000)
      win.center()
    })
    await page.waitForTimeout(600)
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    expect(viewport.width, 'the fixture window must provide a desktop-width conversation').toBeGreaterThan(1200)
    console.log(`[E2E] export options viewport=${viewport.width}x${viewport.height}`)

    const labels = await exportLabels(page)
    const exportDir = path.join(ownedTmpRoot, 'exported')

    const topicId = `e2e-export-options-${Date.now()}`
    const topicName = `Options Export ${topicId}`
    const assistantId = await page.evaluate(
      () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
    )
    expect(assistantId, 'a live assistant is required for seeding').toBeTruthy()
    const mainIds = await seedMarkedTopic(
      page,
      assistantId as string,
      topicId,
      topicName,
      THINKING_SEED_TOTAL,
      'OPTMARK',
      buildThinkingEntries
    )
    // A branch keeps the JSON payload's branch data observable.
    const branchId = await createBranchAtAnchor(page, topicId, mainIds[THINKING_INDEX])
    await seedOwnedBranchMessages(page, assistantId as string, topicId, branchId, 2, 'BRANCHMARK')
    const thinkingMessageId = mainIds[THINKING_INDEX]

    // Native dialogs: folder picker → fixture directory, save dialogs recorded.
    await stubExportDialogs(electronApp, exportDir)

    // Choose the default export directory through the production settings UI.
    await openExportOptionsPage(page)
    await selectExportPathViaUi(page, exportDir)
    await backToChat(page)

    await activateTopic(page, topicId, 1)
    const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
    await topicItem.waitFor({ state: 'attached', timeout: 20000 })
    await page.waitForFunction(
      () => Boolean(document.querySelector('#messages .message-thought-container .ant-collapse-header')),
      undefined,
      { timeout: 30000 }
    )

    const before = await projectionState(page, topicId)
    const liveBefore = await liveThinkingBody(page)

    /** Exports the topic image and records its PNG height plus the export thinking body. */
    const exportTopicImage = async (fileNameHint: string) => {
      await installCaptureProbe(page, 'OPTMARK-\\d{3}')
      const names = exportDirNames(exportDir)
      await exportTopicImageViaMenu(page, topicItem)
      const pngPath = await waitForNewExportFile(exportDir, '.png', names)
      const size = parsePngSize(fs.readFileSync(pngPath))
      expect(size, `${fileNameHint} export must be a PNG`).not.toBeNull()
      const probe = await page.evaluate(() => (window as any).__exportProbe ?? null)
      expect(probe, `${fileNameHint} export render must have been captured`).not.toBeNull()
      expect(probe.canvasHeight).toBe(size!.height)
      return { size: size!, probe, name: path.basename(pngPath) }
    }

    // --- includeThinking = false (default) ---------------------------------
    const offImage = await exportTopicImage('collapsed-thinking')
    expect(offImage.probe.exportThinkingBody, 'the topic must carry a thinking block').not.toBeNull()
    expect(
      offImage.probe.exportThinkingBody.active,
      'with the option off the exported thinking block must stay collapsed'
    ).toBe(false)
    expect(
      offImage.probe.exportThinkingBody.hostReasoningVisible,
      'with the option off the reasoning body must not be rendered into the image'
    ).toBe(false)

    const offMarkdownNames = exportDirNames(exportDir)
    const items = await openTopicExportSubmenu(page, topicItem, labels.exportMenuTitle)
    // Always-on menu: image / markdown / topic JSON, and nothing removed.
    expect(items, 'the export menu must offer image, markdown and topic JSON').toEqual(
      expect.arrayContaining([labels.exportImage, labels.exportMarkdown, labels.exportJson])
    )
    expect(
      items.some((item) => /word|plain|纯文本|reasoning|思考/i.test(item)),
      'removed export entries must be gone'
    ).toBe(false)
    await clickMenuItem(page, labels.exportMarkdown)
    const offMarkdownPath = await waitForNewExportFile(exportDir, '.md', offMarkdownNames)
    const offMarkdown = fs.readFileSync(offMarkdownPath, 'utf8')
    expect(offMarkdown, 'the collapsed export must not emit a reasoning <details> block').not.toContain('<details')
    expect(offMarkdown, 'the message body must still be exported').toContain('OPTMARK-000')

    const offJsonNames = exportDirNames(exportDir)
    await openTopicExportSubmenu(page, topicItem, labels.exportMenuTitle)
    await clickMenuItem(page, labels.exportJson)
    const offJsonPath = await waitForNewExportFile(exportDir, '.json', offJsonNames)
    const offJson = fs.readFileSync(offJsonPath, 'utf8')

    // The topic exports must leave the conversation viewport where it was.
    expect((await projectionState(page, topicId)).scrollTop, 'topic exports must not move the viewport').toBe(
      before.scrollTop
    )

    // --- includeThinking = true -------------------------------------------
    // The option's own settings-page switch is covered by the dedicated settings
    // test above. Toggling it here through the store action the switch dispatches
    // keeps the topic list mounted: navigating back to settings between the two
    // export rounds would unmount it and leave dropdown portals orphaned.
    await page.evaluate(() =>
      (window as any).store.dispatch({ type: 'settings/setExportIncludeThinking', payload: true })
    )
    await expect
      .poll(() => page.evaluate(() => (window as any).store.getState().settings.exportIncludeThinking), {
        timeout: 15000
      })
      .toBe(true)
    await topicItem.waitFor({ state: 'attached', timeout: 20000 })

    const beforeOn = await projectionState(page, topicId)

    const onImage = await exportTopicImage('expanded-thinking')
    expect(onImage.probe.exportThinkingBody, 'the topic must carry a thinking block').not.toBeNull()
    expect(
      onImage.probe.exportThinkingBody.active,
      'with the option on the exported thinking block must be expanded'
    ).toBe(true)
    expect(
      onImage.probe.exportThinkingBody.contentHeight,
      'the expanded export body must have a real rendered height'
    ).toBeGreaterThan(0)
    expect(
      onImage.probe.exportThinkingBody.hostReasoningVisible,
      'with the option on the reasoning body must be rendered into the image'
    ).toBe(true)
    expect(onImage.size.height, 'expanding the thinking body must visibly grow the exported image').toBeGreaterThan(
      offImage.size.height + 10
    )
    // The single-message export path has its own case below: the topic list
    // unmounts on the settings route, so that interaction must own no topic menu.

    const onMarkdownNames = exportDirNames(exportDir)
    await openTopicExportSubmenu(page, topicItem, labels.exportMenuTitle)
    await clickMenuItem(page, labels.exportMarkdown)
    const onMarkdownPath = await waitForNewExportFile(exportDir, '.md', onMarkdownNames)
    const onMarkdown = fs.readFileSync(onMarkdownPath, 'utf8')
    expect(onMarkdown, 'the expanded export must carry the reasoning <details> block').toContain('<details')
    expect(onMarkdown, 'the reasoning content must be exported').toContain('OPTMARK-001 reasoning')
    expect(onMarkdown, 'the message body must still be exported').toContain('OPTMARK-000')

    const onJsonNames = exportDirNames(exportDir)
    await openTopicExportSubmenu(page, topicItem, labels.exportMenuTitle)
    await clickMenuItem(page, labels.exportJson)
    const onJsonPath = await waitForNewExportFile(exportDir, '.json', onJsonNames)
    const onJson = fs.readFileSync(onJsonPath, 'utf8')

    // --- JSON is never affected by the thinking option ---------------------
    expect(onJson, 'JSON must always carry the raw reasoning').toContain('OPTMARK-001 reasoning')
    expect(offJson, 'JSON must always carry the raw reasoning').toContain('OPTMARK-001 reasoning')
    expect(onJson, 'JSON must retain branch data').toContain('BRANCHMARK-000')
    expect(offJson, 'JSON must retain branch data').toContain('BRANCHMARK-000')
    const stripVolatile = (value: any): any => {
      if (Array.isArray(value)) return value.map(stripVolatile)
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !/^(exportedAt|generatedAt)$/.test(key))
            .map(([key, entry]) => [key, stripVolatile(entry)])
        )
      }
      return value
    }
    expect(stripVolatile(JSON.parse(onJson)), 'the thinking option must not change the JSON payload').toEqual(
      stripVolatile(JSON.parse(offJson))
    )

    // --- live purity ------------------------------------------------------
    const after = await projectionState(page, topicId)
    const liveAfter = await liveThinkingBody(page)
    expect(after.loadedIds, 'the loaded projection must not change').toEqual(before.loadedIds)
    expect(after.scrollTop, 'the topic exports must not move the viewport').toBe(beforeOn.scrollTop)
    expect(after.leftoverHosts, 'the transient export host must be removed').toBe(0)
    expect(liveAfter, 'the live thinking body must keep its own collapse state').toEqual(liveBefore)

    // --- no native save dialog was needed for any export -------------------
    const calls = await exportDialogCalls(electronApp)
    expect(calls.save, 'no export may fall back to a save dialog when a directory is configured').toBe(0)

    for (const name of [
      offImage.name,
      onImage.name,
      path.basename(offMarkdownPath),
      path.basename(onMarkdownPath),
      path.basename(offJsonPath)
    ]) {
      expect(fs.existsSync(path.join(exportDir, name)), `${name} must be written into the configured directory`).toBe(
        true
      )
    }

    console.log(
      `[E2E] export options image=off:${offImage.size.width}x${offImage.size.height} on:${onImage.size.width}x${onImage.size.height} saveDialogs=${calls.save} mdOff=no-details mdOn=details jsonIdentical=true`
    )
  })

  test('exports a single message thinking body from the message menu into the configured directory', async ({
    mainWindow,
    electronApp,
    ownedTmpRoot
  }) => {
    const page = mainWindow
    test.setTimeout(300000)
    await waitForAppReady(page)
    await page.waitForFunction(() => Boolean((window as any).store), undefined, { timeout: 60000 })
    await (electronApp as any).evaluate(async ({ BrowserWindow }: any) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      win.setSize(1600, 1000)
      win.center()
    })
    await page.waitForTimeout(600)
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    expect(viewport.width, 'the fixture window must provide a desktop-width conversation').toBeGreaterThan(1200)

    const labels = await exportLabels(page)
    const exportDir = path.join(ownedTmpRoot, 'exported')
    const topicId = `e2e-single-export-${Date.now()}`
    const assistantId = await page.evaluate(
      () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
    )
    expect(assistantId, 'a live assistant is required for seeding').toBeTruthy()
    const mainIds = await seedMarkedTopic(
      page,
      assistantId as string,
      topicId,
      `Single Export ${topicId}`,
      THINKING_SEED_TOTAL,
      'SINGLEMARK',
      buildThinkingEntries
    )
    const thinkingMessageId = mainIds[THINKING_INDEX]

    await stubExportDialogs(electronApp, exportDir)
    // Directory and option are configured before the conversation menu is ever
    // opened, so this interaction never shares menu state with a topic export.
    await openExportOptionsPage(page)
    await selectExportPathViaUi(page, exportDir)
    await page.locator('.ant-switch').nth(0).click()
    await expect
      .poll(() => page.evaluate(() => (window as any).store.getState().settings.exportIncludeThinking), {
        timeout: 15000
      })
      .toBe(true)
    await backToChat(page)

    await activateTopic(page, topicId, 1)
    await page.waitForFunction(
      () => Boolean(document.querySelector('#messages .message-thought-container .ant-collapse-header')),
      undefined,
      { timeout: 30000 }
    )
    const row = page.locator(`#messages [data-message-id="${thinkingMessageId}"]`).first()
    // The menu opens beside the row, so the row is scrolled to the top of the
    // message list as a user would before opening it.
    await row.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }))
    await revealMessageRow(page, thinkingMessageId)

    const before = await projectionState(page, topicId)
    const liveBefore = await liveThinkingBody(page)
    expect(before.leftoverHosts, 'the transient export host must be removed').toBe(0)

    await installCaptureProbe(page, 'SINGLEMARK-\\d{3}')
    const names = exportDirNames(exportDir)
    await exportMessageImageViaMenu(page, thinkingMessageId, labels.exportMenuTitle, labels.exportImage)
    const singlePath = await waitForNewExportFile(exportDir, '.png', names)
    const probe = await page.evaluate(() => (window as any).__exportProbe ?? null)
    expect(probe, 'the message export must have been captured').not.toBeNull()
    // A single-message export renders that one message, not the message list, so
    // its render root carries no live message anchors.
    expect(probe.hostDomRowCount, 'the export render must not duplicate live message anchors').toBe(0)
    // The one rendered message may repeat its marker (summary and body), so the
    // distinct marker set is what proves the single-message scope.
    expect(
      new Set((probe.markers as string[]).filter((marker: string) => /^SINGLEMARK-\d{3}$/.test(marker))).size,
      'only the chosen message may be exported'
    ).toBe(1)
    expect(probe.exportThinkingBody, 'the exported message must carry its thinking block').not.toBeNull()
    expect(probe.exportThinkingBody.active, 'the message export must expand the body').toBe(true)
    expect(
      probe.exportThinkingBody.contentHeight,
      'the expanded body must have a real rendered height'
    ).toBeGreaterThan(0)
    expect(probe.exportThinkingBody.hostReasoningVisible, 'the reasoning body must be rendered').toBe(true)
    const size = parsePngSize(fs.readFileSync(singlePath))
    expect(size, 'the single-message export must be a PNG').not.toBeNull()
    expect(probe.canvasHeight).toBe(size!.height)
    expect(fs.existsSync(singlePath), 'the image must be written into the configured directory').toBe(true)

    // --- live purity ------------------------------------------------------
    const after = await projectionState(page, topicId)
    expect(after.loadedIds, 'the loaded projection must not change').toEqual(before.loadedIds)
    expect(after.scrollTop, 'the message export must not move the viewport').toBe(before.scrollTop)
    expect(after.leftoverHosts, 'the transient export host must be removed').toBe(0)
    expect(await liveThinkingBody(page), 'the live thinking body must keep its own collapse state').toEqual(liveBefore)

    // --- no native save dialog was needed for the export -------------------
    const calls = await exportDialogCalls(electronApp)
    expect(calls.save, 'no export may fall back to a save dialog when a directory is configured').toBe(0)

    console.log(
      `[E2E] single message export=${size!.width}x${size!.height} rows=${probe.hostDomRowCount} saveDialogs=${calls.save}`
    )
  })
})
