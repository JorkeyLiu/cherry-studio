/**
 * Provider endpoint mode persistence — deterministic settings E2E.
 *
 * Covers the OpenAI-compatible endpoint mode selector (Chat Completions vs
 * Responses) through the real provider settings UI:
 *   - seed an OpenAI-compatible provider (store setup only)
 *   - real UI retarget to that connection through the top connection switcher
 *   - one unified connection pane: API key + host, then the grouped model list
 *     (no Models/Config tabs)
 *   - the connection switcher's dropdown closes on a neutral blank point of its
 *     own top header, leaving the settings surface open
 *   - real UI switch to Responses + save (connection menu → connection edit popup)
 *   - authoritative Redux state stores type 'openai-response'
 *   - navigate away/back proves UI persistence (providers are Redux-backed,
 *     not SQLite — no chat.db assertion per repository architecture)
 *   - real UI switch back to Chat Completions preserves fields + type 'openai'
 *
 * Surfaces this spec relies on (stable attributes the app renders):
 *   - provider settings render inside the headerless `task-dialog` shell above
 *     the always-mounted Home base. That shell's own native dialog stays open
 *     for the whole interaction, so nothing here uses a page-wide modal
 *     visibility wait; the shell is resolved by its `task-dialog` seam and
 *     child popups by excluding the dialog that contains that seam.
 *   - `provider-settings` (page), `provider-content` (single connection pane),
 *     `provider-config-body` (credential section above the model list).
 *   - `provider-switcher-header` / `provider-switcher` / `provider-switcher-popover`
 *     plus `connection-option-<providerId>`: the top connection switcher (there
 *     is no permanent connection rail) whose dropdown is the switcher's own
 *     header band.
 *   - `provider-connection-menu`: compact connection menu, whose Edit entry
 *     (source key `edit`, formerly `rename`) opens the popup that carries the
 *     protocol and endpoint mode selects. Ant Menu `data-menu-id` keeps the
 *     entry locale-independent.
 *
 * Disposable profile only; the mock endpoint is the only provider traffic.
 */
import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../../fixtures/electron.fixture'
import { TaskDialogPage } from '../../pages/task-dialog.page'
import { waitForAppReady } from '../../utils/wait-helpers'

const PROVIDER_ID = 'e2e-endpoint-mode'
const MODEL_ID = 'e2e-endpoint-model'
const MODEL_NAME = 'E2E Endpoint Model'
const PROVIDER_NAME = 'E2E Endpoint Provider'

/** Provider settings content (inside the task-dialog shell, not the shell itself). */
const providerSettings = (page: Page): Locator => page.getByTestId('provider-settings')

/** Credential section of the unified connection pane (API key + host). */
const credentials = (page: Page): Locator => page.getByTestId('provider-config-body')

/**
 * A child popup of the settings shell: every native dialog EXCEPT the one that
 * contains the shell seam. The shell has no header and no close control, so a
 * page-wide `.ant-modal` position would resolve the shell instead of the popup.
 */
const childPopup = (page: Page): Locator => page.locator('[role="dialog"]:not(:has([data-testid="task-dialog"]))')

/** The edit popup's endpoint mode Select: the protocol Select comes first. */
const endpointModeSelect = (popup: Locator): Locator => popup.locator('.ant-select').nth(1)

async function seedEndpointProvider(page: Page, apiHost: string): Promise<void> {
  await page.evaluate(
    ({ providerId, modelId, name, apiHost }) => {
      const store = (window as any).store
      const existing = store.getState().llm.providers.find((p: any) => p.id === providerId)
      const models = [
        { id: modelId, provider: providerId, name: 'E2E Endpoint Model', group: 'e2e', description: 'E2E model' }
      ]
      if (existing) {
        store.dispatch({
          type: 'llm/updateProvider',
          payload: { id: providerId, type: 'openai', name, apiKey: 'test-key', apiHost, models, enabled: true }
        })
      } else {
        store.dispatch({
          type: 'llm/addProvider',
          payload: {
            id: providerId,
            type: 'openai',
            name,
            apiKey: 'test-key',
            apiHost,
            models,
            enabled: true,
            isSystem: false
          }
        })
      }
    },
    { providerId: PROVIDER_ID, modelId: MODEL_ID, name: PROVIDER_NAME, apiHost }
  )
  await page.waitForFunction(
    ({ providerId }) => {
      const s = (window as any).store?.getState()
      return s?.llm?.providers?.some((p: any) => p.id === providerId)
    },
    { providerId: PROVIDER_ID },
    { timeout: 10000 }
  )
}

async function getProviderState(page: Page): Promise<any> {
  return page.evaluate((providerId: string) => {
    const s = (window as any).store.getState()
    return s.llm.providers.find((p: any) => p.id === providerId) ?? null
  }, PROVIDER_ID)
}

/** Trailing-slash-insensitive host comparison (production normalizes on save). */
function normalizeHost(host: string): string {
  return (host ?? '').trim().replace(/\/+$/, '')
}

/** Exact-value pattern for a stored host, tolerant of the optional trailing slash. */
function hostValuePattern(host: string): RegExp {
  const escaped = normalizeHost(host).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}/?$`)
}

/**
 * Open the provider settings route and wait for the provider content inside the
 * task-dialog shell. The shell renders no header and no close control, so its
 * open state is asserted through the shell seam (`TaskDialogPage`), never
 * through a page-wide modal selector.
 */
async function openProviderSettings(page: Page): Promise<void> {
  await page.evaluate(() => window.navigate('/settings/provider'))
  const taskDialog = new TaskDialogPage(page)
  await taskDialog.waitForOpen()
  await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: 15000 })
  await expect(providerSettings(page)).toBeVisible({ timeout: 15000 })
}

/**
 * Unified connection pane contract: one pane holds the API key + host section
 * and then the retained grouped model list. There are no Models/Config tabs, so
 * both parts are asserted as visible at the same time.
 */
async function expectUnifiedConnectionPane(page: Page, expectedHost: string): Promise<void> {
  await expect(page.getByTestId('provider-content')).toBeVisible({ timeout: 15000 })

  const credentialPane = credentials(page)
  await expect(credentialPane).toBeVisible({ timeout: 15000 })
  // The API key stays a password field holding the stored key; the host field
  // is the pane's plain text field holding the stored endpoint.
  await expect(credentialPane.locator('input[type="password"]').first()).toHaveValue('test-key', { timeout: 10000 })
  await expect(credentialPane.locator('input:not([type="password"])').first()).toHaveValue(
    hostValuePattern(expectedHost),
    {
      timeout: 10000
    }
  )

  // The grouped model list is retained in the same pane (no tab to switch to).
  await expect(page.getByText(new RegExp(MODEL_NAME)).first()).toBeVisible({ timeout: 10000 })
}

/** Open the connection switcher dropdown (search list + fixed bottom Add). */
async function openSwitcher(page: Page): Promise<Locator> {
  const switcher = page.getByTestId('provider-switcher')
  await expect(switcher).toBeVisible({ timeout: 15000 })
  if ((await switcher.getAttribute('aria-expanded')) !== 'true') {
    await switcher.click()
  }
  const popover = page.getByTestId('provider-switcher-popover')
  await expect(popover).toBeVisible({ timeout: 10000 })
  await expect(switcher).toHaveAttribute('aria-expanded', 'true', { timeout: 10000 })
  return popover
}

/**
 * Click a neutral blank point of the switcher's own top header — inside the
 * header band, outside the trigger and outside the open dropdown — and assert
 * the dropdown closes while the settings surface (parent) survives.
 *
 * The point is measured at run time from real bounding boxes and hit-tested,
 * never hard-coded: it must sit on the trigger's vertical center line, to the
 * right of the trigger, and its hit target must stay inside the header while
 * touching neither the trigger, the dropdown, nor any control.
 */
async function dismissSwitcherByBlankHeaderClick(page: Page): Promise<void> {
  const header = page.getByTestId('provider-switcher-header')
  await expect(header).toBeVisible({ timeout: 15000 })
  const point = await header.evaluate((headerEl) => {
    const triggerEl = headerEl.querySelector('[data-testid="provider-switcher"]')
    if (!triggerEl) return null
    const headerRect = headerEl.getBoundingClientRect()
    const triggerRect = triggerEl.getBoundingClientRect()
    if (headerRect.width <= 0 || triggerRect.width <= 0) return null
    const y = triggerRect.top + triggerRect.height / 2
    for (let x = triggerRect.right + 8; x <= headerRect.right - 8; x += 4) {
      const hit = document.elementFromPoint(x, y)
      if (!hit || !headerEl.contains(hit)) continue
      if (hit.closest('[data-testid="provider-switcher"]')) continue
      if (hit.closest('[data-testid="provider-switcher-popover"]')) continue
      if (hit.closest('button, a, input, [role="menu"], [role="listbox"], [role="option"]')) continue
      return { x: x - headerRect.left, y: y - headerRect.top }
    }
    return null
  })
  expect(point, 'switcher header exposes no neutral blank point to click').not.toBeNull()

  await header.click({ position: point! })
  await expect(page.getByTestId('provider-switcher-popover')).toHaveCount(0, { timeout: 10000 })
  await expect(page.getByTestId('provider-switcher')).toHaveAttribute('aria-expanded', 'false', { timeout: 10000 })
  // The settings surface itself must survive the dropdown dismissal.
  await expect(providerSettings(page)).toBeVisible({ timeout: 10000 })
  await expect(new TaskDialogPage(page).nativeDialog).toBeVisible({ timeout: 10000 })
}

/**
 * Retarget the content area to the seeded connection through the real switcher
 * (there is no permanent connection rail): choose the connection by its stable
 * option id and prove the single resolved selection landed on the trigger.
 */
async function selectConnection(page: Page): Promise<void> {
  await openSwitcher(page)
  const option = page.getByTestId(`connection-option-${PROVIDER_ID}`)
  await expect(option).toBeVisible({ timeout: 10000 })
  await option.click()
  await expect(page.getByTestId('provider-switcher-popover')).toHaveCount(0, { timeout: 10000 })
  await expect(page.getByTestId('provider-switcher')).toContainText(PROVIDER_NAME)
}

/**
 * Open the connection edit popup through the compact connection menu.
 *
 * The menu is Edit / API settings / separator / Delete; Edit opens the popup
 * carrying the protocol and endpoint mode selects. Ant Menu synthesizes
 * `data-menu-id` from the source key, which is `edit` (formerly `rename` for
 * the same action), so the entry is matched structurally rather than by its
 * translated label — and the rail-era actions (notes / agent filter) must no
 * longer be exposed.
 *
 * The returned locator is the child popup only (the shell's own dialog stays
 * open underneath), so every follow-up locator is scoped to it.
 */
async function openConnectionEditPopup(page: Page): Promise<Locator> {
  const menuButton = page.getByTestId('provider-connection-menu')
  await expect(menuButton).toBeVisible({ timeout: 15000 })
  await menuButton.click()

  const editItem = page
    .locator('.ant-dropdown-menu-item[data-menu-id$="-edit"], .ant-dropdown-menu-item[data-menu-id$="-rename"]')
    .first()
  await expect(editItem).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.ant-dropdown-menu-item[data-menu-id$="-notes"]')).toHaveCount(0)
  await expect(page.locator('.ant-dropdown-menu-item[data-menu-id$="-filter-all"]')).toHaveCount(0)
  await expect(page.locator('.ant-dropdown-menu-item[data-menu-id$="-filter-agent"]')).toHaveCount(0)
  await editItem.click()

  const popup = childPopup(page)
  await expect(popup).toHaveCount(1, { timeout: 10000 })
  await expect(popup).toBeVisible({ timeout: 10000 })
  await expect(endpointModeSelect(popup)).toBeVisible({ timeout: 10000 })
  return popup
}

/**
 * Select an endpoint mode option inside the edit popup and save.
 *
 * Option labels ("Chat Completions" / "Responses") are identical in every
 * locale — only the field label is translated. The option list portals outside
 * the popup, so it is scoped to the one visible Select dropdown instead.
 */
async function selectEndpointModeAndSave(page: Page, popup: Locator, optionText: string): Promise<void> {
  await endpointModeSelect(popup).click()
  const option = page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ hasText: optionText })
    .first()
  await expect(option).toBeVisible({ timeout: 10000 })
  await option.click()

  const okButton = popup.locator('.ant-modal-footer .ant-btn-primary').first()
  await expect(okButton).toBeEnabled({ timeout: 10000 })
  await okButton.click()
  // The settings shell stays open; only the child popup is dismissed.
  await expect(childPopup(page)).toHaveCount(0, { timeout: 10000 })
}

/** Read the endpoint mode currently displayed by the edit popup's Select. */
async function expectEndpointMode(popup: Locator, expected: string): Promise<void> {
  await expect(endpointModeSelect(popup).locator('.ant-select-selection-item')).toHaveText(expected, {
    timeout: 10000
  })
}

/** Dismiss the edit popup through its Cancel action (no provider edit is resolved). */
async function cancelConnectionEditPopup(page: Page, popup: Locator): Promise<void> {
  const cancelButton = popup.locator('.ant-modal-footer .ant-btn-default').first()
  await expect(cancelButton).toBeEnabled({ timeout: 10000 })
  await cancelButton.click()
  await expect(childPopup(page)).toHaveCount(0, { timeout: 10000 })
  await expect(providerSettings(page)).toBeVisible({ timeout: 10000 })
}

test.describe('Provider endpoint mode persistence', () => {
  test.setTimeout(180000)

  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
  })

  test('real UI switch Responses/save persists type openai-response, switch back preserves fields', async ({
    mainWindow,
    mockPort
  }) => {
    const page = mainWindow
    const apiHost = `http://127.0.0.1:${mockPort}/v1/`

    await test.step('seed OpenAI-compatible provider', async () => {
      await seedEndpointProvider(page, apiHost)
      const initial = await getProviderState(page)
      expect(initial).not.toBeNull()
      expect(initial.type).toBe('openai')
      expect(initial.name).toBe(PROVIDER_NAME)
      expect(initial.apiHost).toBe(apiHost)
      expect(initial.apiKey).toBe('test-key')
    })

    await test.step('open provider settings', async () => {
      await openProviderSettings(page)
    })

    await test.step('switch to the seeded connection and read the unified pane', async () => {
      await selectConnection(page)
      await expectUnifiedConnectionPane(page, apiHost)
    })

    await test.step('switcher dropdown closes on a blank header click, settings survive', async () => {
      await openSwitcher(page)
      await dismissSwitcherByBlankHeaderClick(page)
    })

    await test.step('real UI switch to Responses and save', async () => {
      const popup = await openConnectionEditPopup(page)
      await selectEndpointModeAndSave(page, popup, 'Responses')
    })

    await test.step('authoritative state stores openai-response with fields intact', async () => {
      await page.waitForFunction(
        ({ providerId }) => {
          const s = (window as any).store?.getState()
          return s?.llm?.providers?.find((p: any) => p.id === providerId)?.type === 'openai-response'
        },
        { providerId: PROVIDER_ID },
        { timeout: 10000 }
      )
      const saved = await getProviderState(page)
      expect(saved.type).toBe('openai-response')
      expect(saved.name).toBe(PROVIDER_NAME)
      expect(normalizeHost(saved.apiHost)).toBe(normalizeHost(apiHost))
      expect(saved.apiKey).toBe('test-key')
      expect(saved.models.some((m: any) => m.id === MODEL_ID)).toBe(true)
    })

    await test.step('navigate away/back preserves Responses mode', async () => {
      await page.evaluate(() => window.navigate('/settings/general'))
      await expect(page).toHaveURL(/.*#\/settings\/general.*/, { timeout: 10000 })
      await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: 15000 })

      await openProviderSettings(page)
      const afterNav = await getProviderState(page)
      expect(afterNav.type).toBe('openai-response')

      // Reopen the edit popup to prove the UI reflects the persisted mode.
      await selectConnection(page)
      const popup = await openConnectionEditPopup(page)
      await expectEndpointMode(popup, 'Responses')
      await cancelConnectionEditPopup(page, popup)
    })

    await test.step('real UI switch back to Chat Completions preserves fields', async () => {
      const popup = await openConnectionEditPopup(page)
      await selectEndpointModeAndSave(page, popup, 'Chat Completions')
      await page.waitForFunction(
        ({ providerId }) => {
          const s = (window as any).store?.getState()
          return s?.llm?.providers?.find((p: any) => p.id === providerId)?.type === 'openai'
        },
        { providerId: PROVIDER_ID },
        { timeout: 10000 }
      )
      const restored = await getProviderState(page)
      expect(restored.type).toBe('openai')
      expect(restored.name).toBe(PROVIDER_NAME)
      expect(normalizeHost(restored.apiHost)).toBe(normalizeHost(apiHost))
      expect(restored.apiKey).toBe('test-key')
      expect(restored.models.some((m: any) => m.id === MODEL_ID)).toBe(true)
      // The unified pane still shows the preserved key + host and model list.
      await expectUnifiedConnectionPane(page, apiHost)
    })
  })
})
