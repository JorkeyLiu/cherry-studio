/**
 * Provider endpoint mode persistence — deterministic settings E2E.
 *
 * Covers the OpenAI-compatible endpoint mode selector (Chat Completions vs
 * Responses) through the real Add/Edit provider UI:
 *   - seed an OpenAI-compatible provider (store setup only)
 *   - real UI switch to Responses + save
 *   - authoritative Redux state stores type 'openai-response'
 *   - navigate away/back proves UI persistence (providers are Redux-backed,
 *     not SQLite — no chat.db assertion per repository architecture)
 *   - real UI switch back to Chat Completions preserves fields + type 'openai'
 *
 * LOCK-001: disposable profile. LOCK-002: mock endpoint only, no live APIs.
 */
import { expect, test } from '../../fixtures/electron.fixture'
import { waitForAppReady, waitForModal, waitForModalClose, waitForSettingsLoad } from '../../utils/wait-helpers'

const PROVIDER_ID = 'e2e-endpoint-mode'
const MODEL_ID = 'e2e-endpoint-model'
const PROVIDER_NAME = 'E2E Endpoint Provider'

async function seedEndpointProvider(page: import('@playwright/test').Page, apiHost: string): Promise<void> {
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

async function getProviderState(page: import('@playwright/test').Page): Promise<any> {
  return page.evaluate((providerId: string) => {
    const s = (window as any).store.getState()
    return s.llm.providers.find((p: any) => p.id === providerId) ?? null
  }, PROVIDER_ID)
}

/** Trailing-slash-insensitive host comparison (production normalizes on save). */
function normalizeHost(host: string): string {
  return (host ?? '').trim().replace(/\/+$/, '')
}

/** Open the Edit dialog for the seeded provider through the real provider list UI. */
async function openEditDialog(page: import('@playwright/test').Page): Promise<void> {
  const item = page.getByText(PROVIDER_NAME).first()
  await expect(item).toBeVisible({ timeout: 15000 })
  await item.click()
  await item.click({ button: 'right' })
  // Locale-independent: the provider context menu's first item is Edit
  // (Edit / 编辑 / 編輯 depending on locale — never match on text).
  const editMenu = page.locator('[role="menu"] [role="menuitem"]').first()
  await expect(editMenu).toBeVisible({ timeout: 10000 })
  await editMenu.click()
  await waitForModal(page)
  const modal = page.locator('.ant-modal').last()
  await expect(modal).toBeVisible({ timeout: 10000 })
  // The dialog exposes two Selects for the openai protocol (protocol first,
  // endpoint mode second) regardless of locale.
  await expect(modal.locator('.ant-select').nth(1)).toBeVisible({ timeout: 10000 })
}

/** Select an endpoint mode option inside the open Add/Edit modal and save. */
async function selectEndpointModeAndSave(page: import('@playwright/test').Page, optionText: string): Promise<void> {
  const modal = page.locator('.ant-modal').last()
  await expect(modal).toBeVisible({ timeout: 10000 })
  // Two Selects exist for the openai protocol: protocol first, endpoint mode second.
  const endpointSelect = modal.locator('.ant-select').nth(1)
  await expect(endpointSelect).toBeVisible({ timeout: 10000 })
  await endpointSelect.click()
  // Option labels ("Chat Completions" / "Responses") are identical in every
  // locale — only the field label is translated.
  const option = page.locator(`.ant-select-item-option:has-text("${optionText}")`).first()
  await expect(option).toBeVisible({ timeout: 10000 })
  await option.click()
  const okButton = modal.locator('.ant-modal-footer .ant-btn-primary').first()
  await expect(okButton).toBeEnabled({ timeout: 10000 })
  await okButton.click()
  await waitForModalClose(page)
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
      await page.evaluate(() => window.navigate('/settings/provider'))
      await waitForSettingsLoad(page)
    })

    await test.step('real UI switch to Responses and save', async () => {
      await openEditDialog(page)
      await selectEndpointModeAndSave(page, 'Responses')
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
      await page.waitForURL('**/#/settings/general**', { timeout: 10000 }).catch(() => {})
      await page.evaluate(() => window.navigate('/settings/provider'))
      await waitForSettingsLoad(page)
      const afterNav = await getProviderState(page)
      expect(afterNav.type).toBe('openai-response')
      // Reopen the edit dialog to prove the UI reflects the persisted mode.
      await openEditDialog(page)
      const modal = page.locator('.ant-modal').last()
      await expect(modal.locator('.ant-select').nth(1)).toContainText('Responses', { timeout: 10000 })
      const cancelButton = modal.locator('.ant-modal-footer .ant-btn-default').first()
      await cancelButton.click()
      await waitForModalClose(page)
    })

    await test.step('real UI switch back to Chat Completions preserves fields', async () => {
      await openEditDialog(page)
      await selectEndpointModeAndSave(page, 'Chat Completions')
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
    })
  })
})
