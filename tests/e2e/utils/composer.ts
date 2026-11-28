/**
 * Input-island composer readiness (test-side only, no production change).
 *
 * The production composer (`src/renderer/src/pages/home/Inputbar/`) is a
 * dual-mode island: non-empty topics start collapsed (the textarea hides
 * behind `visibility:hidden` + `aria-hidden`, `opacity:0`), empty topics
 * start expanded. The only production-supported ways to expand are a real
 * click on the `inputbar-capsule` trigger or a real keyboard Space/Enter
 * with no editable/overlay focus (see `useInputbarIsland`).
 *
 * `ensureComposerExpanded` reproduces exactly that user path:
 * - if the textarea is already visible (empty topic), return with zero
 *   extra clicks;
 * - otherwise click the real capsule trigger (or press a real keyboard
 *   Enter when the capsule itself is not hit-testable) and wait for the
 *   textarea to become visible AND editable.
 *
 * It never touches styles/DOM directly, never fills while hidden, and never
 * sleeps: every wait is a bounded Playwright actionability/waitForFunction
 * gate. Call it immediately before any direct textarea operation
 * (click/fill/clear/pressSequentially/press).
 */
export const COMPOSER_TEXTAREA_SELECTOR = '.inputbar textarea, textarea[placeholder]'
export const COMPOSER_CAPSULE_TESTID = 'inputbar-capsule'

export async function ensureComposerExpanded(page: any, timeout = 15000): Promise<void> {
  const textarea = page.locator(COMPOSER_TEXTAREA_SELECTOR).first()
  // Empty topics already render expanded: no extra user gesture needed.
  if (await textarea.isVisible()) {
    return
  }
  // Collapsed island: expand through the production trigger, exactly as a
  // user would. Prefer the real capsule click; fall back to a real keyboard
  // Enter (the production collapsed-island shortcut) when the capsule is
  // not hit-testable (e.g. mid-transition).
  const capsule = page.locator(`[data-testid="${COMPOSER_CAPSULE_TESTID}"]`).first()
  if (await capsule.isVisible()) {
    await capsule.click()
  } else {
    await page.keyboard.press('Enter')
  }
  await textarea.waitFor({ state: 'visible', timeout })
  await page.waitForFunction(
    (selector: string) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement | null
      if (!el || el.disabled || el.readOnly) return false
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    },
    COMPOSER_TEXTAREA_SELECTOR,
    { timeout }
  )
}
