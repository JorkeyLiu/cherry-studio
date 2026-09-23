import { expect, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

/**
 * Settings idle-preload E2E — fresh build, shared fixture, disposable profile.
 *
 * Regression for the Settings idle-preload runtime defect (empty topic):
 * Messages fires onFirstUpdate once, Chat schedules the 300ms stability
 * timer, and the parent topic-id reset must not clear that just-scheduled
 * timer on first mount. When the defect is present the Settings chunk sees
 * zero requests on the chat home and the first sidebar navigation flashes
 * the route loading fallback (~222ms); when fixed the chunk preloads during
 * home idle and the first click renders Settings synchronously.
 *
 * Proves via real UI + externally observable signals only (no test-only
 * production hook, no fixed sleep race):
 * - Preload completion: event-driven wait for >=1 successful async JS
 *   response while still on the chat home (the only idle JS on home is the
 *   Settings module preload). JS URL/status classification reuses the
 *   s71-route-lazy logic (pathname ends with .js, status in {200, 0, 304}).
 * - Transient fallback capture: a MutationObserver installed BEFORE the
 *   real sidebar click records any added
 *   [data-testid="route-loading-fallback"] node; the final assertion reads
 *   the observer log (a post-click count(0) alone cannot prove a transient
 *   never flashed).
 * - Final state: [data-testid="settings-page"] visible, zero route error.
 */

function isJsUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.pathname.endsWith('.js')
  } catch {
    return url.endsWith('.js') || /\.js(\?|#|$)/.test(url)
  }
}

function isSuccessfulJsStatus(status: number): boolean {
  // file:// successful loads surface as 200 or 0 in Playwright (s71 logic).
  return status === 200 || status === 0 || status === 304
}

test.describe('Settings idle preload — first sidebar click never flashes fallback', () => {
  test('home preload completes, first Settings click renders without transient fallback', async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)

    // Chat home on a fresh disposable profile (empty topic — the repro shape).
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    await expect(mainWindow.locator('#app-sidebar')).toBeVisible({ timeout: 15000 })
    await expect(mainWindow.getByTestId('sidebar-nav-settings')).toBeVisible({ timeout: 15000 })

    // Passive network tap for diagnostics (s71 URL/status classification).
    // Gating does NOT depend on catching the network event: the preload may
    // already have completed during fixture setup, before this tap exists.
    const successfulJsUrls = new Set<string>()
    const onResponse = (resp: import('@playwright/test').Response) => {
      const url = resp.url()
      if (!isJsUrl(url)) return
      const status = resp.status()
      if (isSuccessfulJsStatus(status) && !successfulJsUrls.has(url)) {
        successfulJsUrls.add(url)
        console.log(`[E2E] idle-preload successful JS: ${url} status=${status}`)
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

    // Event-driven preload gate: vite injects a persistent
    // link[href*="SettingsPage"] when the idle importSettingsPage() is
    // initiated. Link elements persist in the DOM, so this works whether the
    // idle import fired before or after this poll starts (no fixed sleep, no
    // network-event race). The static index.html carries no SettingsPage
    // link and no navigation happens before the gate, so its presence proves
    // the chat-home idle preload ran. (file:// loads populate neither the
    // Playwright response tap retroactively nor the resource timeline, hence
    // the DOM-persistent link is the race-free signal; the s71 URL/status
    // classification still backs the network tap below.)
    try {
      try {
        await mainWindow.waitForFunction(() => !!document.querySelector('link[href*="SettingsPage"]'), {
          timeout: 25000
        })
      } catch (error) {
        const diag = await mainWindow
          .evaluate(() => ({
            settingsLinks: Array.from(document.querySelectorAll('link'))
              .map((l) => (l as HTMLLinkElement).href)
              .filter((href) => /SettingsPage/i.test(href)),
            linkCount: document.querySelectorAll('link').length
          }))
          .catch(() => ({ error: '<diagnostic-evaluate-failed>' }))
        console.log(`[E2E] preload gate timed out; diag=${JSON.stringify(diag)}`)
        throw error
      }
      const preloadedSettingsLinks = await mainWindow.evaluate(() =>
        Array.from(document.querySelectorAll('link'))
          .map((l) => (l as HTMLLinkElement).href)
          .filter((href) => /SettingsPage/i.test(href))
      )
      console.log(`[E2E] Settings idle-preload link observed: ${preloadedSettingsLinks.join(', ')}`)

      // Install the transient-fallback observer BEFORE the click.
      await mainWindow.evaluate(() => {
        const w = window as unknown as {
          __idlePreloadFallbackSeen?: string[]
          __idlePreloadFallbackObserver?: MutationObserver
        }
        w.__idlePreloadFallbackSeen = []
        const seen = w.__idlePreloadFallbackSeen
        const record = (kind: string) => {
          seen.push(`${kind}:${Date.now()}`)
        }
        if (document.querySelector('[data-testid="route-loading-fallback"]')) {
          record('pre-existing')
        }
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of Array.from(mutation.addedNodes)) {
              const el = node as HTMLElement
              if (!(el instanceof HTMLElement)) continue
              if (typeof el.matches === 'function' && el.matches('[data-testid="route-loading-fallback"]')) {
                record('added')
              }
              if (
                typeof el.querySelector === 'function' &&
                el.querySelector('[data-testid="route-loading-fallback"]')
              ) {
                record('nested')
              }
            }
          }
        })
        observer.observe(document.body, { childList: true, subtree: true })
        w.__idlePreloadFallbackObserver = observer
      })

      // Real sidebar click (no direct-URL fallback): the production path
      // through Sidebar `to('/settings/provider')`.
      const jsBeforeClick = new Set(successfulJsUrls)
      await mainWindow.getByTestId('sidebar-nav-settings').click()

      // Final state: Settings renders, no route error.
      await expect(mainWindow.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 15000 })
      await expect(mainWindow.locator('[data-testid="route-error-fallback"]')).toHaveCount(0, { timeout: 10000 })

      // Observer proof: no transient fallback was ever added around the click.
      const fallbackSeen = await mainWindow.evaluate(() => {
        const w = window as unknown as { __idlePreloadFallbackSeen?: string[] }
        return w.__idlePreloadFallbackSeen ?? []
      })
      expect(fallbackSeen.length, `transient route fallback flashed: ${JSON.stringify(fallbackSeen)}`).toBe(0)
      await expect(mainWindow.locator('[data-testid="route-loading-fallback"]')).toHaveCount(0)

      // Successful-load proof: the first navigation fetched no SettingsPage
      // JS — the preloaded module served the render synchronously. (A failed
      // or absent preload would retry the chunk fetch on navigation.)
      const refetchedSettings = [...successfulJsUrls].filter((u) => !jsBeforeClick.has(u) && /SettingsPage/i.test(u))
      console.log(
        `[E2E] new JS since click: ${[...successfulJsUrls].filter((u) => !jsBeforeClick.has(u)).join(', ') || '(none)'}`
      )
      expect(refetchedSettings.length, `Settings chunk refetched on first click: ${refetchedSettings.join(', ')}`).toBe(
        0
      )
    } finally {
      mainWindow.off('response', onResponse)
      mainWindow.off('request', onRequest)
      // Observer cleanup even when an assertion above throws.
      await mainWindow
        .evaluate(() => {
          const w = window as unknown as {
            __idlePreloadFallbackSeen?: string[]
            __idlePreloadFallbackObserver?: MutationObserver
          }
          try {
            w.__idlePreloadFallbackObserver?.disconnect()
          } catch {
            // Ignore teardown races.
          }
          delete w.__idlePreloadFallbackObserver
          delete w.__idlePreloadFallbackSeen
        })
        .catch(() => {})
    }
  })
})
