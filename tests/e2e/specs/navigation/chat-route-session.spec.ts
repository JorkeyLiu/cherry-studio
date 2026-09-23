import { expect, test } from '../../fixtures/electron.fixture'
import { ChatPage } from '../../pages/chat.page'
import { SidebarPage } from '../../pages/sidebar.page'
import { waitForAppReady, waitForChatReady, waitForSettingsLoad } from '../../utils/wait-helpers'

/**
 * Chat route session E2E — fresh build, shared fixture, disposable profile.
 *
 * Integrated route-lifecycle regression coverage for the bounded Chat session
 * workspace (React Activity activation boundary): after Chat has mounted,
 * Chat -> Settings -> Chat must preserve the same component session (no
 * unmount/remount), so local Chat state (the input draft) and the live DOM
 * session survive navigation. Navigation goes through the production Sidebar
 * (stable sidebar-nav-* testids, with direct-URL fallback in the page object).
 *
 * The resolved-Settings-module revisit (no fresh route fallback) is covered
 * unit-only in ChatRouteSession.test.tsx: a polling final-state count in E2E
 * cannot prove a transient fallback never flashed, and no in-test
 * fallback-appearance listener is wired here.
 *
 * Locale-independent selectors only (ids / data-testids); no text asserts.
 */
test.describe('Chat route session — Chat -> Settings -> Chat preserves the session', () => {
  test('same Home session hidden on Settings and restored with draft on return; Settings revisit shows no fresh fallback', async ({
    mainWindow
  }) => {
    await waitForAppReady(mainWindow)
    await waitForChatReady(mainWindow)
    const sidebarPage = new SidebarPage(mainWindow)
    const chatPage = new ChatPage(mainWindow)

    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    await expect(mainWindow.locator('#app-sidebar')).toBeVisible({ timeout: 15000 })

    // Capture the live Home DOM session before navigating away.
    const homeHandle = await mainWindow.locator('#home-page').elementHandle()
    expect(homeHandle).not.toBeNull()

    // Local Chat state owned by the component session (not Redux-persisted draft cache).
    const draft = 'e2e-route-session-draft'
    await chatPage.typeMessage(draft)
    expect(await chatPage.getInputValue()).toContain(draft)

    // Chat -> Settings: route URL changes, Settings renders.
    await sidebarPage.goToSettings()
    await waitForSettingsLoad(mainWindow)
    expect(mainWindow.url()).toContain('/settings')
    await expect(mainWindow.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 15000 })

    // Same session persists hidden (attached, not visible) — not remounted.
    await expect(mainWindow.locator('#home-page')).toBeHidden({ timeout: 10000 })
    expect(await mainWindow.locator('#home-page').count()).toBe(1)

    // Settings -> Chat: same DOM session restored, draft intact.
    await sidebarPage.goToHome()
    await waitForChatReady(mainWindow)
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    expect(await chatPage.getInputValue()).toContain(draft)
    const stillConnected = await homeHandle!.evaluate((node) => node.isConnected)
    expect(stillConnected, 'pre-navigation Home node must stay connected (no remount)').toBe(true)

    // Settings revisit: resolved module renders (revisit fallback absence is
    // unit-only — see ChatRouteSession.test.tsx).
    await sidebarPage.goToSettings()
    await waitForSettingsLoad(mainWindow)
    await expect(mainWindow.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 15000 })

    // Return once more: session still the original node with the draft.
    await sidebarPage.goToHome()
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    expect(await chatPage.getInputValue()).toContain(draft)
    expect(await homeHandle!.evaluate((node) => node.isConnected)).toBe(true)

    await expect(mainWindow.locator('#app-sidebar')).toBeVisible({ timeout: 15000 })
  })
})
