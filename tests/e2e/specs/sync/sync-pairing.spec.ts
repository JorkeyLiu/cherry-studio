/**
 * Pairing increment real-user-path E2E: two isolated profiles + test relay.
 *
 * - request -> explicit accept -> trusted persistence (both profiles).
 * - Restart retains trust (clean-close relaunch of profile B).
 * - Untrusted device push/pull is rejected with device-not-trusted and the
 *   renderer shows a truthful error.
 * - Post-pairing convergence uses a covered message edit path.
 * - Reject cannot establish trust; duplicate requests do not duplicate trust.
 */
import type { Page } from '@playwright/test'

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
  ensureTopicViaApi,
  fetchMessagesViaApi,
  getSyncStatusViaApi,
  runSyncViaApi,
  setSyncConfigViaApi,
  updateMessageViaApi
} from '../../pages/sync.page'

const RELAY_TOKEN = 'e2e-pairing-token-1'

function messageJson(id: string, topicId: string, content: string): Record<string, unknown> {
  return { id, topicId, role: 'user', content, status: 'success', createdAt: new Date().toISOString() }
}

function blockJson(id: string, messageId: string, content: string): Record<string, unknown> {
  return { id, messageId, type: 'main_text', content, status: 'success', createdAt: new Date().toISOString() }
}

async function closeProfileAndRelay(profileB: SecondSyncProfile | null, relay: TestRelayHandle | null): Promise<void> {
  const errors: Error[] = []
  if (profileB) {
    try {
      await closeSecondSyncProfile(profileB)
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)))
    }
  }
  if (relay) {
    try {
      await relay.close()
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)))
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'pairing E2E cleanup failed')
}

async function pairingApi(page: Page, method: string, args?: unknown): Promise<any> {
  return await page.evaluate(
    async ({ method, args }: { method: string; args?: unknown }) => {
      const api = (window as any).api?.sync
      if (!api?.[method]) throw new Error(`window.api.sync.${method} not found`)
      return await api[method](...(args === undefined ? [] : [args]))
    },
    { method, args }
  )
}

async function pollForMessageContent(
  page: Page,
  topicId: string,
  messageId: string,
  expected: string,
  timeoutMs = 60000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const data = await fetchMessagesViaApi(page, topicId)
    const found = (data.messages as any[]).find((m) => m?.id === messageId)
    const content = found ? String(found.content ?? '') : ''
    last = content
    if (content === expected) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`message-content timeout expected=${expected} last=${last}`)
}

test.describe('Sync pairing two-profile real path', () => {
  test.setTimeout(300000)

  test('request -> accept -> trusted persists across restart and converges', async ({
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

      // Founder bootstrap: A syncs first and becomes trusted.
      const bootA = await runSyncViaApi(pageA)
      expect(bootA.threw).toBeNull()
      const statusA = await pairingApi(pageA, 'getPairingStatus')
      expect(statusA.trusted).toBe(true)

      // B is untrusted: sync is rejected truthfully before any convergence.
      const deniedB = await runSyncViaApi(pageB)
      expect(deniedB.threw).not.toBeNull()
      expect(String(deniedB.threw)).toContain('device-not-trusted')
      const deniedStatus = await getSyncStatusViaApi(pageB)
      expect(String(deniedStatus.lastError ?? '')).toContain('device-not-trusted')

      // B requests pairing with an invite minted by A; duplicate request is idempotent.
      const invite = await pairingApi(pageA, 'createInvite')
      expect(typeof invite.code).toBe('string')
      const req1 = await pairingApi(pageB, 'requestPairing', { code: invite.code, deviceName: 'profile-b' })
      expect(typeof req1.requestId).toBe('string')
      const req2 = await pairingApi(pageB, 'requestPairing', { code: invite.code, deviceName: 'profile-b' })
      expect(req2.requestId).toBe(req1.requestId)

      const pending = await pairingApi(pageA, 'listPairingRequests')
      expect(pending.requests).toHaveLength(1)

      // Explicit accept on A; B learns trust via status poll.
      await pairingApi(pageA, 'acceptPairing', req1.requestId)
      const statusB = await pairingApi(pageB, 'getPairingStatus')
      expect(statusB.trusted).toBe(true)
      const trustedA = await pairingApi(pageA, 'listTrusted')
      const trustedB = await pairingApi(pageB, 'refreshTrusted')
      expect(trustedA.devices.length).toBe(2)
      expect(trustedB.devices.length).toBe(2)

      // Post-pairing convergence on a covered edit path.
      const topic = 'e2e-pair-topic-1'
      const msg = 'e2e-pair-msg-1'
      const blk = 'e2e-pair-blk-1'
      await ensureTopicViaApi(pageA, topic, 'Pair Topic')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, 'pair hello'), [
        blockJson(blk, msg, 'pair hello')
      ])
      const syncA1 = await runSyncViaApi(pageA)
      expect(syncA1.threw).toBeNull()
      const syncB1 = await runSyncViaApi(pageB)
      expect(syncB1.threw).toBeNull()
      await pollForMessageContent(pageB, topic, msg, 'pair hello')
      await updateMessageViaApi(pageB, topic, msg, { content: 'pair edited' })
      const syncB2 = await runSyncViaApi(pageB)
      expect(syncB2.threw).toBeNull()
      const syncA2 = await runSyncViaApi(pageA)
      expect(syncA2.threw).toBeNull()
      await pollForMessageContent(pageA, topic, msg, 'pair edited')

      // Restart retains trust on B (clean-close relaunch, same userDataDir).
      profileB = await relaunchSecondSyncProfile(profileB, ownedTmpRoot, mockPort, {
        expectedEndpoint: relay.endpoint,
        expectedToken: RELAY_TOKEN,
        expectedEnabled: true
      })
      pageB = profileB.page
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      const afterRestart = await pairingApi(pageB, 'listTrusted')
      expect(afterRestart.devices.length).toBe(2)
      const syncAfter = await runSyncViaApi(pageB)
      expect(syncAfter.threw).toBeNull()
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('rejected request never becomes trusted', async ({ mainWindow, ownedTmpRoot, mockPort }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await runSyncViaApi(pageA)
      const invite = await pairingApi(pageA, 'createInvite')
      const req = await pairingApi(pageB, 'requestPairing', { code: invite.code })
      await pairingApi(pageA, 'rejectPairing', req.requestId)
      const statusB = await pairingApi(pageB, 'getPairingStatus')
      expect(statusB.trusted).toBe(false)
      const denied = await runSyncViaApi(pageB)
      expect(denied.threw).not.toBeNull()
      expect(String(denied.threw)).toContain('device-not-trusted')
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })
})
