/**
 * User-entrypoint persistent relay E2E: two real profiles through
 * `pnpm sync:relay` (`scripts/sync-relay/server.ts`) with the stable
 * `--port/--db/--token` CLI contract.
 *
 * The relay starts through the user-facing entrypoint file (same file the
 * package script runs; Electron-as-Node launcher only for the ABI 145 lane),
 * not through the in-memory test-only relay. Pairing/trust uses the
 * production flow, convergence uses production IPC ChatDb state, restart
 * reuses the same DB/token/port, and cleanup deletes only the disposable
 * owned root. Loopback only; no remote/LAN/TLS, backup, capacity, or
 * power-loss claim.
 */
import type { Page } from '@playwright/test'
import * as fs from 'node:fs'

import { expect, test } from '../../fixtures/electron.fixture'
import {
  appendMessageViaApi,
  ensureTopicViaApi,
  fetchMessagesViaApi,
  getSyncStatusViaApi,
  isoNow,
  pairProfilesViaApi,
  runSyncViaApi,
  setSyncConfigViaApi,
  topicExistsViaApi,
  updateMessageViaApi
} from '../../pages/sync.page'
import {
  closeSecondSyncProfile,
  launchSecondSyncProfile,
  type SecondSyncProfile
} from '../../utils/sync-second-profile'
import { assertNoUnresolvedRelayCleanup } from '../../utils/sync-relay-process'
import { validateOwnedRoot } from '../../utils/run-ownership'
import {
  getUserRelayHandle,
  startUserEntrypointRelay,
  type UserEntrypointRelayHandle
} from '../../utils/sync-relay-user-entrypoint'

const RELAY_TOKEN = 'e2e-user-entrypoint-token-1'

function messageJson(id: string, topicId: string, content: string): Record<string, unknown> {
  const now = isoNow()
  return { id, topicId, role: 'user', content, status: 'success', createdAt: now, updatedAt: now }
}

function blockJson(id: string, messageId: string, content: string): Record<string, unknown> {
  const now = isoNow()
  return { id, messageId, type: 'text', content, status: 'success', createdAt: now, updatedAt: now }
}

async function pollForConvergence(
  page: Page,
  topicId: string,
  messageId: string,
  blockId: string,
  expected: string
): Promise<void> {
  const deadline = Date.now() + 30000
  let last: string | null = null
  while (Date.now() < deadline) {
    try {
      if (await topicExistsViaApi(page, topicId)) {
        const { messages, blocks } = await fetchMessagesViaApi(page, topicId)
        const msg = messages.find((m: any) => m?.id === messageId) as any
        const blk = blocks.find((b: any) => b?.id === blockId) as any
        if (msg?.content === expected && blk?.content === expected && blk?.messageId === messageId) return
        last = `messages=${messages.length} blocks=${blocks.length}`
      } else {
        last = 'topic missing'
      }
    } catch (e) {
      last = String((e as Error).message)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`convergence timeout ${topicId}/${messageId}: ${last}`)
}

async function pollForMessageContent(
  page: Page,
  topicId: string,
  messageId: string,
  expected: string,
  ms = 90000
): Promise<void> {
  const deadline = Date.now() + ms
  let last = ''
  while (Date.now() < deadline) {
    const { messages } = await fetchMessagesViaApi(page, topicId)
    const found = (messages as any[]).find((m: any) => m?.id === messageId) as any
    if (found?.content === expected) return
    last = found ? `content=${JSON.stringify(found.content)}` : `absent n=${messages.length}`
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`message-content timeout ${messageId}: ${last}`)
}

async function pollForPendingDrained(page: Page, ms = 90000): Promise<void> {
  const deadline = Date.now() + ms
  let last = ''
  while (Date.now() < deadline) {
    const s = await getSyncStatusViaApi(page)
    if (s.pendingCount === 0 && s.lastError === null) return
    last = `pending=${s.pendingCount} error=${s.lastError}`
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`pending-drain timeout: ${last}`)
}

async function ensureObserverPaired(
  endpoint: string,
  approverPage: Page
): Promise<{ deviceId: string; deviceAuth: string }> {
  const deviceId = 'e2e-user-entrypoint-observer'
  const invite = await approverPage.evaluate(async () => await (window as any).api.sync.createInvite())
  if (!invite || typeof invite.code !== 'string') throw new Error('observer pairing: invite missing')
  const reqRes = await fetch(`${endpoint}/sync/pair/request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RELAY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, code: invite.code })
  })
  if (reqRes.status !== 200) throw new Error(`observer pairing: request ${reqRes.status}`)
  const reqBody = (await reqRes.json()) as { requestId?: unknown; deviceAuth?: unknown }
  if (typeof reqBody.requestId !== 'string' || typeof reqBody.deviceAuth !== 'string') {
    throw new Error('observer pairing: malformed response')
  }
  await approverPage.evaluate(
    async (requestId: string) => await (window as any).api.sync.acceptPairing(requestId),
    reqBody.requestId
  )
  return { deviceId, deviceAuth: reqBody.deviceAuth }
}

async function authedPull(endpoint: string, cursor: number, observer: { deviceId: string; deviceAuth: string }) {
  const res = await fetch(`${endpoint}/sync/pull?cursor=${cursor}&deviceId=${encodeURIComponent(observer.deviceId)}`, {
    headers: {
      Authorization: `Bearer ${RELAY_TOKEN}`,
      'x-sync-device-id': observer.deviceId,
      'x-sync-device-auth': observer.deviceAuth
    }
  })
  const body = (await res.json().catch(() => ({ operations: [], cursor }))) as { operations: any[]; cursor: number }
  return { status: res.status, body }
}

async function closeRelayAndProfile(
  relay: UserEntrypointRelayHandle | null,
  profileB: SecondSyncProfile | null
): Promise<void> {
  const errors: Error[] = []
  if (relay) {
    try {
      await relay.close()
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)))
    }
    try {
      if (relay.isRunning()) errors.push(new Error('sync user-entrypoint cleanup: owned relay child still live'))
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)))
    }
    try {
      assertNoUnresolvedRelayCleanup('sync user-entrypoint E2E cleanup')
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)))
    }
  }
  if (profileB) {
    try {
      await closeSecondSyncProfile(profileB)
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)))
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'sync user-entrypoint E2E cleanup failed')
}

test.describe('Sync user-entrypoint persistent relay', () => {
  test.setTimeout(300000)

  test('two profiles pair, sync, survive relay restart, and recover after short interruption', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: UserEntrypointRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    let testError: unknown = null
    try {
      validateOwnedRoot(ownedTmpRoot)
      try {
        relay = await startUserEntrypointRelay({ ownedTmpRoot, token: RELAY_TOKEN })
      } catch (e) {
        relay = getUserRelayHandle(e) ?? relay
        throw e
      }
      // User-entrypoint proof: stable readiness endpoint, disposable DB under
      // the owned root, explicit token (not env-only).
      expect(relay.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(relay.dbPath.startsWith(ownedTmpRoot)).toBe(true)
      expect(relay.token).toBe(RELAY_TOKEN)
      expect(fs.existsSync(relay.dbPath)).toBe(true)

      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      const endpoint = relay.endpoint

      await setSyncConfigViaApi(pageA, { endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint, token: RELAY_TOKEN, enabled: true })
      await pairProfilesViaApi(pageA, pageB)
      const observer = await ensureObserverPaired(endpoint, pageA)

      const topic = 'e2e-user-entrypoint-topic-1'
      const msg = 'e2e-user-entrypoint-msg-1'
      const blk = 'e2e-user-entrypoint-blk-1'
      const base = 'user entrypoint baseline one'
      await ensureTopicViaApi(pageA, topic, 'User Entrypoint Topic')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, base), [blockJson(blk, msg, base)])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForConvergence(pageB, topic, msg, blk, base)

      const baseline = await authedPull(endpoint, 0, observer)
      expect(baseline.status).toBe(200)
      expect(baseline.body.operations.length).toBeGreaterThan(0)
      const seqs = baseline.body.operations.map((o: any) => o.seq as number)
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1))
      const cursorBefore = baseline.body.cursor

      const statusABase = await getSyncStatusViaApi(pageA)
      const statusBBase = await getSyncStatusViaApi(pageB)
      expect(statusABase.pendingCount).toBe(0)
      expect(statusBBase.pendingCount).toBe(0)
      expect(statusABase.lastError).toBeNull()
      expect(statusBBase.lastError).toBeNull()
      const cursorA0 = statusABase.cursor
      const cursorB0 = statusBBase.cursor

      // Short interruption: stop the user-entrypoint relay (DB retained).
      await relay.stop()
      expect(relay.isRunning()).toBe(false)
      expect(fs.existsSync(relay.dbPath)).toBe(true)
      await expect(fetch(`${endpoint}/health`)).rejects.toThrow()

      const edited = 'user entrypoint edited content one'
      await updateMessageViaApi(pageA, topic, msg, { content: edited })
      await pollForMessageContent(pageA, topic, msg, edited, 30000)
      const failed = await runSyncViaApi(pageA)
      expect(failed.threw).not.toBeNull()
      const failedStatus = await getSyncStatusViaApi(pageA)
      expect(failedStatus.lastError).not.toBeNull()
      expect(failedStatus.pendingCount).toBeGreaterThan(0)
      expect(failedStatus.cursor).toBe(cursorA0)
      expect((await getSyncStatusViaApi(pageB)).cursor).toBe(cursorB0)

      // Restart the same user entrypoint against the same DB/token/port.
      await relay.restart()
      expect(relay.isRunning()).toBe(true)
      expect(relay.endpoint).toBe(endpoint)
      const health = await fetch(`${endpoint}/health`)
      expect(health.status).toBe(200)
      await health.json().catch(() => ({}))

      // Retained trust/operations/cursor: the paired observer still verifies
      // (no re-pairing) and the log is contiguous from cursor 0.
      const retained = await authedPull(endpoint, 0, observer)
      expect(retained.status).toBe(200)
      expect(retained.body.cursor).toBe(cursorBefore)
      expect(retained.body.operations.map((o: any) => o.seq)).toEqual(seqs)

      const pushed = await runSyncViaApi(pageA)
      expect(pushed.threw).toBeNull()
      expect(pushed.status.lastError).toBeNull()
      expect(pushed.status.pendingCount).toBe(0)
      await pollForMessageContent(pageB, topic, msg, edited, 90000)
      await pollForPendingDrained(pageA, 90000)
      await pollForPendingDrained(pageB, 90000)

      const statusA = await getSyncStatusViaApi(pageA)
      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusA.lastError).toBeNull()
      expect(statusB.lastError).toBeNull()
      expect(statusA.cursor).toBeGreaterThan(cursorBefore)
      expect(statusB.cursor).toBeGreaterThan(cursorBefore)
      expect(statusA.cursor).toBeGreaterThan(cursorA0)
      expect(statusB.cursor).toBeGreaterThan(cursorB0)
    } catch (e) {
      testError = e
    }
    try {
      await closeRelayAndProfile(relay, profileB)
    } catch (cleanupError) {
      const mainErr = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
      if (testError) {
        throw new AggregateError(
          [testError instanceof Error ? testError : new Error(String(testError)), mainErr],
          'sync user-entrypoint test and cleanup failed'
        )
      }
      throw mainErr
    }
    if (testError) throw testError
  })
})
