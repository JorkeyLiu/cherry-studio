import { expect, test } from '../../fixtures/electron.fixture'
import { ChatPage } from '../../pages/chat.page'
import { SidebarPage } from '../../pages/sidebar.page'
import { TaskDialogPage } from '../../pages/task-dialog.page'
import { waitForAppReady, waitForChatReady, waitForSettingsLoad } from '../../utils/wait-helpers'

/**
 * Chat route session E2E — fresh build, shared fixture, disposable profile.
 *
 * Integrated route-lifecycle regression coverage for the bounded Chat session
 * workspace (React Activity activation boundary): after Chat has mounted,
 * secondary routes (Settings here) render inside the centered task shell
 * `testid task-dialog` above the always-mounted, always-VISIBLE Home base.
 * Navigation goes through the production Sidebar (stable sidebar-nav-* testids
 * when rendered, with direct-hash fallback in the page object).
 *
 * This asset's durable workflow (lasting coupled behavior, not visual-only):
 * - path contract: URL carries `/settings/...` while the dialog is open;
 * - workspace continuity: the same Home component session persists — the same
 *   DOM node stays connected, the local input draft survives;
 * - close contract: the backdrop dismissal (the shell renders no visible
 *   header/title/close control; Escape stays the keyboard path) navigates '/'
 *   explicitly and restores the same session;
 * - focus contract: the focus owner of a shell gesture is the owner the gesture
 *   had before it opened — never an invented "always focus the Chat input"
 *   target. The owner differs per gesture, so each gesture is asserted against
 *   its own opener:
 *   · mouse click on the Sidebar settings nav item — that item is a
 *     non-focusable `div` (`styled.div`, no `tabindex`), so a real click leaves
 *     focus on the document body and the body owns focus after close;
 *   · keyboard `Command/Ctrl + ,` invoked from the focused Chat input — the
 *     pre-open owner is the textarea, so the textarea must own focus after
 *     close. Observed current behavior: closing navigates '/' and the router
 *     unmounts the shell before rc-dialog's leave-end `focusTriggerAfterClose`
 *     restore can run, so focus falls back to the document body instead. That
 *     gap is asserted (as a soft assertion so the remaining legs still run) and
 *     must not be mistaken for a passing focus contract;
 * - nested dialogs: a single Escape closes only the topmost child (settings
 *   routes own no nested dialogs, so the escape path here closes the shell).
 *
 * The resolved-Settings-module revisit (no fresh route fallback) is covered
 * unit-only in ChatRouteSession.test.tsx: a polling final-state count in E2E
 * cannot prove a transient fallback never flashed, and no in-test
 * fallback-appearance listener is wired here.
 *
 * Locale-independent selectors only (ids / data-testids); no text asserts.
 */
test.describe('Chat route session — Home always visible above the task dialog; same session survives close', () => {
  test('same Home session visible behind the settings dialog and restored with draft on close; settings revisit updates path', async ({
    mainWindow
  }) => {
    await waitForAppReady(mainWindow)
    await waitForChatReady(mainWindow)
    const sidebarPage = new SidebarPage(mainWindow)
    const chatPage = new ChatPage(mainWindow)
    const taskDialog = new TaskDialogPage(mainWindow)

    const chatInput = mainWindow.locator('.inputbar textarea, textarea[placeholder]').first()
    // The production Sidebar nav item the page object clicks to open Settings.
    const settingsOpener = mainWindow.locator('[data-testid="sidebar-nav-settings"]').first()
    // Settings shortcut registered by NavigationHandler (`meta+, ! ctrl+,`,
    // enabled by default, `enableOnFormTags: true`).
    const settingsShortcut = process.platform === 'darwin' ? 'Meta+,' : 'Control+,'

    /** Exactly who owns focus right now (never a bare "some element is focused"). */
    const readFocusOwner = () =>
      mainWindow.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        const dialog = document.querySelector('[role="dialog"]:has([data-testid="task-dialog"])') as HTMLElement | null
        return {
          tag: el?.tagName ?? 'NONE',
          testId: el?.getAttribute('data-testid') ?? null,
          isDocumentBody: el === document.body,
          inTaskDialog: Boolean(dialog && el && dialog.contains(el)),
          isChatInput: Boolean(el?.closest?.('.inputbar')),
          placeholder: el?.getAttribute('placeholder') ?? null
        }
      })

    /**
     * Wait until the open shell owns focus. rc-dialog moves focus into the panel
     * only when its enter motion ends; an Escape pressed before that still
     * targets the previous focus owner, so the wrapper's Escape handler never
     * runs and the shell stays open. Keyboard close therefore targets the
     * settled state.
     */
    const waitForDialogFocus = (timeout = 10000) =>
      expect
        .poll(async () => (await readFocusOwner()).inTaskDialog, {
          timeout,
          message: 'the open shell must own focus once its enter motion settles'
        })
        .toBe(true)

    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    await expect(mainWindow.locator('#app-sidebar')).toBeVisible({ timeout: 15000 })
    // No shell yet: the closed state is the native dialog being gone.
    await taskDialog.waitForClosed()

    // Capture the live Home DOM session before navigating away.
    const homeHandle = await mainWindow.locator('#home-page').elementHandle()
    expect(homeHandle).not.toBeNull()

    // Local Chat state owned by the component session (not Redux-persisted draft cache).
    const draft = 'e2e-route-session-draft'
    await chatPage.typeMessage(draft)
    expect(await chatPage.getInputValue()).toContain(draft)

    // Focus owner of the upcoming mouse gesture: the draft sits in the live
    // Chat input, which is what the user had focus on before touching the
    // Sidebar.
    await expect(chatInput).toBeFocused({ timeout: 10000 })
    // Opener facts captured BEFORE the gesture so the post-close expectation is
    // grounded in the DOM that actually opens the shell: the Sidebar settings
    // item is a non-focusable nav `div` (no `tabindex`), so a real mouse click
    // on it leaves focus on the document body — the gesture's pre-open owner.
    const openerFocusability = await settingsOpener.evaluate((el) => ({
      tag: el.tagName,
      tabIndex: el.tabIndex,
      hasTabIndexAttribute: el.hasAttribute('tabindex')
    }))
    expect(
      openerFocusability.tag,
      'premise: the Sidebar settings opener clicked by the page object is the nav element'
    ).toBe('DIV')
    expect(
      openerFocusability.hasTabIndexAttribute,
      'premise: the Sidebar settings opener takes no focus of its own (so the shell restores the document body)'
    ).toBe(false)

    // Chat -> Settings: route URL changes, the task shell owns the route
    // surface and the Home base stays mounted AND visible underneath it.
    await sidebarPage.goToSettings()
    await waitForSettingsLoad(mainWindow)
    expect(mainWindow.url()).toContain('/settings/provider')
    await expect(mainWindow.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 15000 })

    // Task-dialog shell contract: one style-only seam (no role of its own) that
    // sits INSIDE the single native accessible dialog owned by the antd panel,
    // plus the Home base still visible behind the shell. `expectOpen` owns the
    // display:contents visibility rule (the seam itself is never "visible").
    await taskDialog.expectOpen()
    // Shell accessibility + chrome contract: one native dialog with an
    // accessible name, and no visible header/title/close control of its own.
    await taskDialog.expectAccessibleShell()
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 10000 })
    expect(await mainWindow.locator('#home-page').count()).toBe(1)
    expect(await homeHandle!.evaluate((node) => node.isConnected)).toBe(true)

    // --- Close path 1: backdrop dismissal, mouse-opened shell ---
    await taskDialog.closeWithBackdrop()
    await waitForChatReady(mainWindow)
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    // Closed state is proven by the native dialog, not by the display:contents
    // seam (a contents box is never "visible", so it proves nothing either way).
    await taskDialog.waitForClosed()
    expect(await chatPage.getInputValue()).toContain(draft)
    const stillConnected = await homeHandle!.evaluate((node) => node.isConnected)
    expect(stillConnected, 'pre-dialog Home node must stay connected across the dialog close').toBe(true)

    // Focus after the mouse-opened close: the clicked Sidebar nav item cannot
    // take focus, so the document body is the gesture's pre-open owner and must
    // own focus again afterwards — neither the dialog trap nor the Chat input.
    const backdropCloseFocus = await readFocusOwner()
    test.info().annotations.push({
      type: 'route-session-backdrop-close-focus',
      description: `opener=${JSON.stringify(openerFocusability)} focus=${JSON.stringify(backdropCloseFocus)}`
    })
    expect(backdropCloseFocus.inTaskDialog, 'backdrop dismissal must release the dialog focus trap').toBe(false)
    // The pre-open owner for this gesture is the document body (see the opener
    // premise above); that exact owner — not "any element" and not the Chat
    // input — must own focus after close (no product requirement always
    // focuses the input after a mouse-opened shell closes).
    expect(
      backdropCloseFocus.isDocumentBody,
      `mouse-open backdrop dismissal must restore the recorded pre-open focus owner (document body, because the clicked Sidebar opener cannot take focus); got ${JSON.stringify(backdropCloseFocus)}`
    ).toBe(true)
    expect(
      backdropCloseFocus.isChatInput,
      'mouse-opened backdrop dismissal must not invent a Chat-input focus requirement'
    ).toBe(false)

    // --- Close path 2: keyboard invocation restores the invoking textarea ---
    // `Command/Ctrl + ,` fires while the Chat input owns focus, so that input is
    // the shell's recorded pre-open owner; Escape then closes the shell and
    // must both land '/' explicitly and put focus back into that same textarea.
    await waitForChatReady(mainWindow)
    await chatInput.click()
    await expect(chatInput).toBeFocused({ timeout: 10000 })
    await mainWindow.keyboard.press(settingsShortcut)
    await mainWindow.waitForURL(/.*#\/settings\/.*/, { timeout: 15000 })
    await waitForSettingsLoad(mainWindow)
    await taskDialog.expectOpen()
    await expect(mainWindow.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 15000 })
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    // Escape is the keyboard close path and only reaches the dialog through its
    // focus sentinel once the shell owns focus, so the settled state is what
    // the keyboard close below targets.
    await waitForDialogFocus()
    const keyboardOpenFocus = await readFocusOwner()
    test.info().annotations.push({
      type: 'route-session-keyboard-open-focus',
      description: `shortcut=${settingsShortcut} focus=${JSON.stringify(keyboardOpenFocus)}`
    })

    await taskDialog.closeWithEscape()
    // Escape is the keyboard close path: it navigates '/' explicitly
    // (never history-back out of the app) and must restore the invoking textarea.
    await expect(mainWindow).toHaveURL(TaskDialogPage.HOME_URL, { timeout: 15000 })
    await waitForChatReady(mainWindow)
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    expect(await chatPage.getInputValue()).toContain(draft)
    expect(await homeHandle!.evaluate((node) => node.isConnected)).toBe(true)
    const keyboardCloseFocus = await readFocusOwner()
    test.info().annotations.push({
      type: 'route-session-keyboard-close-focus',
      description: `focus=${JSON.stringify(keyboardCloseFocus)}`
    })
    // Soft on purpose: the close, URL, draft and session contracts above are
    // already proven, so a focus-restore miss is reported without suppressing
    // the deeplink Escape leg below. A soft assertion still fails this test.
    expect
      .soft(
        chatInput,
        `Escape close must restore the invoking textarea; observed focus owner ${JSON.stringify(keyboardCloseFocus)}`
      )
      .toBeFocused({ timeout: 15000 })

    // --- Settings revisit via the provider/model deeplink ---
    // Path contract preserved and the same Home session behind the shell; the
    // keyboard Escape close lands '/' again.
    await mainWindow.evaluate(() => {
      window.location.hash = '/settings/model'
    })
    await mainWindow.waitForURL(/.*#\/settings\/.*/, { timeout: 10000 })
    await waitForSettingsLoad(mainWindow)
    await taskDialog.expectOpen()
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    // Same settle precondition as above: Escape only closes once the open shell
    // owns focus, otherwise the keydown still belongs to the Home input.
    await waitForDialogFocus()
    await taskDialog.closeWithEscape()
    await expect(mainWindow).toHaveURL(TaskDialogPage.HOME_URL, { timeout: 15000 })
    await expect(mainWindow.locator('#home-page')).toBeVisible({ timeout: 15000 })
    expect(await chatPage.getInputValue()).toContain(draft)
    expect(await homeHandle!.evaluate((node) => node.isConnected)).toBe(true)

    await expect(mainWindow.locator('#app-sidebar')).toBeVisible({ timeout: 15000 })
  })
})
