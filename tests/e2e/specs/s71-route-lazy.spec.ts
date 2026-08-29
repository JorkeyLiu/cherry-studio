import { expect, test } from '../fixtures/electron.fixture'
import { waitForAppReady } from '../utils/wait-helpers'

/**
 * S7.1 renderer-only lazy boundary E2E — fresh-build, shared fixture, disposable profile.
 *
 * Proves via navigation-associated JS request deltas (not basenames/hashes/manifest):
 * - Home eager usable before any post-listener async route JS
 * - Five sequential navigations each cause >=1 previously unseen successful JS request
 * - Per-route delta sets/selected requests are distinct (robust to shared chunks/multiple requests)
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

test.describe('S7.1 Route lazy loading — Home eager, five routes distinct chunks', () => {
  test('Home eager usable before secondary chunks; each secondary route loads distinct lazy chunk and renders', async ({
    mainWindow
  }) => {
    await waitForAppReady(mainWindow)

    // Home eager: locale-independent checks
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    await expect(mainWindow.locator('#app-sidebar')).toBeVisible({ timeout: 15000 })

    // Track successful JS requests via response (file:// status is 200 or 0 in Playwright)
    const successfulJsUrls = new Set<string>()
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

    const routes: Array<{
      path: string
      assertRendered: () => Promise<void>
    }> = [
      {
        path: '/files',
        assertRendered: async () => {
          await expect(mainWindow.locator('[data-testid="files-page"]')).toBeVisible({ timeout: 15000 })
          await expect(mainWindow.locator('#content-container')).toBeVisible({ timeout: 15000 })
        }
      },
      {
        path: '/notes',
        assertRendered: async () => {
          await expect(mainWindow.locator('[data-testid="notes-page"]')).toBeVisible({ timeout: 15000 })
          await expect(mainWindow.locator('#content-container')).toBeVisible({ timeout: 15000 })
        }
      },
      {
        path: '/knowledge',
        assertRendered: async () => {
          await expect(mainWindow.locator('[data-testid="knowledge-page"]')).toBeVisible({ timeout: 15000 })
          await expect(mainWindow.locator('#content-container')).toBeVisible({ timeout: 15000 })
        }
      },
      {
        path: '/settings/provider',
        assertRendered: async () => {
          await expect(mainWindow.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 15000 })
          await expect(mainWindow.locator('a[href*="/settings/provider"]').first()).toBeVisible({ timeout: 15000 })
        }
      },
      {
        path: '/launchpad',
        assertRendered: async () => {
          await expect(mainWindow.locator('[data-testid="launchpad-page"]')).toBeVisible({ timeout: 15000 })
          await expect(mainWindow.locator('#app-sidebar')).toBeVisible({ timeout: 15000 })
        }
      }
    ]

    const perRouteDeltas: Array<Set<string>> = []
    const globalSeen = new Set<string>()

    for (const route of routes) {
      const before = new Set(successfulJsUrls)

      await mainWindow.evaluate((p) => {
        window.location.hash = p
      }, route.path)

      await mainWindow.waitForFunction((p) => window.location.hash.includes(p), route.path, {
        timeout: 15000
      })
      await mainWindow.waitForLoadState('domcontentloaded')

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

    expect(perRouteDeltas.length, 'five sequential route deltas').toBe(5)
    expect(
      globalSeen.size,
      `all five distinct lazy chunk JS should have been observed via deltas: ${[...globalSeen].join(', ')}`
    ).toBeGreaterThanOrEqual(5)
    // Pairwise disjoint
    for (let i = 0; i < perRouteDeltas.length; i++) {
      for (let j = i + 1; j < perRouteDeltas.length; j++) {
        for (const u of perRouteDeltas[i]) {
          expect(perRouteDeltas[j].has(u), `delta ${i} and ${j} should be disjoint, shared ${u}`).toBe(false)
        }
      }
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
    await mainWindow.waitForTimeout(700)
    const homeDelta = [...successfulJsUrls].filter((u) => !beforeHome.has(u))
    expect(homeDelta.length, `Home should be eager without new JS, got ${homeDelta.join(', ')}`).toBe(0)

    mainWindow.off('response', onResponse)
    mainWindow.off('request', onRequest)
  })
})
