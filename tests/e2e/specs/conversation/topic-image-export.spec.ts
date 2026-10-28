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
            exportBodyColor: content ? getComputedStyle(content).color : null
          }
        }
      } catch {
        // probe failure must never break the production capture
      }
      return original.apply(this, args)
    }
  }, markerPattern)
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
  await exportParent.hover()
  const imageItem = page.getByRole('menuitem', { name: /^(导出为图片|Export as image)$/ }).first()
  await imageItem.waitFor({ state: 'visible', timeout: 15000 })
  await imageItem.click()
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
})
