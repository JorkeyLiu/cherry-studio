/**
 * Sync MVP real-user-path E2E: two isolated profiles + test-owned relay.
 *
 * LOCK-SYNC-E2E-001: only MVP-supported stable operations (ensureTopic +
 * appendMessage with blocks); no broadened capture semantics.
 * LOCK-SYNC-E2E-002: relay is per-spec, in-process, loopback-bound to an
 * ephemeral port, token-protected, fully closed/cleaned in teardown.
 * LOCK-SYNC-E2E-003: two profiles are independent children of the same owned
 * temp root, exact-token cleanup, no production single-instance change.
 * LOCK-SYNC-E2E-004: sync status via typed window.api.sync.getStatus() and
 * convergence via actual second-profile ChatDb data; no screenshots as proof.
 */
import type { Page } from '@playwright/test'
import { createServer as createTcpServer } from 'node:net'

import { expect, test } from '../../fixtures/electron.fixture'
import {
  closeSecondSyncProfile,
  launchSecondSyncProfile,
  relaunchSecondSyncProfile,
  type SecondSyncProfile
} from '../../utils/sync-second-profile'
import { startTestRelay, type TestRelayHandle } from '../../utils/sync-relay'
import {
  appendMessageViaApi,
  assertSyncTokenExactRedacted,
  deleteMessageViaApi,
  ensureTopicViaApi,
  fetchMessagesViaApi,
  getSyncConfigViaApi,
  getSyncStatusViaApi,
  hardDeleteTopicViaApi,
  isoNow,
  listTrashTopicIdsViaApi,
  restoreTopicViaApi,
  runSyncViaApi,
  setSyncConfigViaApi,
  softDeleteTopicViaApi,
  topicExistsViaApi,
  updateMessageViaApi,
  SyncSettingsPage
} from '../../pages/sync.page'

const RELAY_TOKEN = 'e2e-sync-token-1'

interface OfflineBlocker {
  endpoint: string
  close: () => Promise<void>
}

/**
 * Test-owned deterministic unavailable endpoint. Holds a loopback TCP port
 * whose sockets are destroyed immediately, so sync fetch fails without
 * relying on any unowned port (e.g. port 1) being free. No HTTP service ever
 * listens here. The caller must close it; closure is tracked in teardown.
 */
function startOfflineBlocker(): Promise<OfflineBlocker> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer((socket) => {
      socket.destroy()
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('offline blocker did not bind to a port'))
        return
      }
      resolve({
        endpoint: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => {
              if (err) rejectClose(err)
              else resolveClose()
            })
          })
      })
    })
  })
}

/**
 * Fail-closed teardown: relay.close() always runs even when profile cleanup
 * rejects. Cleanup errors are preserved (AggregateError when both fail) and
 * never swallow a successful relay closure.
 */
async function closeProfileAndRelay(
  profileB: SecondSyncProfile | null,
  relay: TestRelayHandle | null,
  extra: OfflineBlocker | null = null
): Promise<void> {
  const errors: Error[] = []
  const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))
  if (extra) {
    try {
      await extra.close()
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
  if (relay) {
    try {
      await relay.close()
    } catch (e) {
      errors.push(asError(e))
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'sync E2E cleanup failed')
}

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
          (msg as any)?.id === messageId &&
          (msg as any)?.topicId === topicId &&
          (msg as any)?.content === expectedContent &&
          (blk as any)?.id === blockId &&
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

/**
 * Bounded poll until the message (and its blocks) are absent on the profile.
 * A missing parent topic counts as absent; a fetch failure while the topic
 * is gone also counts as absent. Throws on timeout.
 */
async function pollForMessageAbsent(page: Page, topicId: string, messageId: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: string | null = null
  while (Date.now() < deadline) {
    try {
      const exists = await topicExistsViaApi(page, topicId)
      if (!exists) return
      try {
        const { messages, blocks } = await fetchMessagesViaApi(page, topicId)
        const msgGone = !messages.some((m: any) => m?.id === messageId)
        const blkGone = !blocks.some((b: any) => (b as any)?.messageId === messageId)
        if (msgGone && blkGone) return
        lastError = `message still present (messages=${messages.length}, blocks=${blocks.length})`
      } catch (e) {
        // The topic row may vanish between exists-check and fetch; re-check.
        const stillExists = await topicExistsViaApi(page, topicId).catch(() => true)
        if (!stillExists) return
        lastError = String((e as Error).message)
      }
    } catch (e) {
      lastError = String((e as Error).message)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`message-absent timeout for ${topicId}/${messageId}: ${lastError}`)
}

/** Bounded poll until the topic row is absent on the profile. */
async function pollForTopicAbsent(page: Page, topicId: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await topicExistsViaApi(page, topicId))) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`topic-absent timeout for ${topicId}`)
}

/** Bounded poll until trash membership matches expectation on the profile. */
async function pollForTrashState(
  page: Page,
  topicId: string,
  shouldContain: boolean,
  timeoutMs = 30000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ids = await listTrashTopicIdsViaApi(page)
    if (ids.includes(topicId) === shouldContain) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`trash-state timeout for ${topicId} shouldContain=${shouldContain}`)
}

/** Bounded poll until pendingCount drains to zero with no lastError. */
async function pollForPendingDrained(page: Page, timeoutMs = 60000): Promise<void> {
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

test.describe('Sync MVP two-profile real path', () => {
  test.setTimeout(300000)

  test('successful sync, offline backlog retry', async ({ mainWindow, ownedTmpRoot, mockPort }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    let offlineBlocker: OfflineBlocker | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page

      // Both profiles configure the same endpoint/token.
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      const statusA0 = await getSyncStatusViaApi(pageA)
      const statusB0 = await getSyncStatusViaApi(pageB)
      expect(statusA0.enabled).toBe(true)
      expect(statusB0.enabled).toBe(true)
      expect(statusA0.endpoint).toBe(relay.endpoint)
      expect(statusB0.endpoint).toBe(relay.endpoint)

      // Stable Sync Settings form renders with test hooks on profile A.
      const syncPage = new SyncSettingsPage(pageA)
      await syncPage.openSync()

      // Profile A creates a deterministic supported topic/message/block.
      const topic1 = 'e2e-sync-topic-1'
      const msg1 = 'e2e-sync-msg-1'
      const blk1 = 'e2e-sync-blk-1'
      const content1 = 'hello sync convergence one'
      await ensureTopicViaApi(pageA, topic1, 'Sync Topic One')
      await appendMessageViaApi(pageA, topic1, messageJson(msg1, topic1, content1), [blockJson(blk1, msg1, content1)])
      const local1 = await fetchMessagesViaApi(pageA, topic1)
      expect(local1.messages.some((m: any) => m?.id === msg1)).toBe(true)
      expect(local1.blocks.some((b: any) => b?.id === blk1 && b?.content === content1)).toBe(true)

      // A syncs, B syncs, B sees the exact data.
      const syncA1 = await runSyncViaApi(pageA)
      expect(syncA1.threw).toBeNull()
      expect(syncA1.status.lastError).toBeNull()
      const statusAfterA1 = await getSyncStatusViaApi(pageA)
      expect(statusAfterA1.lastError).toBeNull()
      expect(statusAfterA1.pendingCount).toBe(0)

      const syncB1 = await runSyncViaApi(pageB)
      expect(syncB1.threw).toBeNull()
      expect(syncB1.status.lastError).toBeNull()
      await pollForConvergence(pageB, topic1, msg1, blk1, content1)

      // A is pointed at a test-owned unavailable endpoint, creates another operation.
      // The blocker holds its loopback port with immediate socket destroy, so
      // the failure is independent of arbitrary port occupancy.
      offlineBlocker = await startOfflineBlocker()
      await setSyncConfigViaApi(pageA, { endpoint: offlineBlocker.endpoint, token: RELAY_TOKEN, enabled: true })
      const topic2 = 'e2e-sync-topic-2'
      const msg2 = 'e2e-sync-msg-2'
      const blk2 = 'e2e-sync-blk-2'
      const content2 = 'hello sync backlog two'
      await ensureTopicViaApi(pageA, topic2, 'Sync Topic Two')
      await appendMessageViaApi(pageA, topic2, messageJson(msg2, topic2, content2), [blockJson(blk2, msg2, content2)])

      // Manual sync fails truthfully with pending work retained + lastError.
      const failed = await runSyncViaApi(pageA)
      expect(failed.threw).not.toBeNull()
      const failedStatus = await getSyncStatusViaApi(pageA)
      expect(failedStatus.lastError).not.toBeNull()
      expect(failedStatus.pendingCount).toBeGreaterThan(0)

      // Restore endpoint, retry from A, then B syncs and sees the operation.
      // Closing the blocker before retry returns the port to the OS; retry
      // targets the same relay endpoint, not the blocker.
      try {
        await offlineBlocker.close()
      } finally {
        offlineBlocker = null
      }
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      const retry = await runSyncViaApi(pageA)
      expect(retry.threw).toBeNull()
      expect(retry.status.lastError).toBeNull()
      const retryStatus = await getSyncStatusViaApi(pageA)
      expect(retryStatus.lastError).toBeNull()
      expect(retryStatus.pendingCount).toBe(0)

      const syncB2 = await runSyncViaApi(pageB)
      expect(syncB2.threw).toBeNull()
      await pollForConvergence(pageB, topic2, msg2, blk2, content2)
    } finally {
      await closeProfileAndRelay(profileB, relay, offlineBlocker)
    }
  })

  test('wrong token fails truthfully without convergence', async ({ mainWindow, ownedTmpRoot, mockPort }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page

      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: 'wrong-token', enabled: true })

      const topic = 'e2e-sync-topic-denied'
      const msg = 'e2e-sync-msg-denied'
      const blk = 'e2e-sync-blk-denied'
      const content = 'must not converge on wrong token'
      await ensureTopicViaApi(pageA, topic, 'Sync Denied Topic')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, content), [blockJson(blk, msg, content)])

      const syncA = await runSyncViaApi(pageA)
      expect(syncA.threw).toBeNull()
      expect(syncA.status.lastError).toBeNull()

      const syncB = await runSyncViaApi(pageB)
      expect(syncB.threw).not.toBeNull()
      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusB.lastError).not.toBeNull()
      const exists = await topicExistsViaApi(pageB, topic)
      expect(exists).toBe(false)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('automatic convergence without manual sync plus reconnect recovery', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page

      // Both profiles configure the same relay; automation starts on save.
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })

      // Profile A makes a supported mutation; neither profile invokes manual sync.
      const topic1 = 'e2e-sync-auto-topic-1'
      const msg1 = 'e2e-sync-auto-msg-1'
      const blk1 = 'e2e-sync-auto-blk-1'
      const content1 = 'hello automatic convergence one'
      await ensureTopicViaApi(pageA, topic1, 'Sync Auto Topic One')
      await appendMessageViaApi(pageA, topic1, messageJson(msg1, topic1, content1), [blockJson(blk1, msg1, content1)])

      // B automatically receives the exact topic/message/block fields.
      await pollForConvergence(pageB, topic1, msg1, blk1, content1, 90000)

      // Short subscriber interruption: B disables sync, A writes again.
      // B must not converge while disabled.
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: false })
      const topic2 = 'e2e-sync-auto-topic-2'
      const msg2 = 'e2e-sync-auto-msg-2'
      const blk2 = 'e2e-sync-auto-blk-2'
      const content2 = 'hello automatic reconnect two'
      await ensureTopicViaApi(pageA, topic2, 'Sync Auto Topic Two')
      await appendMessageViaApi(pageA, topic2, messageJson(msg2, topic2, content2), [blockJson(blk2, msg2, content2)])
      await new Promise((resolve) => setTimeout(resolve, 5000))
      const stillMissing = await topicExistsViaApi(pageB, topic2)
      expect(stillMissing).toBe(false)

      // Re-enable B: reconnect uses the strict existing cursor pull and
      // converges without any manual sync invocation.
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await pollForConvergence(pageB, topic2, msg2, blk2, content2, 90000)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })
})

/**
 * Delete/recovery convergence on the operation-log + thin relay path.
 *
 * LOCK-001: Main SQLite is the sole runtime chat authority; every assertion
 * below reads production IPC-visible ChatDb state (topicExists/fetchMessages/
 * listTrashTopics) plus durable sync metadata (cursor/pendingCount/lastError).
 * LOCK-006: restore means soft-delete-topic -> restoreTopic; hard delete is
 * irreversible and late descendants must not resurrect the parent.
 * Relay pause/resume below is an in-memory network interruption only — never
 * durable restart evidence.
 */
test.describe('Sync delete/recovery convergence', () => {
  test.setTimeout(300000)

  test('online hard message delete converges to absence', async ({ mainWindow, ownedTmpRoot, mockPort }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })

      const topic = 'e2e-sync-del-topic-1'
      const msg = 'e2e-sync-del-msg-1'
      const blk = 'e2e-sync-del-blk-1'
      const content = 'online delete me'
      await ensureTopicViaApi(pageA, topic, 'Online Delete Topic')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, content), [blockJson(blk, msg, content)])
      const syncA0 = await runSyncViaApi(pageA)
      expect(syncA0.threw).toBeNull()
      const syncB0 = await runSyncViaApi(pageB)
      expect(syncB0.threw).toBeNull()
      await pollForConvergence(pageB, topic, msg, blk, content)

      // Baseline cursors before the delete (delete must advance both).
      const cursorA0 = (await getSyncStatusViaApi(pageA)).cursor
      const cursorB0 = (await getSyncStatusViaApi(pageB)).cursor

      await deleteMessageViaApi(pageA, topic, msg)
      const syncA1 = await runSyncViaApi(pageA)
      expect(syncA1.threw).toBeNull()
      expect(syncA1.status.lastError).toBeNull()
      expect(syncA1.status.pendingCount).toBe(0)
      const statusA1 = await getSyncStatusViaApi(pageA)
      expect(statusA1.cursor).toBeGreaterThan(cursorA0)
      await pollForMessageAbsent(pageA, topic, msg)

      const syncB1 = await runSyncViaApi(pageB)
      expect(syncB1.threw).toBeNull()
      await pollForMessageAbsent(pageB, topic, msg)
      const statusB1 = await getSyncStatusViaApi(pageB)
      expect(statusB1.cursor).toBeGreaterThan(cursorB0)
      expect(statusB1.pendingCount).toBe(0)
      // Parent topic survives a single message hard delete.
      expect(await topicExistsViaApi(pageB, topic)).toBe(true)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('offline hard delete reconciles after pause/resume with outbox recovery', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })

      const topic = 'e2e-sync-del-topic-2'
      const msg = 'e2e-sync-del-msg-2'
      const blk = 'e2e-sync-del-blk-2'
      const content = 'offline delete me'
      await ensureTopicViaApi(pageA, topic, 'Offline Delete Topic')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, content), [blockJson(blk, msg, content)])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForConvergence(pageB, topic, msg, blk, content)

      const cursorBefore = (await getSyncStatusViaApi(pageA)).cursor
      // Quiesce admitted requests before snapshotting relay counters so the
      // pause-state assertions below cannot race an in-flight commit.
      await relay.waitForQuiescent()
      const relayCursorBefore = relay.getCursor()
      const relayOpsBefore = relay.getOperationCount()

      // Controlled interruption: in-memory pause, log + cursor preserved.
      relay.setPaused(true)
      expect(relay.isPaused()).toBe(true)
      await deleteMessageViaApi(pageA, topic, msg)
      const failed = await runSyncViaApi(pageA)
      expect(failed.threw).not.toBeNull()
      const failedStatus = await getSyncStatusViaApi(pageA)
      expect(failedStatus.lastError).not.toBeNull()
      expect(failedStatus.pendingCount).toBeGreaterThan(0)
      // Pause preserves relay state: no new ops, no cursor motion. Quiesce
      // first so already-admitted requests settle before the comparison.
      await relay.waitForQuiescent()
      expect(relay.getCursor()).toBe(relayCursorBefore)
      expect(relay.getOperationCount()).toBe(relayOpsBefore)

      // Restoration: resume the same in-memory relay (not a restart).
      // Recovery from here is automatic only: no manual runSync is invoked
      // after resume. A's automation pushes the queued delete and the relay
      // SSE hint drives B's automatic pull; both are asserted below.
      relay.setPaused(false)
      expect(relay.isPaused()).toBe(false)
      await pollForPendingDrained(pageA, 90000)
      const recovered = await getSyncStatusViaApi(pageA)
      expect(recovered.lastError).toBeNull()
      expect(recovered.cursor).toBeGreaterThan(cursorBefore)
      await pollForMessageAbsent(pageA, topic, msg)

      await pollForMessageAbsent(pageB, topic, msg, 90000)
      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusB.lastError).toBeNull()
      expect(statusB.pendingCount).toBe(0)
    } finally {
      try {
        relay?.setPaused(false)
      } catch {}
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('late child after parent hard delete does not resurrect', async ({ mainWindow, ownedTmpRoot, mockPort }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })

      const topic = 'e2e-sync-late-topic-1'
      const msg = 'e2e-sync-late-msg-1'
      const blk = 'e2e-sync-late-blk-1'
      const content = 'late child parent'
      await ensureTopicViaApi(pageA, topic, 'Late Child Topic')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, content), [blockJson(blk, msg, content)])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForConvergence(pageB, topic, msg, blk, content)

      // Deterministic barrier BEFORE the parent delete is exchanged: block
      // pulls (pushes stay open) so B's automatic pull cannot pre-consume
      // the delete via SSE hint. Both profiles stay sync-enabled (capture
      // stays on); only transport pull is gated. In-memory ops/seq and
      // SSE hint-only semantics are unchanged.
      await relay.waitForQuiescent()
      const relayCursorBase = relay.getCursor()
      const relayOpsBase = relay.getOperationCount()
      const cursorABase = (await getSyncStatusViaApi(pageA)).cursor
      const cursorBBase = (await getSyncStatusViaApi(pageB)).cursor
      relay.setPullPaused(true)
      expect(relay.isPullPaused()).toBe(true)
      expect(relay.isPushPaused()).toBe(false)

      // A hard-deletes the parent topic; the delete must reach the relay
      // while B cannot pull it. sync() pushes first then pulls, so with
      // pulls gated the manual cycle reports the pull failure (threw) while
      // the push still commits: outbox drains, relay advances.
      await hardDeleteTopicViaApi(pageA, topic)
      await pollForTopicAbsent(pageA, topic)
      await runSyncViaApi(pageA)
      await relay.waitForQuiescent()
      const relayCursorAfterDelete = relay.getCursor()
      const relayOpsAfterDelete = relay.getOperationCount()
      expect(relayCursorAfterDelete).toBeGreaterThan(relayCursorBase)
      expect(relayOpsAfterDelete).toBeGreaterThan(relayOpsBase)
      const statusAAfterPush = await getSyncStatusViaApi(pageA)
      expect(statusAAfterPush.pendingCount).toBe(0)
      // B demonstrably did NOT pre-consume: parent still present locally and
      // B's durable pull cursor has not advanced past the baseline.
      expect(await topicExistsViaApi(pageB, topic)).toBe(true)
      const cursorBAfterDelete = (await getSyncStatusViaApi(pageB)).cursor
      expect(cursorBAfterDelete).toBe(cursorBBase)

      // Snapshot pre-child relay evidence, then freeze pushes as well so the
      // late-child capture is observable before automation can push it.
      // B stays enabled: the child is captured to the local outbox (disabling
      // B would disable capture and queue nothing).
      const relayCursorBeforeChild = relayCursorAfterDelete
      const relayOpsBeforeChild = relayOpsAfterDelete
      relay.setPushPaused(true)
      expect(relay.isPushPaused()).toBe(true)
      expect(relay.isPullPaused()).toBe(true)

      // Late descendant: B still holds the parent locally, so it appends a
      // newer child after the delete wall-clock. Capture must queue it.
      expect(await topicExistsViaApi(pageB, topic)).toBe(true)
      const lateMsg = 'e2e-sync-late-msg-2'
      const lateBlk = 'e2e-sync-late-blk-2'
      const lateContent = 'late descendant must not resurrect'
      await appendMessageViaApi(pageB, topic, messageJson(lateMsg, topic, lateContent), [
        blockJson(lateBlk, lateMsg, lateContent)
      ])
      const queuedStatus = await getSyncStatusViaApi(pageB)
      expect(queuedStatus.pendingCount).toBeGreaterThan(0)
      // Both directions fail closed: nothing admitted while fully gated.
      // Quiesce first so already-admitted requests settle deterministically.
      await relay.waitForQuiescent()
      expect(relay.getCursor()).toBe(relayCursorBeforeChild)
      expect(relay.getOperationCount()).toBe(relayOpsBeforeChild)

      // Controlled release, pushes first: B pushes the late child while pulls
      // stay gated. Push commits (relay advances) but no profile can consume
      // yet; B's outbox drains while its pull cursor stays at baseline.
      relay.setPushPaused(false)
      expect(relay.isPushPaused()).toBe(false)
      expect(relay.isPullPaused()).toBe(true)
      await runSyncViaApi(pageB)
      await relay.waitForQuiescent()
      const relayCursorAfterChild = relay.getCursor()
      const relayOpsAfterChild = relay.getOperationCount()
      expect(relayCursorAfterChild).toBeGreaterThan(relayCursorBeforeChild)
      expect(relayOpsAfterChild).toBeGreaterThan(relayOpsBeforeChild)
      const statusBAfterPush = await getSyncStatusViaApi(pageB)
      expect(statusBAfterPush.pendingCount).toBe(0)
      expect(statusBAfterPush.cursor).toBe(cursorBBase)
      const cursorABeforeFinalPull = (await getSyncStatusViaApi(pageA)).cursor
      expect(cursorABeforeFinalPull).toBe(cursorABase)

      // Release pulls: B pulls the parent delete (cascade-removes the parent
      // locally); A pulls the late child and suppresses it via the exact
      // parent tombstone. Manual rounds only after both barriers are clear.
      relay.setPullPaused(false)
      expect(relay.isPullPaused()).toBe(false)
      expect(relay.isPushPaused()).toBe(false)
      const syncB1 = await runSyncViaApi(pageB)
      expect(syncB1.threw).toBeNull()
      await pollForTopicAbsent(pageB, topic)
      const syncA2 = await runSyncViaApi(pageA)
      expect(syncA2.threw).toBeNull()
      // Second round so any relay-held late child reaches A and is consumed.
      const syncB2 = await runSyncViaApi(pageB)
      expect(syncB2.threw).toBeNull()

      // Relay evidence: the late child was actually delivered (ops + cursor
      // advanced past the pre-child snapshot) and the log holds its entity.
      await relay.waitForQuiescent()
      expect(relay.getOperationCount()).toBeGreaterThan(relayOpsBeforeChild)
      expect(relay.getCursor()).toBeGreaterThan(relayCursorBeforeChild)
      const deliveredRes = await fetch(`${relay.endpoint}/sync/pull?cursor=${relayCursorBeforeChild}`, {
        headers: { Authorization: `Bearer ${RELAY_TOKEN}` }
      })
      expect(deliveredRes.status).toBe(200)
      const deliveredBody = (await deliveredRes.json()) as { operations: any[]; cursor: number }
      const deliveredEntityIds = deliveredBody.operations.map((o: any) => String(o?.entityId))
      expect(deliveredEntityIds).toContain(lateMsg)
      // Profile-consumption proof (not pre-existing absence): the target
      // profile A actually pulled past the late-child sequence — its durable
      // cursor advanced beyond the pre-pull snapshot to at least the
      // relay-held child cursor. Same for B past the parent delete.
      const statusAFinal = await getSyncStatusViaApi(pageA)
      const statusBFinal = await getSyncStatusViaApi(pageB)
      expect(statusAFinal.cursor).toBeGreaterThan(cursorABeforeFinalPull)
      expect(statusAFinal.cursor).toBeGreaterThanOrEqual(relayCursorAfterChild)
      expect(statusBFinal.cursor).toBeGreaterThan(cursorBBase)
      expect(statusAFinal.pendingCount).toBe(0)
      expect(statusBFinal.pendingCount).toBe(0)

      // Neither the parent nor the late descendant is observable anywhere.
      await pollForTopicAbsent(pageA, topic)
      await pollForTopicAbsent(pageB, topic)
      await pollForMessageAbsent(pageA, topic, lateMsg)
      await pollForMessageAbsent(pageB, topic, lateMsg)
      await pollForMessageAbsent(pageB, topic, msg)
    } finally {
      try {
        relay?.setPaused(false)
      } catch {}
      try {
        relay?.setPushPaused(false)
      } catch {}
      try {
        relay?.setPullPaused(false)
      } catch {}
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('soft-delete then restoreTopic converges on both profiles', async ({ mainWindow, ownedTmpRoot, mockPort }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })

      const topic = 'e2e-sync-trash-topic-1'
      const msg = 'e2e-sync-trash-msg-1'
      const blk = 'e2e-sync-trash-blk-1'
      const content = 'trash and restore me'
      await ensureTopicViaApi(pageA, topic, 'Trash Topic')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, content), [blockJson(blk, msg, content)])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForConvergence(pageB, topic, msg, blk, content)
      const cursor0 = (await getSyncStatusViaApi(pageA)).cursor

      // Soft-delete converges as trash state; messages are preserved.
      await softDeleteTopicViaApi(pageA, topic)
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      await pollForTrashState(pageA, topic, true)
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForTrashState(pageB, topic, true)
      const statusTrashed = await getSyncStatusViaApi(pageA)
      expect(statusTrashed.cursor).toBeGreaterThan(cursor0)

      // Restore converges back; content survives the round-trip.
      const restored = await restoreTopicViaApi(pageA, topic)
      expect(restored).not.toBeNull()
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      await pollForTrashState(pageA, topic, false)
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForTrashState(pageB, topic, false)
      expect(await topicExistsViaApi(pageB, topic)).toBe(true)
      await pollForConvergence(pageB, topic, msg, blk, content)
      await pollForConvergence(pageA, topic, msg, blk, content)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('concurrent delete/edit converges both profiles to one result', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })

      const topic = 'e2e-sync-race-topic-1'
      const msg = 'e2e-sync-race-msg-1'
      const blk = 'e2e-sync-race-blk-1'
      const content = 'race base content'
      await ensureTopicViaApi(pageA, topic, 'Race Topic')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, content), [blockJson(blk, msg, content)])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForConvergence(pageB, topic, msg, blk, content)

      // Deterministic concurrency: gate transport BEFORE either mutation so
      // automation cannot exchange one intent before the other exists. Both
      // profiles stay capture-enabled; only the in-memory relay is paused
      // (ops/seq preserved, never durable restart evidence).
      await relay.waitForQuiescent()
      const relayCursorBase = relay.getCursor()
      const relayOpsBase = relay.getOperationCount()
      relay.setPaused(true)
      expect(relay.isPaused()).toBe(true)

      // Concurrent mutations while transport is gated: A deletes, B edits.
      // No winner is asserted (LWW timing decides); only that both profiles
      // deterministically agree afterwards.
      await deleteMessageViaApi(pageA, topic, msg)
      const editedContent = 'race edited content'
      await updateMessageViaApi(pageB, topic, msg, { content: editedContent })

      // Both local intents are pending before any transport release: neither
      // op could have been exchanged early.
      const statusAPending = await getSyncStatusViaApi(pageA)
      const statusBPending = await getSyncStatusViaApi(pageB)
      expect(statusAPending.pendingCount).toBeGreaterThan(0)
      expect(statusBPending.pendingCount).toBeGreaterThan(0)
      await relay.waitForQuiescent()
      expect(relay.getCursor()).toBe(relayCursorBase)
      expect(relay.getOperationCount()).toBe(relayOpsBase)

      // Release transport, then exchange. Two full rounds so each side sees
      // the other's intent.
      relay.setPaused(false)
      expect(relay.isPaused()).toBe(false)
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()

      const deadline = Date.now() + 60000
      let agreement: string | null = null
      let lastDetail = ''
      while (Date.now() < deadline) {
        const existsA = await topicExistsViaApi(pageA, topic)
        const existsB = await topicExistsViaApi(pageB, topic)
        const fetchA = existsA ? await fetchMessagesViaApi(pageA, topic).catch(() => null) : null
        const fetchB = existsB ? await fetchMessagesViaApi(pageB, topic).catch(() => null) : null
        const msgA = fetchA?.messages.find((m: any) => m?.id === msg) as any
        const msgB = fetchB?.messages.find((m: any) => m?.id === msg) as any
        if (!msgA && !msgB) {
          agreement = 'deleted-both'
          break
        }
        if (msgA && msgB && msgA.content === msgB.content) {
          agreement = `present-both:${String(msgA.content)}`
          break
        }
        lastDetail = `A=${msgA ? JSON.stringify(msgA.content) : 'absent'} B=${msgB ? JSON.stringify(msgB.content) : 'absent'}`
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(agreement).not.toBeNull()
      // Settle once more; agreement must be stable, not a transient read.
      await new Promise((resolve) => setTimeout(resolve, 2000))
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      const statusA = await getSyncStatusViaApi(pageA)
      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusA.pendingCount).toBe(0)
      expect(statusB.pendingCount).toBe(0)
      expect(statusA.lastError).toBeNull()
      expect(statusB.lastError).toBeNull()
      if (agreement === 'deleted-both') {
        await pollForMessageAbsent(pageA, topic, msg)
        await pollForMessageAbsent(pageB, topic, msg)
      } else {
        // Edit-wins: only the message row carries the edit; the block keeps
        // its original content, so assert message-content agreement directly.
        const contentAgreed = (agreement as string).split(':').slice(1).join(':')
        for (const page of [pageA, pageB]) {
          const msgDeadline = Date.now() + 30000
          for (;;) {
            const { messages } = await fetchMessagesViaApi(page, topic)
            const found = (messages as any[]).find((m: any) => m?.id === msg) as any
            if (found && found.content === contentAgreed) break
            if (Date.now() >= msgDeadline) {
              throw new Error(`message-content timeout: expected ${JSON.stringify(contentAgreed)}`)
            }
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        }
      }
      void lastDetail
      void blk
    } finally {
      try {
        relay?.setPaused(false)
      } catch {}
      await closeProfileAndRelay(profileB, relay)
    }
  })
})

/**
 * Ordinary message edit + offline concurrent edit semantics on the
 * operation-log + thin relay path.
 *
 * LOCK-001: Main SQLite is the sole runtime chat authority; every assertion
 * reads production IPC-visible ChatDb state plus durable sync metadata.
 * LOCK-002: the operation log is sync intent only, never a second authority.
 * LOCK-003: strict authenticated push/pull+cursor is authoritative; SSE is
 * notification only (tests below never assert SSE-delivered data).
 * LOCK-008: edits use stable message allowlisted scalar fields only
 * (content/status); no structured block/attachment joint edits.
 * LOCK-009: same-field conflicts use existing timestamp-then-operationId LWW
 * and observe conflictCount; no new winner rule or conflict UI.
 * LOCK-010: recovery means clean close with pending edit then same-profile
 * relaunch and continued convergence only; no crash/SIGKILL/WAL claim.
 * LOCK-011: the same in-memory relay instance stays alive across relaunch;
 * no relay restart persistence is tested.
 */

/** Bounded poll until the message row carries the expected content. */
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

/** Bounded poll until the message row carries the expected content+status. */
async function pollForMessageFields(
  page: Page,
  topicId: string,
  messageId: string,
  expected: { content: string; status: string },
  timeoutMs = 90000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const { messages } = await fetchMessagesViaApi(page, topicId)
    const found = (messages as any[]).find((m: any) => m?.id === messageId) as any
    if (found && found.content === expected.content && found.status === expected.status) return
    last = found
      ? `content=${JSON.stringify(found.content)} status=${JSON.stringify(found.status)}`
      : `absent messages=${messages.length}`
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(
    `message-fields timeout for ${topicId}/${messageId} expected=${JSON.stringify(expected)} last=${last}`
  )
}

/**
 * Bounded poll until both profiles agree on the same message content, which
 * must be one of the allowed candidates. Returns the agreed winner content.
 * Callers asserting LOCK-009 must additionally compare the returned content
 * against the relay-computed timestamp-then-operationId winner.
 */
async function pollForSameContentAgreement(
  pageA: Page,
  pageB: Page,
  topicId: string,
  messageId: string,
  candidates: string[],
  timeoutMs = 120000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const [fetchA, fetchB] = await Promise.all([
      fetchMessagesViaApi(pageA, topicId).catch(() => null),
      fetchMessagesViaApi(pageB, topicId).catch(() => null)
    ])
    const msgA = fetchA?.messages.find((m: any) => m?.id === messageId) as any
    const msgB = fetchB?.messages.find((m: any) => m?.id === messageId) as any
    if (
      msgA &&
      msgB &&
      typeof msgA.content === 'string' &&
      msgA.content === msgB.content &&
      candidates.includes(msgA.content)
    ) {
      return msgA.content as string
    }
    last = `A=${msgA ? JSON.stringify(msgA.content) : 'absent'} B=${msgB ? JSON.stringify(msgB.content) : 'absent'}`
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`same-content agreement timeout for ${topicId}/${messageId}: ${last}`)
}

interface RelayMessageUpsert {
  id: string
  timestamp: number
  content: string
}

/**
 * Poll the existing authenticated relay pull path from a pre-mutation cursor
 * until both same-field message upserts for the entity are observable, then
 * compute the existing timestamp-then-operationId LWW winner (mirror of the
 * production compareLww: timestamp numeric, operationId lexicographic).
 * Test-only; uses the relay HTTP pull capability already used elsewhere.
 */
async function pollForRelayLwwWinner(
  endpoint: string,
  token: string,
  baseCursor: number,
  entityId: string,
  candidates: string[],
  timeoutMs = 120000
): Promise<RelayMessageUpsert> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const res = await fetch(`${endpoint}/sync/pull?cursor=${baseCursor}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { operations: any[] }
    const ops = (Array.isArray(body.operations) ? body.operations : []).filter(
      (o: any) =>
        o?.entityType === 'message' &&
        o?.entityId === entityId &&
        o?.op === 'upsert' &&
        typeof o?.id === 'string' &&
        typeof o?.timestamp === 'number' &&
        typeof o?.payload?.content === 'string' &&
        candidates.includes(String(o.payload.content))
    ) as any[]
    // Both distinct candidate contents must be present before deciding.
    const seen = new Set(ops.map((o) => String(o.payload.content)))
    if (ops.length >= 2 && candidates.every((c) => seen.has(c))) {
      let winner = ops[0]
      for (const op of ops.slice(1)) {
        if (
          op.timestamp > winner.timestamp ||
          (op.timestamp === winner.timestamp && String(op.id) > String(winner.id))
        ) {
          winner = op
        }
      }
      return { id: String(winner.id), timestamp: winner.timestamp as number, content: String(winner.payload.content) }
    }
    last = `ops=${ops.length} seen=[${[...seen].join(',')}]`
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`relay LWW winner timeout for ${entityId}: ${last}`)
}

test.describe('Sync ordinary edit and concurrent edit semantics', () => {
  test.setTimeout(300000)

  test('online ordinary message content edit converges automatically', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })

      // Deterministic baseline, drained via labeled manual setup rounds.
      const topic = 'e2e-sync-edit-topic-1'
      const msg = 'e2e-sync-edit-msg-1'
      const blk = 'e2e-sync-edit-blk-1'
      const base = 'edit baseline content one'
      await ensureTopicViaApi(pageA, topic, 'Edit Topic One')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, base), [blockJson(blk, msg, base)])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForConvergence(pageB, topic, msg, blk, base)

      const cursorA0 = (await getSyncStatusViaApi(pageA)).cursor
      const cursorB0 = (await getSyncStatusViaApi(pageB)).cursor
      const conflictsA0 = (await getSyncStatusViaApi(pageA)).conflictCount
      const conflictsB0 = (await getSyncStatusViaApi(pageB)).conflictCount

      // Ordinary allowlisted scalar edit on A only (message row; block untouched).
      const edited = 'edit online converged content one'
      await updateMessageViaApi(pageA, topic, msg, { content: edited })
      await pollForMessageContent(pageA, topic, msg, edited, 30000)

      // Automatic convergence: no manual runSync after the edit. B's
      // automation pulls the strict push/pull+cursor path (SSE hint only).
      await pollForMessageContent(pageB, topic, msg, edited, 90000)
      await pollForPendingDrained(pageA, 90000)
      await pollForPendingDrained(pageB, 90000)
      const statusA = await getSyncStatusViaApi(pageA)
      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusA.lastError).toBeNull()
      expect(statusB.lastError).toBeNull()
      expect(statusA.lastCaptureError).toBeNull()
      expect(statusB.lastCaptureError).toBeNull()
      expect(statusA.cursor).toBeGreaterThan(cursorA0)
      expect(statusB.cursor).toBeGreaterThan(cursorB0)
      // Existing LWW semantics: the writer observes no contest locally while
      // the receiver records the deterministic same-field loser (old value
      // overwritten by the newer edit). Observe honestly without a new rule.
      expect(statusA.conflictCount).toBe(conflictsA0)
      expect(statusB.conflictCount).toBeGreaterThan(conflictsB0)
      // Block row keeps its original content: no joint block edit occurred.
      const afterB = await fetchMessagesViaApi(pageB, topic)
      const blkAfter = (afterB.blocks as any[]).find((b: any) => b?.id === blk) as any
      expect(blkAfter?.content).toBe(base)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('offline independent-field edits merge preserving both fields', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })

      // Deterministic baseline, drained via labeled manual setup rounds.
      const topic = 'e2e-sync-edit-topic-2'
      const msg = 'e2e-sync-edit-msg-2'
      const blk = 'e2e-sync-edit-blk-2'
      const base = 'edit baseline content two'
      await ensureTopicViaApi(pageA, topic, 'Edit Topic Two')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, base), [blockJson(blk, msg, base)])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForConvergence(pageB, topic, msg, blk, base)
      const conflictsA0 = (await getSyncStatusViaApi(pageA)).conflictCount
      const conflictsB0 = (await getSyncStatusViaApi(pageB)).conflictCount
      const cursorA0 = (await getSyncStatusViaApi(pageA)).cursor

      // Gate transport before either mutation so automation cannot exchange
      // one intent before the other exists. Both profiles stay enabled.
      await relay.waitForQuiescent()
      const relayCursorBase = relay.getCursor()
      const relayOpsBase = relay.getOperationCount()
      relay.setPaused(true)
      expect(relay.isPaused()).toBe(true)

      // Independent allowlisted scalar fields: A edits content, B edits status.
      const contentA = 'edit independent content from A'
      const statusB = 'error'
      await updateMessageViaApi(pageA, topic, msg, { content: contentA })
      await updateMessageViaApi(pageB, topic, msg, { status: statusB })

      // Both operations are locally captured/pending before any release.
      const pendingA = await getSyncStatusViaApi(pageA)
      const pendingB = await getSyncStatusViaApi(pageB)
      expect(pendingA.pendingCount).toBeGreaterThan(0)
      expect(pendingB.pendingCount).toBeGreaterThan(0)
      await relay.waitForQuiescent()
      expect(relay.getCursor()).toBe(relayCursorBase)
      expect(relay.getOperationCount()).toBe(relayOpsBase)

      // Release transport; convergence is automatic only (no post-release
      // manual sync). The strict push/pull+cursor path merges independent
      // fields; SSE is hint-only.
      relay.setPaused(false)
      expect(relay.isPaused()).toBe(false)
      await pollForMessageFields(pageA, topic, msg, { content: contentA, status: statusB }, 120000)
      await pollForMessageFields(pageB, topic, msg, { content: contentA, status: statusB }, 120000)
      await pollForPendingDrained(pageA, 90000)
      await pollForPendingDrained(pageB, 90000)
      const statusA = await getSyncStatusViaApi(pageA)
      const statusBFinal = await getSyncStatusViaApi(pageB)
      expect(statusA.lastError).toBeNull()
      expect(statusBFinal.lastError).toBeNull()
      expect(statusA.lastCaptureError).toBeNull()
      expect(statusBFinal.lastCaptureError).toBeNull()
      expect(statusA.cursor).toBeGreaterThan(cursorA0)
      // Existing field-clock semantics: the baseline full upsert seeds a field
      // clock for every clocked field, so each receiver applies a newer
      // disjoint changed value over an existing baseline clock whose current
      // value differs and records the overwritten baseline value as a
      // conflict (SyncService winning path), even though the fields never
      // contest each other. Both fields still merge; no product rule changes.
      expect(statusA.conflictCount).toBeGreaterThan(conflictsA0)
      expect(statusBFinal.conflictCount).toBeGreaterThan(conflictsB0)
      expect(statusA.conflictCount + statusBFinal.conflictCount).toBeGreaterThan(conflictsA0 + conflictsB0)
    } finally {
      try {
        relay?.setPaused(false)
      } catch {}
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('offline same-field content edits converge to the LWW winner with conflictCount', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })

      // Deterministic baseline, drained via labeled manual setup rounds.
      const topic = 'e2e-sync-edit-topic-3'
      const msg = 'e2e-sync-edit-msg-3'
      const blk = 'e2e-sync-edit-blk-3'
      const base = 'edit baseline content three'
      await ensureTopicViaApi(pageA, topic, 'Edit Topic Three')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, base), [blockJson(blk, msg, base)])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForConvergence(pageB, topic, msg, blk, base)
      const conflictsA0 = (await getSyncStatusViaApi(pageA)).conflictCount
      const conflictsB0 = (await getSyncStatusViaApi(pageB)).conflictCount

      // Gate transport before either mutation.
      await relay.waitForQuiescent()
      const relayCursorBase = relay.getCursor()
      const relayOpsBase = relay.getOperationCount()
      relay.setPaused(true)
      expect(relay.isPaused()).toBe(true)

      // Same allowlisted scalar field from both sides with distinct values.
      const contentA = 'edit same-field content from A'
      const contentB = 'edit same-field content from B'
      await updateMessageViaApi(pageA, topic, msg, { content: contentA })
      await updateMessageViaApi(pageB, topic, msg, { content: contentB })

      // Both pending before release; nothing exchanged while gated.
      const pendingA = await getSyncStatusViaApi(pageA)
      const pendingB = await getSyncStatusViaApi(pageB)
      expect(pendingA.pendingCount).toBeGreaterThan(0)
      expect(pendingB.pendingCount).toBeGreaterThan(0)
      await relay.waitForQuiescent()
      expect(relay.getCursor()).toBe(relayCursorBase)
      expect(relay.getOperationCount()).toBe(relayOpsBase)

      // Release transport; exchange is automatic only (no post-release manual
      // sync). The winner is the existing timestamp-then-operationId LWW
      // winner computed from the authenticated relay pull path.
      relay.setPaused(false)
      expect(relay.isPaused()).toBe(false)
      const lwwWinner = await pollForRelayLwwWinner(relay.endpoint, RELAY_TOKEN, relayCursorBase, msg, [
        contentA,
        contentB
      ])
      expect([contentA, contentB]).toContain(lwwWinner.content)
      const winner = await pollForSameContentAgreement(pageA, pageB, topic, msg, [contentA, contentB], 120000)
      expect(winner).toBe(lwwWinner.content)
      // Both profiles carry exactly the computed winner content.
      await pollForMessageContent(pageA, topic, msg, lwwWinner.content, 60000)
      await pollForMessageContent(pageB, topic, msg, lwwWinner.content, 60000)
      await pollForPendingDrained(pageA, 90000)
      await pollForPendingDrained(pageB, 90000)
      const statusA = await getSyncStatusViaApi(pageA)
      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusA.lastError).toBeNull()
      expect(statusB.lastError).toBeNull()
      expect(statusA.lastCaptureError).toBeNull()
      expect(statusB.lastCaptureError).toBeNull()
      // The loser side(s) observe the existing deterministic conflict record.
      // Each side applies the remote same-field value against its own newer
      // local value, so both record the deterministic loser on this path.
      expect(statusA.conflictCount).toBeGreaterThan(conflictsA0)
      expect(statusB.conflictCount).toBeGreaterThan(conflictsB0)
      expect(statusA.conflictCount + statusB.conflictCount).toBeGreaterThan(conflictsA0 + conflictsB0)
    } finally {
      try {
        relay?.setPaused(false)
      } catch {}
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('pending edit survives clean same-profile relaunch then converges', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      let pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })

      // Deterministic baseline, drained via labeled manual setup rounds.
      const topic = 'e2e-sync-edit-topic-4'
      const msg = 'e2e-sync-edit-msg-4'
      const blk = 'e2e-sync-edit-blk-4'
      const base = 'edit baseline content four'
      await ensureTopicViaApi(pageA, topic, 'Edit Topic Four')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, base), [blockJson(blk, msg, base)])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForConvergence(pageB, topic, msg, blk, base)

      // Gate transport, then queue a pending edit on the second profile.
      await relay.waitForQuiescent()
      const relayCursorBase = relay.getCursor()
      const relayOpsBase = relay.getOperationCount()
      relay.setPaused(true)
      expect(relay.isPaused()).toBe(true)
      const recoveryContent = 'edit pending recovery content four'
      await updateMessageViaApi(pageB, topic, msg, { content: recoveryContent })
      await pollForMessageContent(pageB, topic, msg, recoveryContent, 30000)
      const beforeClose = await getSyncStatusViaApi(pageB)
      expect(beforeClose.pendingCount).toBeGreaterThan(0)
      await relay.waitForQuiescent()
      expect(relay.getCursor()).toBe(relayCursorBase)
      expect(relay.getOperationCount()).toBe(relayOpsBase)

      // Clean close + same-profile relaunch while the same relay stays alive.
      const userDataDirBefore = profileB.userDataDir
      profileB = await relaunchSecondSyncProfile(profileB, ownedTmpRoot, mockPort, {
        expectedEndpoint: relay.endpoint,
        expectedToken: RELAY_TOKEN,
        expectedEnabled: true
      })
      pageB = profileB.page
      expect(profileB.userDataDir).toBe(userDataDirBefore)

      // Post-relaunch durable state: outbox survived the clean close, the
      // cursor did not advance while gated, and sync config persisted. The
      // raw persisted config is asserted BEFORE any repair (the relaunch
      // helper performs no repair; repairSecondSyncConfig is setup-only and
      // is not called on this path). Missing/empty token fails.
      const rawRelaunchedConfig = (await pageB.evaluate(async () => {
        return await (window as any).api.sync.getConfig()
      })) as any
      expect(rawRelaunchedConfig.endpoint).toBe(relay.endpoint)
      expect(rawRelaunchedConfig.enabled).toBe(true)
      assertSyncTokenExactRedacted(rawRelaunchedConfig.token, RELAY_TOKEN, 'persisted sync token after relaunch')
      const afterRelaunch = await getSyncStatusViaApi(pageB)
      expect(afterRelaunch.pendingCount).toBeGreaterThan(0)
      expect(afterRelaunch.cursor).toBe(beforeClose.cursor)
      const relaunchedConfig = await getSyncConfigViaApi(pageB)
      expect(relaunchedConfig.endpoint).toBe(relay.endpoint)
      expect(relaunchedConfig.enabled).toBe(true)
      assertSyncTokenExactRedacted(relaunchedConfig.token, RELAY_TOKEN, 'persisted sync token after relaunch')
      await pollForMessageContent(pageB, topic, msg, recoveryContent, 30000)

      // Release transport; the recovered pending edit converges automatically
      // (no post-release manual sync). Scope is clean-close pending outbox
      // recovery only.
      relay.setPaused(false)
      expect(relay.isPaused()).toBe(false)
      await pollForMessageContent(pageA, topic, msg, recoveryContent, 120000)
      await pollForPendingDrained(pageB, 90000)
      await pollForPendingDrained(pageA, 90000)
      const statusA = await getSyncStatusViaApi(pageA)
      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusA.lastError).toBeNull()
      expect(statusB.lastError).toBeNull()
      expect(statusA.lastCaptureError).toBeNull()
      expect(statusB.lastCaptureError).toBeNull()
    } finally {
      try {
        relay?.setPaused(false)
      } catch {}
      await closeProfileAndRelay(profileB, relay)
    }
  })
})
