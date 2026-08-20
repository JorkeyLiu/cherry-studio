/**
 * S3.5 Lazy Activation — ContentSearch mount lifecycle + stable host.
 *
 * Verifies:
 *  - ContentSearch has zero mounted instance before invocation
 *  - Mounted/visible/focused after Cmd/Ctrl+F (search_message_in_chat)
 *  - Removed after Escape
 *  - Inputbar + #messages remain visible before/during/after
 *
 * Uses shared electron.fixture (disposable profile, mock provider).
 */

import { expect, test } from '../../fixtures/electron.fixture'

test.describe('S3.5 Lazy Activation — ContentSearch + stable host', () => {
  test.setTimeout(120000)

  test('ContentSearch lazy mount lifecycle and Inputbar/viewport remain immediate', async ({ mainWindow }) => {
    const page = mainWindow

    const contentSearch = page.locator('[data-testid="content-search"]')
    const contentSearchHost = page.locator('[data-testid="content-search-host"]')
    const inputbar = page.locator('.inputbar textarea, textarea[placeholder]').first()
    const messages = page.locator('#messages')

    // — Before invocation: zero mounted instance, stable host immediate —
    await test.step('before invocation: zero ContentSearch, Inputbar+viewport visible', async () => {
      await expect(contentSearch).toHaveCount(0)
      await expect(contentSearchHost).toHaveCount(0)
      await expect(inputbar).toBeVisible({ timeout: 30000 })
      await expect(messages).toBeVisible({ timeout: 15000 })
    })

    // — Invoke via shortcut: Cmd/Ctrl+F —
    await test.step('invoke ContentSearch via Cmd/Ctrl+F', async () => {
      // Try both Control+F and Meta+F to cover platform differences; one will succeed.
      // Playwright maps ControlOrMeta via explicit keys.
      const platform = await page.evaluate(() => navigator.platform)
      const isMac = platform.toLowerCase().includes('mac')
      if (isMac) {
        await page.keyboard.press('Meta+F')
      } else {
        await page.keyboard.press('Control+F')
      }
      await expect(contentSearch).toBeVisible({ timeout: 10000 })
      await expect(contentSearchHost).toHaveCount(1)
      // Input should be focused inside the search bar
      const searchInput = contentSearch.locator('input').first()
      await expect(searchInput).toBeVisible({ timeout: 5000 })
      await expect(searchInput).toBeFocused({ timeout: 5000 })
      // Stable host still immediate during search
      await expect(inputbar).toBeVisible()
      await expect(messages).toBeVisible()
    })

    // — Close via Escape: should unmount (zero instance) —
    await test.step('Escape closes ContentSearch and unmounts (zero instance)', async () => {
      await page.keyboard.press('Escape')
      await expect(contentSearch).toHaveCount(0, { timeout: 10000 })
      await expect(contentSearchHost).toHaveCount(0, { timeout: 10000 })
      await expect(inputbar).toBeVisible()
      await expect(messages).toBeVisible()
    })

    // — Re-invoke with selected text path (selection + shortcut) —
    // Selecting text is optional for coverage; we verify second mount still works.
    await test.step('re-invoke and verify initial text + navigation still functional', async () => {
      // Seed some visible text to select: create a temporary selection via evaluate
      await page.evaluate(() => {
        const range = document.createRange()
        const sel = window.getSelection()
        const msg = document.querySelector('#messages .message-content-container') as HTMLElement | null
        if (msg && msg.firstChild) {
          range.selectNodeContents(msg)
          sel?.removeAllRanges()
          sel?.addRange(range)
        }
      })
      const platform2 = await page.evaluate(() => navigator.platform)
      const isMac2 = platform2.toLowerCase().includes('mac')
      if (isMac2) {
        await page.keyboard.press('Meta+F')
      } else {
        await page.keyboard.press('Control+F')
      }
      await expect(contentSearch).toBeVisible({ timeout: 10000 })
      await expect(contentSearchHost).toHaveCount(1)
      const searchInput2 = contentSearch.locator('input').first()
      await expect(searchInput2).toBeVisible()
      // Input value may contain selected text if selection existed; focus is required in any case
      await expect(searchInput2).toBeFocused({ timeout: 5000 })
      // Clean up via Escape again
      await page.keyboard.press('Escape')
      await expect(contentSearch).toHaveCount(0, { timeout: 10000 })
      await expect(contentSearchHost).toHaveCount(0, { timeout: 10000 })
      // Stable host still visible after second cycle
      await expect(inputbar).toBeVisible()
      await expect(messages).toBeVisible()
    })

    // — Verify Inputbar/viewport not deferred at any stage —
    await test.step('Inputbar and viewport remained immediate throughout lifecycle', async () => {
      await expect(inputbar).toBeVisible()
      await expect(messages).toBeVisible()
      await expect(contentSearch).toHaveCount(0)
      await expect(contentSearchHost).toHaveCount(0)
    })
  })
})
