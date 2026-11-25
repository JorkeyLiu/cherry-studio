import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

import { BasePage } from './base.page'

/**
 * Centered task shell hosting secondary routes (settings / files / knowledge)
 * above the always-mounted, always-visible Home base.
 *
 * Harness-visible contract this page object relies on (code units must supply
 * it; assertions here stay locale-independent on purpose):
 * - the shell exposes `data-testid="task-dialog"` on a style-only
 *   (`display:contents`) seam that carries NO role and NO aria-modal, so it
 *   never duplicates the native dialog semantics;
 * - the seam lives INSIDE the antd/rc-dialog panel: `modalRender` renders into
 *   the panel's content area, so the native `role="dialog"` element is the
 *   seam's ANCESTOR (never its descendant). `nativeDialog` therefore resolves
 *   by "the single native dialog that contains the seam";
 * - exactly one such native dialog is exposed per open shell, and it keeps an
 *   accessible name of its own;
 * - the shell renders NO header/title and NO close control: dismissal is the
 *   backdrop — a click on the shell's own `.ant-modal-wrap` outside the panel,
 *   the user's primary path — plus Escape for keyboard coverage. There is no
 *   in-shell close affordance to click;
 * - the panel is a child of its own `.ant-modal-wrap` (`wrap`), the mask/scroll
 *   container: a click whose target IS that wrap (so: outside the panel)
 *   dismisses the shell; the point is measured at run time, never assumed;
 * - closing always navigates back to the Home route ('/') explicitly, which is
 *   what makes the URL assertion after close meaningful.
 *
 * Visibility rules this page object encodes:
 * - a `display:contents` box has no layout box, so Playwright reports the seam
 *   itself as NOT visible even while the shell is fully open: open state is
 *   proven by the native dialog's visibility plus the seam's attachment;
 * - closed state is proven by both being hidden (absent satisfies "hidden").
 */
export class TaskDialogPage extends BasePage {
  /** Outer task-shell testid. */
  static readonly TESTID = 'task-dialog'
  /** Selector for the stable style-only wrapper shell. */
  static readonly SELECTOR = `[data-testid="${TaskDialogPage.TESTID}"]`
  /** Home route hash shapes accepted for an explicit close. */
  static readonly HOME_URL = /.*#\/$|.*#$|.*#\/home.*/
  /**
   * Minimum backdrop band depth a dismissal click point may be derived from.
   * The band is split in half by the click point, so the point keeps at least
   * half of this distance from both the wrap edge and the panel edge.
   */
  private static readonly BACKDROP_BAND_MIN = 8

  /** Stable style-only seam (`data-testid="task-dialog"`; no role of its own). */
  readonly dialog: Locator
  /**
   * Every native accessible dialog whose subtree contains the seam. The single
   * role guarantee is asserted on this set (per open shell): a legitimately
   * nested TopView child modal would add a second native dialog to the page,
   * so a page-wide count is not the shell's contract.
   */
  readonly nativeDialogs: Locator
  /** The single native accessible dialog that CONTAINS the seam. */
  readonly nativeDialog: Locator
  /** The shell's own mask/scroll container (its native parent wrap, never a sibling's). */
  readonly wrap: Locator

  constructor(page: Page) {
    super(page)
    this.dialog = page.locator(TaskDialogPage.SELECTOR).first()
    // `modalRender` output renders inside rc-dialog's panel, so the native
    // `role="dialog"` is an ancestor of the seam. `:has()` expresses that
    // relationship directly and cannot silently match another surface.
    this.nativeDialogs = page.locator(`[role="dialog"]:has(${TaskDialogPage.SELECTOR})`)
    this.nativeDialog = this.nativeDialogs.first()
    // Same `:has()` scoping for the mask container: a sibling surface's wrap
    // never contains this shell's seam, so the dismissal click can only land
    // on the wrap this panel actually belongs to.
    this.wrap = page.locator(`.ant-modal-wrap:has(${TaskDialogPage.SELECTOR})`).first()
  }

  /**
   * Wait for an active task dialog: exactly one seam, exactly one native dialog
   * containing it, and that native dialog is visible.
   */
  async waitForOpen(timeout: number = 15000): Promise<void> {
    await expect(this.page.locator(TaskDialogPage.SELECTOR)).toHaveCount(1, { timeout })
    await expect(this.dialog).toBeAttached({ timeout })
    await expect(this.nativeDialogs).toHaveCount(1, { timeout })
    await expect(this.nativeDialog).toBeVisible({ timeout })
  }

  /** Assert an open task dialog (same contract as `waitForOpen`). */
  async expectOpen(timeout: number = 15000): Promise<void> {
    await this.waitForOpen(timeout)
  }

  /** Wait until no task dialog is exposed (absent or hidden). */
  async waitForClosed(timeout: number = 15000): Promise<void> {
    await expect(this.nativeDialog).toBeHidden({ timeout })
    await expect(this.dialog).toBeHidden({ timeout })
  }

  /** Whether a task dialog is currently exposed. */
  async isOpen(): Promise<boolean> {
    return this.nativeDialog.isVisible().catch(() => false)
  }

  /**
   * Resolve a click point — relative to the shell's own wrap — that lands ON
   * the wrap, i.e. on the visible backdrop beside/above the panel, never on
   * the panel or a child of it. Geometry is measured at run time instead of
   * assumed: the point must come from a backdrop band at least
   * `BACKDROP_BAND_MIN` px deep, sits at that band's midpoint (maximal
   * clearance from both the wrap and the panel edge), and hit-tests to the
   * wrap itself. The panel height is capped at `100dvh - 48px`, so a centered
   * panel always leaves such a band; a window that leaves none fails loudly
   * rather than clicking through the panel.
   */
  private async backdropClickPoint(): Promise<{ x: number; y: number }> {
    const seam = await this.dialog.elementHandle()
    if (!seam) throw new Error('task-dialog seam is not attached; there is no backdrop to click')
    const resolved = await seam.evaluate((seamEl, bandMin) => {
      const wrap = seamEl.closest('.ant-modal-wrap')
      const panel = seamEl.closest('[role="dialog"]')
      if (!wrap || !panel) return { point: null, rejected: ['no wrap/panel ancestor'] }
      const wrapRect = wrap.getBoundingClientRect()
      const panelRect = panel.getBoundingClientRect()
      const midX = wrapRect.left + wrapRect.width / 2
      const midY = wrapRect.top + wrapRect.height / 2
      const candidates = [
        { name: 'left', depth: panelRect.left - wrapRect.left, x: (wrapRect.left + panelRect.left) / 2, y: midY },
        {
          name: 'right',
          depth: wrapRect.right - panelRect.right,
          x: (panelRect.right + wrapRect.right) / 2,
          y: midY
        },
        {
          name: 'bottom',
          depth: wrapRect.bottom - panelRect.bottom,
          x: midX,
          y: (panelRect.bottom + wrapRect.bottom) / 2
        },
        { name: 'top', depth: panelRect.top - wrapRect.top, x: midX, y: (wrapRect.top + panelRect.top) / 2 }
      ]
      const rejected: string[] = []
      for (const candidate of candidates) {
        if (candidate.depth < bandMin) {
          rejected.push(`${candidate.name}: band ${Math.round(candidate.depth)}px < ${bandMin}px`)
          continue
        }
        const hit = document.elementFromPoint(candidate.x, candidate.y)
        if (hit !== wrap) {
          rejected.push(`${candidate.name}: hit ${hit?.className ?? 'nothing'} instead of the wrap`)
          continue
        }
        return {
          point: { x: candidate.x - wrapRect.left, y: candidate.y - wrapRect.top },
          rejected
        }
      }
      return { point: null, rejected }
    }, TaskDialogPage.BACKDROP_BAND_MIN)
    if (!resolved.point) {
      throw new Error(
        `task dialog exposes no backdrop band >= ${TaskDialogPage.BACKDROP_BAND_MIN}px to click: ${resolved.rejected.join('; ')}`
      )
    }
    return resolved.point
  }

  /**
   * Dismiss through the backdrop (the user's primary path): click the shell's
   * own wrap outside the panel, then assert the shell is closed and the route
   * returned to '/'. The click is a real mouse gesture at a validated point;
   * Playwright would reject it if the panel intercepted that point.
   */
  async closeWithBackdrop(timeout: number = 15000): Promise<void> {
    await expect(this.nativeDialog).toBeVisible({ timeout })
    await expect(this.wrap).toBeVisible({ timeout })
    const position = await this.backdropClickPoint()
    await this.wrap.click({ position, timeout: 5000 })
    await this.waitForClosed(timeout)
    await expect(this.page).toHaveURL(TaskDialogPage.HOME_URL, { timeout })
  }

  /**
   * Close with the keyboard path (topmost dialog only). Escape reaches the
   * shell only once the open shell owns focus, so callers that depend on the
   * settle state must wait for it first. Kept separate from the backdrop path:
   * backdrop is the user's primary dismissal, this is keyboard coverage.
   */
  async closeWithEscape(timeout: number = 15000): Promise<void> {
    await this.page.keyboard.press('Escape')
    await this.waitForClosed(timeout)
    await expect(this.page).toHaveURL(TaskDialogPage.HOME_URL, { timeout })
  }

  /**
   * Dismiss the task shell through the backdrop. The shell has no in-shell
   * close control, so the backdrop click IS the close path — `closeWithEscape`
   * stays separate for keyboard coverage.
   */
  async close(timeout: number = 15000): Promise<void> {
    await this.closeWithBackdrop(timeout)
  }

  /**
   * The shell renders no visible chrome: no header, no title, no close control.
   * Scoped to the shell's own native dialog on purpose — a nested child dialog
   * legitimately owns a header, a title and a close button of its own, and this
   * assertion must not impose the shell's chrome contract on it.
   */
  async expectNoVisibleChrome(timeout: number = 15000): Promise<void> {
    await expect(this.nativeDialog.locator('.ant-modal-header')).toBeHidden({ timeout })
    await expect(this.nativeDialog.locator('.ant-modal-title')).toBeHidden({ timeout })
    await expect(this.nativeDialog.locator('.ant-modal-close')).toBeHidden({ timeout })
    await expect(this.nativeDialog.locator('[data-testid="task-dialog-close"]')).toBeHidden({ timeout })
  }

  /**
   * Shell accessibility + chrome contract: exactly one native dialog containing
   * the seam, a non-empty accessible name on it, and no visible header/title/
   * close control. The name survives the visual header removal — the shell must
   * stay an addressable dialog even without `.ant-modal-title`.
   */
  async expectAccessibleShell(timeout: number = 15000): Promise<void> {
    await expect(this.nativeDialogs).toHaveCount(1, { timeout })
    await expect(this.nativeDialog).toHaveAccessibleName(/[^\s]/, { timeout })
    await this.expectNoVisibleChrome(timeout)
  }

  /** Assert the dialog is still the active centered route surface. */
  async expectActiveRoute(): Promise<void> {
    await this.waitForOpen()
    await expect(this.page.locator('[data-testid="route-error-fallback"]')).toHaveCount(0)
  }
}
