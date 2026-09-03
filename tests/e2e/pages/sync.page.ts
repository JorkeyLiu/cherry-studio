/**
 * Focused Sync Settings page/helper for E2E.
 *
 * Stable data-testid selectors (see SyncSettings.tsx) plus typed
 * window.api.sync / window.api.chatDb access. Sync status is asserted via
 * typed window.api.sync.getStatus(); convergence is asserted via actual
 * second-profile ChatDb data (topicExists/fetchMessages). Screenshots are
 * never regression proof.
 */
import type { Locator, Page } from '@playwright/test'

import { BasePage } from './base.page'

export interface SyncConfigInput {
  endpoint: string
  token: string
  enabled: boolean
}

export interface SyncStatusShape {
  enabled: boolean
  endpoint: string
  lastSyncAt: string | null
  lastError: string | null
  pendingCount: number
  cursor: number
  syncing: boolean
}

export class SyncSettingsPage extends BasePage {
  readonly syncMenuItem: Locator
  readonly endpointInput: Locator
  readonly tokenInput: Locator
  readonly enabledSwitch: Locator
  readonly saveButton: Locator
  readonly syncNowButton: Locator
  readonly statusContainer: Locator
  readonly pendingCount: Locator
  readonly cursor: Locator
  readonly lastError: Locator

  constructor(page: Page) {
    super(page)
    this.syncMenuItem = page.getByTestId('data-menu-sync')
    this.endpointInput = page.getByTestId('sync-endpoint-input')
    this.tokenInput = page.getByTestId('sync-token-input')
    this.enabledSwitch = page.getByTestId('sync-enabled-switch')
    this.saveButton = page.getByTestId('sync-save-button')
    this.syncNowButton = page.getByTestId('sync-now-button')
    this.statusContainer = page.getByTestId('sync-status')
    this.pendingCount = page.getByTestId('sync-pending-count')
    this.cursor = page.getByTestId('sync-cursor')
    this.lastError = page.getByTestId('sync-last-error')
  }

  /** Navigate to Data settings where SyncSettings is rendered. */
  async gotoData(): Promise<void> {
    await this.navigateTo('/settings/data')
    await this.page.waitForURL('**/#/settings/data**', { timeout: 10000 }).catch(() => {})
  }

  /** Open the Sync submenu (DataSettings renders SyncSettings only for menu === 'sync'). */
  async openSync(): Promise<void> {
    await this.gotoData()
    await this.syncMenuItem.click({ timeout: 15000 })
    await this.waitForSyncForm()
  }

  /** Wait for the Sync Settings form to be attached. */
  async waitForSyncForm(timeout = 30000): Promise<void> {
    await this.endpointInput.first().waitFor({ state: 'attached', timeout })
  }
}

/** Typed setConfig via the production preload surface. */
export async function setSyncConfigViaApi(page: Page, config: SyncConfigInput): Promise<void> {
  const result = await page.evaluate(async (cfg: SyncConfigInput) => {
    const api = (window as any).api
    if (!api?.sync?.setConfig) return { ok: false, error: 'window.api.sync.setConfig not found' }
    try {
      await api.sync.setConfig(cfg)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  }, config)
  if (!result.ok) throw new Error(`setSyncConfigViaApi failed: ${(result as any).error}`)
}

/** Typed getStatus via the production preload surface. */
export async function getSyncStatusViaApi(page: Page): Promise<SyncStatusShape> {
  const status = await page.evaluate(async () => {
    return await (window as any).api.sync.getStatus()
  })
  if (!status || typeof status !== 'object') throw new Error('getSyncStatusViaApi returned non-object')
  return status as SyncStatusShape
}

/**
 * Typed manual sync via the production preload surface.
 * Returns the status on success; on failure records the thrown message and
 * returns the durable status via getStatus (lastError persisted).
 * Transient `already in progress` collisions with background automation are
 * retried (bounded) so manual-sync assertions observe the manual outcome,
 * not a busy race. All other failures return immediately.
 */
export async function runSyncViaApi(
  page: Page,
  retryBusyMs = 15000
): Promise<{ status: SyncStatusShape; threw: string | null }> {
  const deadline = Date.now() + retryBusyMs
  for (;;) {
    const outcome = await page.evaluate(async () => {
      const api = (window as any).api
      try {
        const status = await api.sync.sync()
        return { ok: true as const, status, error: null }
      } catch (err: any) {
        let status: any = null
        try {
          status = await api.sync.getStatus()
        } catch {}
        return { ok: false as const, status, error: String(err?.message ?? err) }
      }
    })
    if (!outcome.status || typeof outcome.status !== 'object') {
      throw new Error(`runSyncViaApi has no durable status: ${outcome.error ?? 'unknown'}`)
    }
    if (outcome.ok || !outcome.error?.includes('already in progress') || Date.now() >= deadline) {
      return { status: outcome.status as SyncStatusShape, threw: outcome.ok ? null : (outcome.error as string) }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** Typed ensureTopic via ChatDb IPC; asserts the success envelope. */
export async function ensureTopicViaApi(page: Page, topicId: string, name?: string): Promise<void> {
  const result = await page.evaluate(
    async ({ topicId, name }: { topicId: string; name?: string }) => {
      return await (window as any).api.chatDb.ensureTopic({ topicId, name: name ?? null })
    },
    { topicId, name }
  )
  if (!result || result.ok !== true) throw new Error(`ensureTopic failed: ${JSON.stringify((result as any)?.error)}`)
}

/** Typed appendMessage via ChatDb IPC; asserts the success envelope. */
export async function appendMessageViaApi(
  page: Page,
  topicId: string,
  message: Record<string, unknown>,
  blocks: Record<string, unknown>[]
): Promise<void> {
  const result = await page.evaluate(
    async ({ topicId, message, blocks }: { topicId: string; message: any; blocks: any[] }) => {
      return await (window as any).api.chatDb.appendMessage({ topicId, message, blocks })
    },
    { topicId, message, blocks }
  )
  if (!result || result.ok !== true) throw new Error(`appendMessage failed: ${JSON.stringify((result as any)?.error)}`)
}

/** Typed topicExists read on the given profile. */
export async function topicExistsViaApi(page: Page, topicId: string): Promise<boolean> {
  const result = await page.evaluate(async (topicId: string) => {
    return await (window as any).api.chatDb.topicExists({ topicId })
  }, topicId)
  if (!result || result.ok !== true) throw new Error(`topicExists failed: ${JSON.stringify((result as any)?.error)}`)
  if (typeof result.value !== 'boolean') throw new Error('topicExists value is not boolean')
  return result.value as boolean
}

/** Typed fetchMessages read on the given profile. */
export async function fetchMessagesViaApi(page: Page, topicId: string): Promise<{ messages: any[]; blocks: any[] }> {
  const result = await page.evaluate(async (topicId: string) => {
    return await (window as any).api.chatDb.fetchMessages({ topicId })
  }, topicId)
  if (!result || result.ok !== true) throw new Error(`fetchMessages failed: ${JSON.stringify((result as any)?.error)}`)
  const value = (result as any).value
  if (!Array.isArray(value?.messages) || !Array.isArray(value?.blocks)) {
    throw new Error('fetchMessages value shape invalid')
  }
  return { messages: value.messages, blocks: value.blocks }
}

export function isoNow(): string {
  return new Date().toISOString()
}
