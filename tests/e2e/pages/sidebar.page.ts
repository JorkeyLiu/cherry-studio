import { test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

import { BasePage } from './base.page'

import { TaskDialogPage } from './task-dialog.page'

/**
 * Page Object for the Sidebar/Navigation component.
 * Handles navigation between different sections of the app.
 *
 * Navigation contract (test-side only, no production semantics):
 * - The real UI click is always the primary path; hash navigation is only an
 *   explicit compatibility fallback for a missing nav icon, detected AFTER the
 *   sidebar is ready — never by burning a click timeout.
 * - A real click error fails loudly (never caught as success); a missed URL
 *   fails loudly (never swallowed).
 * - URL matching uses RegExp: double-star hash globs (star-star-slash-hash
 *   prefix) never match this app's `...index.html#/...` file URLs (that glob
 *   shape requires a `/` immediately before `#`), which previously burned a
 *   silent 10s `waitForURL` timeout on every navigation.
 * - Secondary routes (settings / files / knowledge) render inside a centered
 *   `task-dialog` above an always-visible Home base; an open dialog is closed
 *   through its backdrop dismissal (the shell renders no close control) before
 *   any further navigation click.
 */
export class SidebarPage extends BasePage {
  readonly sidebar: Locator
  readonly homeLink: Locator
  readonly storeLink: Locator
  readonly knowledgeLink: Locator
  readonly filesLink: Locator
  readonly settingsLink: Locator
  readonly appsLink: Locator
  readonly translateLink: Locator

  constructor(page: Page) {
    super(page)
    this.sidebar = page.locator('[class*="Sidebar"], nav, aside')
    // Stable production testids (Sidebar.tsx); legacy href locators kept as fallback.
    this.homeLink = page.locator('[data-testid="sidebar-nav-assistants"], a[href="#/"], a[href="#!/"]').first()
    this.storeLink = page.locator('a[href*="/store"]')
    this.knowledgeLink = page.locator('[data-testid="sidebar-nav-knowledge"], a[href*="/knowledge"]')
    this.filesLink = page.locator('[data-testid="sidebar-nav-files"], a[href*="/files"]')
    this.settingsLink = page.locator('[data-testid="sidebar-nav-settings"], a[href*="/settings"]')
    this.appsLink = page.locator('a[href*="/apps"]')
    this.translateLink = page.locator('a[href*="/translate"]')
  }

  /**
   * Close an open task dialog (settings / files / knowledge) through its
   * backdrop dismissal and verify the contract: dialog gone, route home.
   * Returns whether a dialog was actually open.
   */
  private async closeTaskDialogIfOpen(): Promise<boolean> {
    const dialogPage = new TaskDialogPage(this.page)
    if (!(await dialogPage.isOpen())) return false
    await dialogPage.closeWithBackdrop()
    return true
  }

  /**
   * Shared navigation core: sidebar-ready gate, explicit missing-icon hash
   * fallback, real UI click otherwise, loud URL verification.
   *
   * `iconTestId === null` means production renders no sidebar icon for this
   * destination (no such `data-testid` exists): the explicit hash fallback is
   * the only path and no click timeout is ever burned. A non-null testid that
   * is absent after the sidebar is ready takes the same explicit fallback.
   */
  private async navigateViaSidebar(options: {
    label: string
    iconTestId: string | null
    clickTarget: Locator
    hashFallback: string
    urlExpect: RegExp
  }): Promise<void> {
    const { label, iconTestId, clickTarget, hashFallback, urlExpect } = options
    await test.step(`sidebar ${label}`, async () => {
      // Sidebar-ready gate on the always-rendered settings nav icon (stable
      // production testid, visible on every main-window route). Deliberately
      // specific: a broad-union `.first()` can pin a hidden element and never
      // satisfy `visible`.
      await this.page
        .locator('[data-testid="sidebar-nav-settings"]')
        .first()
        .waitFor({ state: 'visible', timeout: 10000 })
      // A centered task dialog owns the active route surface and covers the
      // sidebar: close it through its backdrop dismissal (which navigates '/')
      // before issuing any navigation click, so nothing is clicked through an
      // overlay.
      await this.closeTaskDialogIfOpen()
      const iconCount = iconTestId === null ? 0 : await this.page.locator(`[data-testid="${iconTestId}"]`).count()
      if (iconCount === 0) {
        // Explicit compatibility fallback for a missing nav icon: hash
        // navigate directly WITHOUT burning a click timeout.
        await this.navigateTo(hashFallback)
      } else {
        // Real UI click stays the primary path. A genuine click failure
        // throws here and is never caught as success.
        await clickTarget.click({ timeout: 5000 })
      }
      // A missed URL must fail loudly — never swallowed as success.
      await this.page.waitForURL(urlExpect, { timeout: 10000 })
    })
  }

  /**
   * Navigate to Home page.
   *
   * Task-dialog contract: settings/files/knowledge render inside a centered
   * task dialog above Home, so the base is never hidden and the sidebar can
   * sit behind the dialog surface. When a dialog is open the backdrop
   * dismissal IS the navigation — it lands on '/' by contract — so no click is
   * ever aimed through the overlay.
   */
  async goToHome(): Promise<void> {
    await test.step('sidebar goToHome', async () => {
      await this.page
        .locator('[data-testid="sidebar-nav-settings"]')
        .first()
        .waitFor({ state: 'visible', timeout: 10000 })
      const closedByDialog = await this.closeTaskDialogIfOpen()
      if (!closedByDialog) {
        const iconCount = await this.page.locator('[data-testid="sidebar-nav-assistants"]').count()
        if (iconCount === 0) {
          await this.navigateTo('/')
        } else {
          await this.homeLink.click({ timeout: 5000 })
        }
      }
      await this.page.waitForURL(/.*#\/$|.*#$|.*#\/home.*/, { timeout: 10000 })
    })
  }

  /**
   * Navigate to Knowledge page.
   */
  async goToKnowledge(): Promise<void> {
    await this.navigateViaSidebar({
      label: 'goToKnowledge',
      iconTestId: 'sidebar-nav-knowledge',
      clickTarget: this.knowledgeLink,
      hashFallback: '/knowledge',
      urlExpect: /.*#\/knowledge.*/
    })
    await new TaskDialogPage(this.page).expectOpen()
  }

  /**
   * Navigate to Settings page.
   *
   * Task-dialog contract: secondary routes render inside the centered
   * `task-dialog` (opened via the real settings nav click or the hash
   * fallback), so the caller lands on `/settings/...` with the Home base
   * still mounted and visible underneath the dialog surface.
   */
  async goToSettings(): Promise<void> {
    await this.navigateViaSidebar({
      label: 'goToSettings',
      iconTestId: 'sidebar-nav-settings',
      clickTarget: this.settingsLink,
      hashFallback: '/settings/provider',
      urlExpect: /.*#\/settings\/.*/
    })
    await new TaskDialogPage(this.page).expectOpen()
  }

  /**
   * Navigate to Files page.
   */
  async goToFiles(): Promise<void> {
    await this.navigateViaSidebar({
      label: 'goToFiles',
      iconTestId: 'sidebar-nav-files',
      clickTarget: this.filesLink,
      hashFallback: '/files',
      urlExpect: /.*#\/files.*/
    })
    await new TaskDialogPage(this.page).expectOpen()
  }

  /**
   * Navigate to Apps page.
   */
  async goToApps(): Promise<void> {
    await this.navigateViaSidebar({
      label: 'goToApps',
      iconTestId: null,
      clickTarget: this.appsLink,
      hashFallback: '/apps',
      urlExpect: /.*#\/apps.*/
    })
  }

  /**
   * Navigate to Store page.
   */
  async goToStore(): Promise<void> {
    await this.navigateViaSidebar({
      label: 'goToStore',
      iconTestId: null,
      clickTarget: this.storeLink,
      hashFallback: '/store',
      urlExpect: /.*#\/store.*/
    })
  }

  /**
   * Navigate to Translate page.
   */
  async goToTranslate(): Promise<void> {
    await this.navigateViaSidebar({
      label: 'goToTranslate',
      iconTestId: null,
      clickTarget: this.translateLink,
      hashFallback: '/translate',
      urlExpect: /.*#\/translate.*/
    })
  }

  /**
   * Check if sidebar is visible.
   */
  async isVisible(): Promise<boolean> {
    return this.sidebar.first().isVisible()
  }
}
