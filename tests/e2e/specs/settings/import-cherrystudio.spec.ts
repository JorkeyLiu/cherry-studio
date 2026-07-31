/**
 * E2E: Phase 6 L2 — Cherry Studio ZIP import UI (selecting phase only).
 *
 * LOCK-E2E3: Does NOT click Select File, start import, or perform promotion.
 * Verifies: navigation to Import Outside Application Data, modal open,
 * modal content (title, description, replace-all warning, OK button enabled),
 * and modal close via the X button (Cancel is disabled during selecting phase).
 */
import { expect, test } from '../../fixtures/electron.fixture'
import { SettingsPage } from '../../pages/settings.page'
import { SidebarPage } from '../../pages/sidebar.page'
import { waitForAppReady } from '../../utils/wait-helpers'

test.describe('Cherry Studio Import UI', () => {
  let settingsPage: SettingsPage
  let sidebarPage: SidebarPage

  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
    sidebarPage = new SidebarPage(mainWindow)
    settingsPage = new SettingsPage(mainWindow)

    // Navigate to Settings → Data
    await sidebarPage.goToSettings()
    await mainWindow.waitForTimeout(1000)
    await settingsPage.goToData()
    await mainWindow.waitForTimeout(500)
  })

  test('Import Outside Application Data: modal opens, shows content, and closes', async ({ mainWindow }) => {
    // 1. Navigate to the Import Outside Application Data sub-menu inside Data settings.
    //    The menu uses a ListItem with key='import_settings' whose title is the i18n key
    //    'settings.data.import_settings.title' → "Import Outside Application Data".
    const importMenuItem = mainWindow.locator('text=Import Outside Application Data').first()
    await importMenuItem.waitFor({ state: 'visible', timeout: 10000 })
    await importMenuItem.click()
    await mainWindow.waitForTimeout(500)

    // 2. Assert the "Import ZIP Backup" button is visible (Cherry Studio entry).
    const importZipButton = mainWindow.locator('button', { hasText: 'Import ZIP Backup' }).first()
    await expect(importZipButton).toBeVisible({ timeout: 10000 })

    // 3. Click it to open the CherryStudioImportPopup modal.
    await importZipButton.click()

    // 4. Wait for the Ant Design Modal to appear.
    const modal = mainWindow.locator('.ant-modal')
    await modal.waitFor({ state: 'visible', timeout: 10000 })

    // 5. Assert modal title contains "Import Cherry Studio Backup" (from i18n import.cherrystudio.title).
    const modalTitle = mainWindow.locator('.ant-modal-title')
    await expect(modalTitle).toContainText('Cherry Studio')

    // 6. Assert description text is visible in the selecting phase.
    const description = mainWindow.locator('.ant-modal-body')
    await expect(description).toContainText('ZIP backup')

    // 7. Assert the replace-all warning Alert is visible.
    const warningAlert = mainWindow.locator('.ant-alert-warning')
    await expect(warningAlert.first()).toBeVisible()

    // 8. Assert the OK button (Select File) is enabled (not disabled).
    const okButton = mainWindow.locator('.ant-modal-footer button.ant-btn-primary')
    await expect(okButton).toBeVisible()
    await expect(okButton).toBeEnabled()

    // 9. Close the modal via the X button (Cancel is disabled during selecting phase per LOCK-E2E3).
    const closeButton = mainWindow.locator('.ant-modal-close')
    await closeButton.click()

    // 10. Assert the modal has closed.
    await modal.waitFor({ state: 'hidden', timeout: 10000 })
  })
})
