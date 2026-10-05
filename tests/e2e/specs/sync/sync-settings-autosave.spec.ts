/**
 * Sync Settings autosave E2E: rendered UI autosave contract through real
 * preload/Main IPC (renderer -> IPC -> Main persistence round trip with
 * full-config non-overwrite).
 *
 * - Data Settings > Synchronization via the shared SyncSettingsPage object.
 * - Waits for configuration hydration (controls enabled by getConfig).
 * - Asserts no visible Save or Refresh configuration controls remain
 *   (Sync Now stays the sole manual sync action).
 * - Endpoint edit + blur persists the normalized endpoint without an
 *   explicit save click; Enabled toggle persists immediately without
 *   overwriting the endpoint. There is no shared service token anywhere:
 *   the persisted config carries endpoint/enabled only.
 * - Navigate-away/back re-renders the persisted values (no app relaunch).
 *
 * Determinism: loopback endpoints on closed ports, never Connect, never
 * sync(), no external network. The profile is never attached (no service
 * credentials), so Main auto-refresh stays inert; the Enabled toggle runs
 * true -> false (disable invalidates, never dials). Seed config is
 * established via production IPC before rendered interaction.
 */
import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/electron.fixture'
import { getSyncConfigViaApi, setSyncConfigViaApi, SyncSettingsPage, type SyncConfigShape } from '../../pages/sync.page'
import { SettingsPage } from '../../pages/settings.page'
import { waitForAppReady } from '../../utils/wait-helpers'

const SEED_ENDPOINT = 'http://127.0.0.1:13873'
const EDITED_ENDPOINT = 'http://127.0.0.1:13874'

async function pollSyncConfig(
  page: Page,
  matches: (cfg: SyncConfigShape) => boolean,
  timeoutMs = 15000
): Promise<SyncConfigShape> {
  const deadline = Date.now() + timeoutMs
  let last: SyncConfigShape | null = null
  for (;;) {
    last = await getSyncConfigViaApi(page)
    if (matches(last)) return last
    if (Date.now() >= deadline) {
      throw new Error('sync config poll timeout (endpoint/enabled shape only, no credentials)')
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

test.describe('Sync settings autosave', () => {
  let syncPage: SyncSettingsPage
  let settingsPage: SettingsPage

  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
    syncPage = new SyncSettingsPage(mainWindow)
    settingsPage = new SettingsPage(mainWindow)
  })

  test('blur and toggle persist the full config without an explicit save', async ({ mainWindow }) => {
    test.setTimeout(120000)
    // Safe initial config via production IPC before rendered interaction:
    // enabled true so the UI toggle below runs true -> false (disable path,
    // never dials). Closed loopback ports; never Connect, never sync().
    await setSyncConfigViaApi(mainWindow, { endpoint: SEED_ENDPOINT, enabled: true })
    const seeded = await getSyncConfigViaApi(mainWindow)
    expect(seeded.endpoint).toBe(SEED_ENDPOINT)
    expect(seeded.enabled).toBe(true)
    expect('token' in seeded).toBe(false)

    // Navigate to Data Settings > Synchronization using page patterns.
    await syncPage.openSync()
    await syncPage.waitForHydrated()

    // Hydrated form renders the seeded config; no token field exists.
    await expect(syncPage.endpointInput).toHaveValue(SEED_ENDPOINT)
    await expect(mainWindow.getByTestId('sync-token-input')).toHaveCount(0)

    // No explicit Save or Refresh configuration controls remain; Sync Now
    // stays the sole manual sync action.
    await expect(syncPage.saveButton).toHaveCount(0)
    await expect(syncPage.refreshButton).toHaveCount(0)
    await expect(mainWindow.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
    await expect(mainWindow.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0)
    await expect(syncPage.syncNowButton).toBeVisible()

    // Edit relay endpoint (padded to prove trim normalization) and blur;
    // the normalized endpoint persists without an explicit save click.
    await syncPage.fillEndpointAndBlur(`  ${EDITED_ENDPOINT}  `)
    const afterEndpoint = await pollSyncConfig(mainWindow, (cfg) => cfg.endpoint === EDITED_ENDPOINT)
    expect(afterEndpoint.endpoint).toBe(EDITED_ENDPOINT)
    expect(afterEndpoint.enabled).toBe(true)
    expect('token' in afterEndpoint).toBe(false)

    // Toggle Enabled true -> false; it persists immediately while the
    // endpoint remains intact.
    await syncPage.enabledSwitch.click()
    const afterToggle = await pollSyncConfig(
      mainWindow,
      (cfg) => cfg.endpoint === EDITED_ENDPOINT && cfg.enabled === false
    )
    expect(afterToggle.endpoint).toBe(EDITED_ENDPOINT)
    expect(afterToggle.enabled).toBe(false)
    expect('token' in afterToggle).toBe(false)

    // Navigate away/back and verify the persisted values are rendered.
    await settingsPage.goToGeneral()
    await syncPage.openSync()
    await syncPage.waitForHydrated()
    await expect(syncPage.endpointInput).toHaveValue(EDITED_ENDPOINT)
    await expect(mainWindow.getByTestId('sync-token-input')).toHaveCount(0)
    await expect(syncPage.enabledSwitch).toHaveAttribute('aria-checked', 'false')
    const reread = await getSyncConfigViaApi(mainWindow)
    expect(reread.endpoint).toBe(EDITED_ENDPOINT)
    expect(reread.enabled).toBe(false)
    expect('token' in reread).toBe(false)
  })
})
