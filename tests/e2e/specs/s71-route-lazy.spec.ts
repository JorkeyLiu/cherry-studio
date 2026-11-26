import { expect, test } from '../fixtures/electron.fixture'
import { TaskDialogPage } from '../pages/task-dialog.page'
import { waitForAppReady } from '../utils/wait-helpers'

/**
 * S7.1 renderer-only lazy boundary E2E — fresh-build, shared fixture, disposable profile.
 *
 * Proves via navigation-associated JS request deltas (not basenames/hashes/manifest):
 * - Home eager usable before any post-listener async route JS
 * - The management-only secondary routes (Files, Knowledge) each cause >=1
 *   previously unseen successful JS request, and their delta sets are distinct
 *   / pairwise disjoint (distinct lazy chunks)
 * - Settings provider drill-in is deliberately NOT a new-chunk claim: Settings
 *   is already registered by the shared chat-idle preload (`importSettingsPage`),
 *   so the regression that matters for that route is "the real page renders in
 *   the shell without re-fetching the preloaded chunk and without a duplicate
 *   render" — asserting a new chunk there would contradict the idle preload
 * - Secondary routes render inside the centered `task-dialog` shell above the
 *   always-visible Home base (paths `/files`, `/knowledge`, `/settings/...`
 *   preserved; notebook page and entries removed with data preserved, so
 *   `/notes` has no chunk and redirects home; `/launchpad` may also redirect
 *   home instead of rendering a chunk)
 * - Query deeplinks keep their path and render the same dialog shell
 *   (`/settings/provider` and the `/settings/model` drill-in)
 * - Locale-independent selectors only (data-testid / ids / hrefs / containers), no English text asserts
 */

function isJsUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.pathname.endsWith('.js')
  } catch {
    return url.endsWith('.js') || /\.js(\?|#|$)/.test(url)
  }
}

test.describe('S7.1 Route lazy loading — Home eager, secondary routes distinct chunks, notebook/launchpad redirect home', () => {
  test('Home eager usable before secondary chunks; lazy dialog routes load distinct chunks; notes/launchpad redirect home', async ({
    mainWindow
  }) => {
    await waitForAppReady(mainWindow)

    // Home eager: locale-independent checks
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    await expect(mainWindow.locator('#app-sidebar')).toBeVisible({ timeout: 15000 })

    // Track successful JS requests via response (file:// status is 200 or 0 in Playwright)
    const successfulJsUrls = new Set<string>()
    // Per-URL request accounting: lets the Settings leg prove that an
    // idle-preloaded chunk is never requested a second time (duplicate fetch).
    const jsRequestCounts = new Map<string, number>()
    const onResponse = (resp: import('@playwright/test').Response) => {
      const url = resp.url()
      if (!isJsUrl(url)) return
      const status = resp.status()
      if ([200, 0, 304].includes(status)) {
        if (!successfulJsUrls.has(url)) {
          successfulJsUrls.add(url)
          console.log(`[E2E] new successful JS response: ${url} status=${status}`)
        }
      }
    }
    const onRequest = (req: import('@playwright/test').Request) => {
      const url = req.url()
      if (isJsUrl(url)) {
        jsRequestCounts.set(url, (jsRequestCounts.get(url) ?? 0) + 1)
        console.log(`[E2E] JS request: ${url} resourceType=${req.resourceType()}`)
      }
    }
    mainWindow.on('response', onResponse)
    mainWindow.on('request', onRequest)

    // Home usable before any post-listener async route JS
    await mainWindow.waitForTimeout(600)
    expect(
      successfulJsUrls.size,
      `Home should be usable before any post-listener JS; saw ${[...successfulJsUrls].join(', ')}`
    ).toBe(0)
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })

    const taskDialog = new TaskDialogPage(mainWindow)

    const navigate = async (path: string): Promise<void> => {
      await mainWindow.evaluate((p) => {
        window.location.hash = p
      }, path)
      await mainWindow.waitForFunction((p) => window.location.hash.includes(p), path, { timeout: 15000 })
      await mainWindow.waitForLoadState('domcontentloaded')
    }

    // Lazy secondary routes: each renders inside `task-dialog` above the
    // always-visible Home base and owns a distinct chunk.
    const chunkRoutes: Array<{
      path: string
      assertRendered: () => Promise<void>
    }> = [
      {
        path: '/files',
        assertRendered: async () => {
          await expect(mainWindow.locator('[data-testid="files-page"]')).toBeVisible({ timeout: 15000 })
          await taskDialog.expectOpen()
          await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
        }
      },
      {
        path: '/knowledge',
        assertRendered: async () => {
          await expect(mainWindow.locator('[data-testid="knowledge-page"]')).toBeVisible({ timeout: 15000 })
          await taskDialog.expectOpen()
          await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
        }
      }
    ]

    const perRouteDeltas: Array<Set<string>> = []
    const globalSeen = new Set<string>()

    for (const route of chunkRoutes) {
      const before = new Set(successfulJsUrls)

      await navigate(route.path)

      // Locale-independent completion
      await route.assertRendered()
      await expect(mainWindow.locator('[data-testid="route-error-fallback"]')).toHaveCount(0, { timeout: 10000 })
      await expect(mainWindow.locator('[data-testid="route-loading-fallback"]')).toHaveCount(0, { timeout: 15000 })

      // Wait for at least one previously unseen successful JS request (delta)
      await expect
        .poll(() => [...successfulJsUrls].filter((u) => !before.has(u)).length, {
          timeout: 15000,
          message: `expected new JS for ${route.path}`
        })
        .toBeGreaterThan(0)

      const delta = new Set([...successfulJsUrls].filter((u) => !before.has(u)))
      expect(delta.size, `delta for ${route.path} should have >=1 new JS`).toBeGreaterThan(0)

      // Distinct: every URL in this delta must be previously unseen and not in any prior delta
      for (const url of delta) {
        expect(globalSeen.has(url), `delta for ${route.path} url ${url} should be previously unseen`).toBe(false)
        for (const prev of perRouteDeltas) {
          expect(prev.has(url), `delta for ${route.path} url ${url} should not overlap prior route`).toBe(false)
        }
      }

      // Route-associated set must be distinct from prior sets (at least one url unique)
      perRouteDeltas.push(delta)
      for (const u of delta) globalSeen.add(u)

      await expect(mainWindow.locator('#app-sidebar')).toBeVisible({ timeout: 15000 })
    }

    expect(perRouteDeltas.length, 'two management-route lazy deltas').toBe(2)
    expect(
      globalSeen.size,
      `two distinct lazy chunk JS should have been observed via deltas: ${[...globalSeen].join(', ')}`
    ).toBeGreaterThanOrEqual(2)
    // Pairwise disjoint
    for (let i = 0; i < perRouteDeltas.length; i++) {
      for (let j = i + 1; j < perRouteDeltas.length; j++) {
        for (const u of perRouteDeltas[i]) {
          expect(perRouteDeltas[j].has(u), `delta ${i} and ${j} should be disjoint, shared ${u}`).toBe(false)
        }
      }
    }

    // Settings provider drill-in: Settings is registered by the shared
    // chat-idle preload, so this leg asserts the properties that still matter —
    // the real page renders inside the shell (path preserved), the preloaded
    // chunk is not fetched again, and the page is rendered exactly once.
    const settingsUrlsBefore = new Set(successfulJsUrls)
    const settingsRequestCountsBefore = new Map(jsRequestCounts)

    await navigate('/settings/provider')
    await expect(mainWindow.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 15000 })
    await expect(mainWindow.locator('a[href*="/settings/provider"]').first()).toBeVisible({ timeout: 15000 })
    await taskDialog.expectOpen()
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    await expect(mainWindow.locator('[data-testid="route-error-fallback"]')).toHaveCount(0, { timeout: 10000 })
    await expect(mainWindow.locator('[data-testid="route-loading-fallback"]')).toHaveCount(0, { timeout: 15000 })
    await expect(mainWindow.locator('#app-sidebar')).toBeVisible({ timeout: 15000 })

    // Give a straggling import a chance to show up before the negative claims.
    await mainWindow.waitForTimeout(700)

    const refetched: string[] = []
    for (const [url, count] of jsRequestCounts) {
      const requestsBefore = settingsRequestCountsBefore.get(url) ?? 0
      if (requestsBefore > 0 && count > requestsBefore) refetched.push(url)
    }
    expect(
      refetched,
      `Settings must reuse the chunks already loaded (idle preload); re-requested: ${refetched.join(', ')}`
    ).toEqual([])

    const settingsDelta = [...successfulJsUrls].filter((u) => !settingsUrlsBefore.has(u))
    expect(
      settingsDelta,
      `Settings is preloaded by the shared chat-idle import and must render without a new JS chunk; new: ${settingsDelta.join(', ')}`
    ).toEqual([])

    // No duplicate render: exactly one settings page surface in the shell.
    expect(await mainWindow.locator('[data-testid="settings-page"]').count()).toBe(1)

    // Settings drill-in deeplink: path preserved, same dialog shell above the
    // always-visible Home base (same settings surface, still no new-JS claim).
    await navigate('/settings/model')
    await expect(mainWindow.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 15000 })
    await taskDialog.expectOpen()
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    await expect(mainWindow.locator('[data-testid="route-error-fallback"]')).toHaveCount(0, { timeout: 10000 })

    // Removed notebook page: no chunk, no shell of its own — `/notes`
    // redirects home with Home visible and no route error. Notebook data
    // preservation (notes dir writes) is covered by the durable Save-to-notes
    // workflow, not by this route contract.
    await mainWindow.evaluate(() => {
      window.location.hash = '/notes'
    })
    await mainWindow.waitForURL(/.*#\/$|.*#$|.*#\/home.*/, { timeout: 15000 })
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    await expect(mainWindow.locator('[data-testid="notes-page"]')).toHaveCount(0)
    await taskDialog.waitForClosed()
    await expect(mainWindow.locator('[data-testid="route-error-fallback"]')).toHaveCount(0)

    // Launchpad: may redirect home instead of rendering a chunk.
    await mainWindow.evaluate(() => {
      window.location.hash = '/launchpad'
    })
    await mainWindow.waitForURL(/.*#\/$|.*#\/launchpad.*|.*#$|.*#\/home.*/, { timeout: 15000 })
    await mainWindow.waitForLoadState('domcontentloaded')
    const launchpadRendered = await mainWindow.locator('[data-testid="launchpad-page"]').count()
    if (launchpadRendered > 0) {
      await expect(mainWindow.locator('[data-testid="launchpad-page"]')).toBeVisible({ timeout: 15000 })
      await expect(mainWindow.locator('#app-sidebar')).toBeVisible({ timeout: 15000 })
    } else {
      // Redirected home: Home visible, no orphan dialog, no route error.
      await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
      await taskDialog.waitForClosed()
      await expect(mainWindow.locator('[data-testid="route-error-fallback"]')).toHaveCount(0)
    }

    // Home remains eagerly usable after secondary chunks loaded — navigate back without new JS
    const beforeHome = new Set(successfulJsUrls)
    await mainWindow.evaluate(() => {
      window.location.hash = '/'
    })
    await mainWindow.waitForFunction(
      () => window.location.hash === '#/' || window.location.hash === '#' || window.location.hash.includes('#/'),
      { timeout: 15000 }
    )
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    await expect(mainWindow.locator('[data-testid="route-error-fallback"]')).toHaveCount(0)
    await expect(mainWindow.locator('[data-testid="route-loading-fallback"]')).toHaveCount(0)
    await taskDialog.waitForClosed()
    await mainWindow.waitForTimeout(700)
    const homeDelta = [...successfulJsUrls].filter((u) => !beforeHome.has(u))
    expect(homeDelta.length, `Home should be eager without new JS, got ${homeDelta.join(', ')}`).toBe(0)

    mainWindow.off('response', onResponse)
    mainWindow.off('request', onRequest)
  })
})
