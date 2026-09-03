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
  type SecondSyncProfile
} from '../../utils/sync-second-profile'
import { startTestRelay, type TestRelayHandle } from '../../utils/sync-relay'
import {
  appendMessageViaApi,
  ensureTopicViaApi,
  fetchMessagesViaApi,
  getSyncStatusViaApi,
  isoNow,
  runSyncViaApi,
  setSyncConfigViaApi,
  topicExistsViaApi,
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
})
