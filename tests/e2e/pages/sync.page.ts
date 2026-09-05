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
  lastCaptureError: string | null
  pendingCount: number
  cursor: number
  syncing: boolean
  conflictCount: number
}

export interface SyncConfigShape {
  endpoint: string
  token?: string
  enabled: boolean
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

/**
 * Shared strict SyncStatus validator (fail-closed, no defaults).
 * Every required SyncStatus field must be present with the production type.
 * Missing/malformed fields throw instead of falling back to healthy
 * defaults. Actual values are preserved as-is. Credential-free: status
 * carries no token, and errors report only field/shape, never values.
 */
function toStrictSyncStatusShape(raw: unknown, source: string): SyncStatusShape {
  if (!raw || typeof raw !== 'object') throw new Error(`${source} returned non-object`)
  const s = raw as Record<string, unknown>
  if (typeof s.enabled !== 'boolean') throw new Error(`${source}: enabled must be boolean`)
  // Production SyncStatus.endpoint is a string ('' when unset).
  if (typeof s.endpoint !== 'string') throw new Error(`${source}: endpoint must be string`)
  if (!(typeof s.lastSyncAt === 'string' || s.lastSyncAt === null))
    throw new Error(`${source}: lastSyncAt must be string|null`)
  if (!(typeof s.lastError === 'string' || s.lastError === null))
    throw new Error(`${source}: lastError must be string|null`)
  if (!(typeof s.lastCaptureError === 'string' || s.lastCaptureError === null))
    throw new Error(`${source}: lastCaptureError must be string|null`)
  for (const field of ['pendingCount', 'cursor', 'conflictCount'] as const) {
    const v = s[field]
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || (v as number) < 0)
      throw new Error(`${source}: ${field} must be a non-negative integer`)
  }
  if (typeof s.syncing !== 'boolean') throw new Error(`${source}: syncing must be boolean`)
  return {
    enabled: s.enabled as boolean,
    endpoint: s.endpoint as string,
    lastSyncAt: s.lastSyncAt as string | null,
    lastError: s.lastError as string | null,
    lastCaptureError: s.lastCaptureError as string | null,
    pendingCount: s.pendingCount as number,
    cursor: s.cursor as number,
    syncing: s.syncing as boolean,
    conflictCount: s.conflictCount as number
  }
}

/**
 * Exact redacted sync-token assertion. Preserves strict equality while
 * reporting only presence/shape/mismatch — never credential values.
 */
export function assertSyncTokenExactRedacted(actual: unknown, expectedToken: string, context = 'sync token'): void {
  if (typeof actual !== 'string' || actual.length === 0) throw new Error(`${context} missing or empty`)
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) throw new Error(`${context} expectation missing`)
  if (actual !== expectedToken) throw new Error(`${context} mismatch`)
}

/** Typed getStatus via the production preload surface (fail-closed, no defaults). */
export async function getSyncStatusViaApi(page: Page): Promise<SyncStatusShape> {
  const status = await page.evaluate(async () => {
    return await (window as any).api.sync.getStatus()
  })
  return toStrictSyncStatusShape(status, 'getSyncStatusViaApi')
}

/** Typed getConfig via the production preload surface (persisted sync config). */
export async function getSyncConfigViaApi(page: Page): Promise<SyncConfigShape> {
  const config = await page.evaluate(async () => {
    return await (window as any).api.sync.getConfig()
  })
  if (!config || typeof config !== 'object') throw new Error('getSyncConfigViaApi returned non-object')
  return {
    endpoint: String((config as any).endpoint ?? ''),
    token: typeof (config as any).token === 'string' ? ((config as any).token as string) : undefined,
    enabled: Boolean((config as any).enabled)
  }
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
    const strictStatus = toStrictSyncStatusShape(outcome.status, 'runSyncViaApi')
    if (outcome.ok || !outcome.error?.includes('already in progress') || Date.now() >= deadline) {
      return { status: strictStatus, threw: outcome.ok ? null : (outcome.error as string) }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * Pair two profiles via the production pairing IPC (explicit user actions on
 * both sides): the approver mints an invite code, the requester submits a
 * pairing request with it, the approver accepts, and the requester confirms
 * trusted status (which also refreshes its durable trust mirror). Asserts
 * each step; throws fail-closed on any deviation. Credential values are never
 * logged.
 */
export async function pairProfilesViaApi(approverPage: Page, requesterPage: Page): Promise<void> {
  // Idempotent: a requester that is already trusted needs no new pairing.
  const pre = await requesterPage.evaluate(async () => {
    return await (window as any).api.sync.getPairingStatus()
  })
  if (pre && pre.trusted === true) return
  const invite = await approverPage.evaluate(async () => {
    return await (window as any).api.sync.createInvite()
  })
  if (!invite || typeof invite.code !== 'string') throw new Error('pairProfilesViaApi: invite code missing')
  const req = await requesterPage.evaluate(async (code: string) => {
    return await (window as any).api.sync.requestPairing({ code })
  }, invite.code)
  if (!req || typeof req.requestId !== 'string') throw new Error('pairProfilesViaApi: request id missing')
  const pending = await approverPage.evaluate(async () => {
    return await (window as any).api.sync.listPairingRequests()
  })
  const found = Array.isArray(pending?.requests) ? pending.requests.some((r: any) => r?.id === req.requestId) : false
  if (!found) throw new Error('pairProfilesViaApi: pending request not visible to approver')
  await approverPage.evaluate(async (requestId: string) => {
    return await (window as any).api.sync.acceptPairing(requestId)
  }, req.requestId)
  const status = await requesterPage.evaluate(async () => {
    return await (window as any).api.sync.getPairingStatus()
  })
  if (!status || status.trusted !== true) throw new Error('pairProfilesViaApi: requester not trusted after accept')
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

/** Typed deleteMessage via ChatDb IPC; asserts the success envelope. */
export async function deleteMessageViaApi(page: Page, topicId: string, messageId: string): Promise<void> {
  const result = await page.evaluate(
    async ({ topicId, messageId }: { topicId: string; messageId: string }) => {
      return await (window as any).api.chatDb.deleteMessage({ topicId, messageId })
    },
    { topicId, messageId }
  )
  if (!result || result.ok !== true) throw new Error(`deleteMessage failed: ${JSON.stringify((result as any)?.error)}`)
}

/** Typed updateMessage (content/edit patch) via ChatDb IPC; asserts the success envelope. */
export async function updateMessageViaApi(
  page: Page,
  topicId: string,
  messageId: string,
  updates: Record<string, unknown>
): Promise<void> {
  const result = await page.evaluate(
    async ({ topicId, messageId, updates }: { topicId: string; messageId: string; updates: any }) => {
      return await (window as any).api.chatDb.updateMessage({ topicId, messageId, updates })
    },
    { topicId, messageId, updates }
  )
  if (!result || result.ok !== true) throw new Error(`updateMessage failed: ${JSON.stringify((result as any)?.error)}`)
}

/** Typed softDeleteTopic via ChatDb IPC; asserts the success envelope. */
export async function softDeleteTopicViaApi(page: Page, topicId: string, name?: string | null): Promise<void> {
  const result = await page.evaluate(
    async ({ topicId, name }: { topicId: string; name?: string | null }) => {
      return await (window as any).api.chatDb.softDeleteTopic({ topicId, name: name ?? null })
    },
    { topicId, name }
  )
  if (!result || result.ok !== true)
    throw new Error(`softDeleteTopic failed: ${JSON.stringify((result as any)?.error)}`)
}

/** Typed restoreTopic via ChatDb IPC; asserts the envelope and returns the restored wire or null. */
export async function restoreTopicViaApi(page: Page, topicId: string): Promise<any | null> {
  const result = await page.evaluate(async (topicId: string) => {
    return await (window as any).api.chatDb.restoreTopic({ topicId })
  }, topicId)
  if (!result || result.ok !== true) throw new Error(`restoreTopic failed: ${JSON.stringify((result as any)?.error)}`)
  return (result as any).value ?? null
}

/** Typed hardDeleteTopic via ChatDb IPC; asserts the success envelope. */
export async function hardDeleteTopicViaApi(page: Page, topicId: string): Promise<void> {
  const result = await page.evaluate(async (topicId: string) => {
    return await (window as any).api.chatDb.hardDeleteTopic({ topicId })
  }, topicId)
  if (!result || result.ok !== true)
    throw new Error(`hardDeleteTopic failed: ${JSON.stringify((result as any)?.error)}`)
}

/** Typed listTrashTopics read; returns the trashed topic ids visible on the given profile. */
export async function listTrashTopicIdsViaApi(page: Page): Promise<string[]> {
  const result = await page.evaluate(async () => {
    return await (window as any).api.chatDb.listTrashTopics({})
  })
  if (!result || result.ok !== true)
    throw new Error(`listTrashTopics failed: ${JSON.stringify((result as any)?.error)}`)
  const items = (result as any).value?.items
  if (!Array.isArray(items)) throw new Error('listTrashTopics value.items is not an array')
  return items.map((t: any) => String(t?.id))
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
