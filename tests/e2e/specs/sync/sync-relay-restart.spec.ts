/**
 * Sync relay-restart E2E: pending stable edit survives a file-backed relay
 * restart and converges afterwards.
 *
 * LOCK-012: file-backed reference relay only for this increment; no fallback
 * and no production deployment durability claim.
 * LOCK-013: the relay stores/forwards operations only; Main-process SQLite
 * remains the chat authority — every convergence assertion reads production
 * IPC-visible ChatDb state plus durable sync metadata.
 * LOCK-014: application abnormal-exit/SIGKILL/WAL validation is a separate
 * increment; this spec stops ONLY the test-owned relay child (bounded
 * SIGTERM, DB retained) and claims nothing about app crash/WAL durability.
 * LOCK-015: disposable relay DB, controlled owned process, strict
 * authenticated push/pull/cursor evidence; no screenshots/manual proof.
 * SSE is hint-only; payload allowlists and stable-content edit semantics are
 * unchanged; the runner never imports better-sqlite3 (the native binding
 * loads only in the owned Electron-as-Node relay child).
 *
 * Kept separate from the in-memory 12-test sync spec to avoid fixture risk.
 */
import type { Page } from '@playwright/test'

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
import {
  assertNoUnresolvedRelayCleanup,
  startFileBackedRelay,
  getFailedRelayHandle,
  type FileBackedRelayHandle
} from '../../utils/sync-relay-process'

const RELAY_TOKEN = 'e2e-sync-restart-token-1'

function messageJson(id: string, topicId: string, content: string): Record<string, unknown> {
  const now = isoNow()
  return {
    id,
    topicId,
    role: 'user',
    content,
    status: 'success',
    createdAt: now,
    updatedAt: now
  }
}

function blockJson(id: string, messageId: string, content: string): Record<string, unknown> {
  const now = isoNow()
  return {
    id,
    messageId,
    type: 'text',
    content,
    status: 'success',
    createdAt: now,
    updatedAt: now
  }
}

async function pollForConvergence(
  page: Page,
  topicId: string,
  messageId: string,
  blockId: string,
  expectedContent: string,
  timeoutMs = 30000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: string | null = null
  while (Date.now() < deadline) {
    try {
      const exists = await topicExistsViaApi(page, topicId)
      if (!exists) {
        lastError = 'topic missing'
      } else {
        const { messages, blocks } = await fetchMessagesViaApi(page, topicId)
        const msg = messages.find((m: any) => m?.id === messageId)
        const blk = blocks.find((b: any) => b?.id === blockId)
        if (
          msg &&
          blk &&
          (msg as any)?.content === expectedContent &&
          (blk as any)?.content === expectedContent &&
          (blk as any)?.messageId === messageId
        ) {
          return
        }
        lastError = `message/block not converged (messages=${messages.length}, blocks=${blocks.length})`
      }
    } catch (e) {
      lastError = String((e as Error).message)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`convergence timeout for ${topicId}/${messageId}/${blockId}: ${lastError}`)
}

async function pollForMessageContent(
  page: Page,
  topicId: string,
  messageId: string,
  expectedContent: string,
  timeoutMs = 90000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const { messages } = await fetchMessagesViaApi(page, topicId)
    const found = (messages as any[]).find((m: any) => m?.id === messageId) as any
    if (found && found.content === expectedContent) return
    last = found ? `content=${JSON.stringify(found.content)}` : `absent messages=${messages.length}`
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(
    `message-content timeout for ${topicId}/${messageId} expected=${JSON.stringify(expectedContent)} last=${last}`
  )
}

async function pollForPendingDrained(page: Page, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const status = await getSyncStatusViaApi(page)
    if (status.pendingCount === 0 && status.lastError === null) return
    last = `pending=${status.pendingCount} error=${status.lastError}`
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`pending-drain timeout: ${last}`)
}

interface RelayPullBody {
  operations: any[]
  cursor: number
}

interface RelayObserver {
  deviceId: string
  deviceAuth: string
}

/**
 * Pair a test-side diagnostic observer device through the production pairing
 * flow (F-001/F-002): the observer requests pairing with an approver-minted
 * invite code over raw HTTP (receiving its credential), and the trusted
 * approver accepts via production IPC. Raw diagnostic pulls then
 * authenticate as this already-trusted member. No trust is ever minted
 * outside the explicit pairing flow.
 */
async function ensureObserverPaired(endpoint: string, approverPage: Page): Promise<RelayObserver> {
  const deviceId = 'e2e-observer'
  const invite = await approverPage.evaluate(async () => {
    return await (window as any).api.sync.createInvite()
  })
  if (!invite || typeof invite.code !== 'string') throw new Error('observer pairing: invite code missing')
  const reqRes = await fetch(`${endpoint}/sync/pair/request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RELAY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, code: invite.code })
  })
  if (reqRes.status !== 200) throw new Error(`observer pairing: request failed ${reqRes.status}`)
  const reqBody = (await reqRes.json()) as { requestId?: unknown; deviceAuth?: unknown }
  if (typeof reqBody.requestId !== 'string' || typeof reqBody.deviceAuth !== 'string') {
    throw new Error('observer pairing: request response malformed')
  }
  const pending = await approverPage.evaluate(async () => {
    return await (window as any).api.sync.listPairingRequests()
  })
  const found = Array.isArray(pending?.requests)
    ? pending.requests.some((r: any) => r?.id === reqBody.requestId)
    : false
  if (!found) throw new Error('observer pairing: request not visible to approver')
  await approverPage.evaluate(async (requestId: string) => {
    return await (window as any).api.sync.acceptPairing(requestId)
  }, reqBody.requestId as string)
  return { deviceId, deviceAuth: reqBody.deviceAuth as string }
}

async function authedPull(
  endpoint: string,
  token: string,
  cursor: number,
  observer?: RelayObserver
): Promise<{ status: number; body: RelayPullBody }> {
  // Without an observer the legacy token-only form is used (401-first
  // negative paths); positive diagnostics pass the paired observer.
  if (!observer) {
    const res = await fetch(`${endpoint}/sync/pull?cursor=${cursor}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const body = (await res.json().catch(() => ({ operations: [], cursor }))) as RelayPullBody
    return { status: res.status, body }
  }
  const res = await fetch(`${endpoint}/sync/pull?cursor=${cursor}&deviceId=${encodeURIComponent(observer.deviceId)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-sync-device-id': observer.deviceId,
      'x-sync-device-auth': observer.deviceAuth
    }
  })
  const body = (await res.json().catch(() => ({ operations: [], cursor }))) as RelayPullBody
  return { status: res.status, body }
}

function stableOpProjection(ops: any[]): any[] {
  return ops.map((o: any) => ({
    seq: o.seq,
    id: o.id,
    entityType: o.entityType,
    op: o.op,
    entityId: o.entityId,
    timestamp: o.timestamp,
    deviceId: o.deviceId,
    payload: o.payload ?? null
  }))
}

/**
 * Bounded outage observation: B must remain at the baseline for the full
 * window and must never observe the queued edit. An immediate convergence
 * poll would return on the pre-existing baseline and prove nothing, so this
 * loop only passes when the window elapses without premature convergence.
 */
async function assertOutageHoldsBaseline(
  page: Page,
  topicId: string,
  messageId: string,
  baselineContent: string,
  editedContent: string,
  windowMs = 10000
): Promise<void> {
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline) {
    const { messages } = await fetchMessagesViaApi(page, topicId)
    const found = (messages as any[]).find((m: any) => m?.id === messageId) as any
    if (!found) throw new Error('outage observation: baseline message went missing on B')
    if (found.content === editedContent) {
      throw new Error('outage observation: B converged prematurely while the relay was stopped')
    }
    if (found.content !== baselineContent) {
      throw new Error(`outage observation: B left baseline (content=${JSON.stringify(found.content)})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * Fail-closed teardown: the relay child is stopped first (exact owned PID),
 * then the second profile, aggregating cleanup errors without swallowing a
 * successful step. When the relay is still live after close() the error
 * propagates so the fixture root teardown preserves the owned root instead
 * of deleting a live child's artifacts.
 */
async function closeRelayAndProfile(
  relay: FileBackedRelayHandle | null,
  profileB: SecondSyncProfile | null
): Promise<void> {
  const errors: Error[] = []
  const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))
  if (relay) {
    try {
      await relay.close()
    } catch (e) {
      errors.push(asError(e))
      // Retry once only when the child is already stopped; a live child keeps
      // its handle so the fixture gate blocks root removal for retry.
      try {
        if (!safeRelayRunning(relay)) await relay.close()
      } catch (e2) {
        errors.push(asError(e2))
      }
    }
    try {
      if (safeRelayRunning(relay)) {
        errors.push(new Error('sync relay-restart E2E cleanup: owned relay child still live; root preserved'))
      }
    } catch (e) {
      errors.push(asError(e))
    }
    try {
      assertNoUnresolvedRelayCleanup('sync relay-restart E2E cleanup')
    } catch (e) {
      errors.push(asError(e))
    }
  }
  if (profileB) {
    try {
      await closeSecondSyncProfile(profileB)
    } catch (e) {
      errors.push(asError(e))
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'sync relay-restart E2E cleanup failed')
}

function safeRelayRunning(relay: FileBackedRelayHandle): boolean {
  try {
    return relay.isRunning()
  } catch {
    return true
  }
}

test.describe('Sync file-backed relay restart', () => {
  test.setTimeout(300000)

  test('pending stable edit survives relay restart and converges after restart', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: FileBackedRelayHandle | null = null
    let failedRestartRelay: FileBackedRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    let testError: unknown = null
    try {
      try {
        relay = await startFileBackedRelay({ ownedTmpRoot, token: RELAY_TOKEN })
      } catch (e) {
        // Retain the owned handle from a failed start so finally cleanup can
        // stop the exact child; the global registry blocks root removal while
        // it lives.
        relay = getFailedRelayHandle(e) ?? relay
        throw e
      }
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      const endpoint = relay.endpoint

      await setSyncConfigViaApi(pageA, { endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint, token: RELAY_TOKEN, enabled: true })
      await pairProfilesViaApi(pageA, pageB)
      // Diagnostic observer for raw pull evidence (trusted via pairing flow).
      const observer = await ensureObserverPaired(endpoint, pageA)

      // Stable baseline topic/message converged on both profiles.
      const topic = 'e2e-sync-restart-topic-1'
      const msg = 'e2e-sync-restart-msg-1'
      const blk = 'e2e-sync-restart-blk-1'
      const base = 'restart baseline content one'
      await ensureTopicViaApi(pageA, topic, 'Restart Topic One')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, base), [blockJson(blk, msg, base)])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForConvergence(pageB, topic, msg, blk, base)

      // Strict pull evidence from cursor 0: contiguous retained operations.
      const baseline = await authedPull(endpoint, RELAY_TOKEN, 0, observer)
      expect(baseline.status).toBe(200)
      expect(baseline.body.operations.length).toBeGreaterThan(0)
      const seqs = baseline.body.operations.map((o: any) => o.seq as number)
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1))
      const cursorBefore = baseline.body.cursor
      expect(cursorBefore).toBe(seqs[seqs.length - 1])

      // Wrong-token pull stays 401 and does not mutate relay state: compare
      // the complete stable operation projection, not just count/cursor.
      const denied = await fetch(`${endpoint}/sync/pull?cursor=0`, {
        headers: { Authorization: 'Bearer wrong-token' }
      })
      expect(denied.status).toBe(401)
      await denied.json().catch(() => ({}))
      const afterDenied = await authedPull(endpoint, RELAY_TOKEN, 0, observer)
      expect(afterDenied.status).toBe(200)
      expect(afterDenied.body.cursor).toBe(cursorBefore)
      expect(stableOpProjection(afterDenied.body.operations)).toEqual(stableOpProjection(baseline.body.operations))

      // Wrong-token push stays 401 with no mutation either.
      const deniedPush = await fetch(`${endpoint}/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
        body: JSON.stringify({
          operations: [
            {
              id: 'e2e-wrong-token-op-1',
              entityType: 'topic',
              op: 'upsert',
              entityId: 'e2e-wrong-token-topic-1',
              timestamp: 1000,
              deviceId: 'd-wrong',
              payload: { id: 'e2e-wrong-token-topic-1', name: 'Wrong' }
            }
          ]
        })
      })
      expect(deniedPush.status).toBe(401)
      await deniedPush.json().catch(() => ({}))
      const afterDeniedPush = await authedPull(endpoint, RELAY_TOKEN, 0, observer)
      expect(afterDeniedPush.status).toBe(200)
      expect(afterDeniedPush.body.cursor).toBe(cursorBefore)
      expect(stableOpProjection(afterDeniedPush.body.operations)).toEqual(stableOpProjection(baseline.body.operations))

      // Baseline is fully drained on both profiles before the outage.
      const statusABase = await getSyncStatusViaApi(pageA)
      const statusBBase = await getSyncStatusViaApi(pageB)
      expect(statusABase.pendingCount).toBe(0)
      expect(statusBBase.pendingCount).toBe(0)
      expect(statusABase.lastError).toBeNull()
      expect(statusBBase.lastError).toBeNull()
      const cursorA0 = statusABase.cursor
      const cursorB0 = statusBBase.cursor
      const conflictsB0 = statusBBase.conflictCount

      // Stop the owned relay child with bounded SIGTERM; the DB is retained.
      const relayPid = relay.pid()
      expect(relayPid).toBeGreaterThan(0)
      await relay.stop()
      expect(relay.isRunning()).toBe(false)
      await expect(fetch(`${endpoint}/health`)).rejects.toThrow()

      // Queue a stable message content edit while the relay is unavailable:
      // truthful failure with pending work retained, no accepted remote op.
      const edited = 'restart edited content one'
      await updateMessageViaApi(pageA, topic, msg, { content: edited })
      await pollForMessageContent(pageA, topic, msg, edited, 30000)
      const failed = await runSyncViaApi(pageA)
      expect(failed.threw).not.toBeNull()
      const failedStatus = await getSyncStatusViaApi(pageA)
      expect(failedStatus.lastError).not.toBeNull()
      expect(failedStatus.pendingCount).toBeGreaterThan(0)
      // No cursor poisoning on failure: both durable cursors stay at baseline.
      expect(failedStatus.cursor).toBe(cursorA0)
      expect((await getSyncStatusViaApi(pageB)).cursor).toBe(cursorB0)
      // No remote convergence while the relay is down: B remains at the
      // baseline for a bounded observation window with its durable cursor
      // pinned at baseline (an immediate poll would pass on existing data).
      await assertOutageHoldsBaseline(pageB, topic, msg, base, edited, 10000)
      expect((await getSyncStatusViaApi(pageB)).cursor).toBe(cursorB0)

      // Restart the same relay child against the same DB/token/port.
      // Single-owner restart carries the same handle on failure; retain a
      // DISTINCT failed handle only (never double-close the original).
      try {
        await relay.restart()
      } catch (e) {
        const failed = getFailedRelayHandle(e)
        if (failed && failed !== relay) failedRestartRelay = failed
        throw e
      }
      expect(relay.isRunning()).toBe(true)
      expect(relay.endpoint).toBe(endpoint)
      const health = await fetch(`${endpoint}/health`)
      expect(health.status).toBe(200)
      await health.json().catch(() => ({}))

      // Retained operations and sequence continuity after restart.
      const retained = await authedPull(endpoint, RELAY_TOKEN, 0, observer)
      expect(retained.status).toBe(200)
      expect(retained.body.cursor).toBe(cursorBefore)
      expect(retained.body.operations.map((o: any) => o.seq)).toEqual(seqs)

      // Strict push/pull reconciliation: A pushes the queued edit, B pulls it.
      const pushed = await runSyncViaApi(pageA)
      expect(pushed.threw).toBeNull()
      expect(pushed.status.lastError).toBeNull()
      expect(pushed.status.pendingCount).toBe(0)
      await pollForMessageContent(pageB, topic, msg, edited, 90000)
      await pollForPendingDrained(pageA, 90000)
      await pollForPendingDrained(pageB, 90000)

      // Production IPC data/status assertions on both profiles.
      const statusA = await getSyncStatusViaApi(pageA)
      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusA.lastError).toBeNull()
      expect(statusB.lastError).toBeNull()
      expect(statusA.lastCaptureError).toBeNull()
      expect(statusB.lastCaptureError).toBeNull()
      expect(statusA.cursor).toBeGreaterThan(cursorBefore)
      expect(statusB.cursor).toBeGreaterThan(cursorBefore)
      expect(statusA.cursor).toBeGreaterThan(cursorA0)
      expect(statusB.cursor).toBeGreaterThan(cursorB0)
      // Existing LWW semantics mirror the ordinary-edit path: the receiver
      // records the deterministic same-field loser overwritten by the edit.
      expect(statusB.conflictCount).toBeGreaterThan(conflictsB0)
      // The block row keeps its original content: no joint block edit occurred.
      const afterB = await fetchMessagesViaApi(pageB, topic)
      const blkAfter = (afterB.blocks as any[]).find((b: any) => b?.id === blk) as any
      expect(blkAfter?.content).toBe(base)
    } catch (e) {
      testError = e
      // Fallback: retain a DISTINCT failed restart handle exposed via the
      // error (single-owner restarts carry the original handle, so identity
      // equality means nothing extra to close).
      const failed = getFailedRelayHandle(e)
      if (failed && failed !== relay && !failedRestartRelay) failedRestartRelay = failed
    }
    // Close a distinct failed restart handle first (if any), then the main
    // relay/profile teardown; aggregate all failures without double-closing.
    let extraCleanupError: Error | null = null
    if (failedRestartRelay) {
      const extra = failedRestartRelay
      failedRestartRelay = null
      try {
        await extra.close()
      } catch (e) {
        extraCleanupError = e instanceof Error ? e : new Error(String(e))
      }
      try {
        if (safeRelayRunning(extra)) {
          const liveErr = new Error(
            'sync relay-restart E2E cleanup: failed restart relay child still live; root preserved'
          )
          extraCleanupError = extraCleanupError
            ? new AggregateError([extraCleanupError, liveErr], 'failed restart relay cleanup failed')
            : liveErr
        }
      } catch (e) {
        const probeErr = e instanceof Error ? e : new Error(String(e))
        extraCleanupError = extraCleanupError
          ? new AggregateError([extraCleanupError, probeErr], 'failed restart relay cleanup failed')
          : probeErr
      }
    }
    try {
      await closeRelayAndProfile(relay, profileB)
    } catch (cleanupError) {
      const mainErr = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
      if (extraCleanupError) {
        const combined = new AggregateError([extraCleanupError, mainErr], 'sync relay-restart E2E cleanup failed')
        if (testError) {
          throw new AggregateError(
            [testError instanceof Error ? testError : new Error(String(testError)), combined],
            'sync relay-restart test and cleanup failed'
          )
        }
        throw combined
      }
      // Preserve both the original test failure and the cleanup failure.
      if (testError) {
        throw new AggregateError(
          [testError instanceof Error ? testError : new Error(String(testError)), mainErr],
          'sync relay-restart test and cleanup failed'
        )
      }
      throw mainErr
    }
    if (extraCleanupError) {
      if (testError) {
        throw new AggregateError(
          [testError instanceof Error ? testError : new Error(String(testError)), extraCleanupError],
          'sync relay-restart test and cleanup failed'
        )
      }
      throw extraCleanupError
    }
    if (testError) throw testError
  })
})
