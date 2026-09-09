/**
 * Connection/registration/channel/pairing real-user-path E2E (SYNC-CC-*):
 * two isolated profiles + test relay.
 *
 * - Connect/register -> device-code request -> accept -> sync convergence.
 * - Registration/membership persists across app restart (no re-pairing).
 * - Disconnect -> Connect resumes without reconfiguration (still paired).
 * - Unpair preserves service attachment and local chats.
 * - A third device joins the existing channel.
 * - A paired requester cannot initiate; late accept after the requester
 *   became paired fails terminal 410 request-replaced with no merge.
 * - Two independent channels stay invisible to each other with independent
 *   contiguous cursors.
 */
import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/electron.fixture'
import {
  appendMessageViaApi,
  connectViaApi,
  disconnectViaApi,
  ensureTopicViaApi,
  fetchMessagesViaApi,
  getDeviceCodeViaApi,
  getPairStateViaApi,
  getServiceStatusViaApi,
  getSyncStatusViaApi,
  pairProfilesViaApi,
  provisionObserverViaRaw,
  runSyncViaApi,
  setSyncConfigViaApi,
  unpairViaApi,
  updateMessageViaApi
} from '../../pages/sync.page'
import {
  closeSecondSyncProfile,
  launchSecondSyncProfile,
  relaunchSecondSyncProfile,
  type SecondSyncProfile
} from '../../utils/sync-second-profile'
import { startTestRelay, type TestRelayHandle } from '../../utils/sync-relay'

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

async function ipc(page: Page, method: string, args?: unknown): Promise<any> {
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

test.describe('Sync connection/pairing two-profile real path', () => {
  test.setTimeout(300000)

  test('connect/register -> device-code request -> accept -> sync converges', async ({
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

      // Explicit Connect registers both devices (stable public codes).
      const connectedA = await connectViaApi(pageA)
      const connectedB = await connectViaApi(pageB)
      expect(connectedA.state).toBe('connected')
      expect(connectedB.state).toBe('connected')
      const codeA = (await getDeviceCodeViaApi(pageA)).deviceCode
      const codeB = (await getDeviceCodeViaApi(pageB)).deviceCode
      expect(typeof codeA).toBe('string')
      expect(typeof codeB).toBe('string')
      expect(codeA).not.toBe(codeB)

      // Unpaired sync is refused truthfully before any convergence, with a
      // durable lastError and retained pending intent (no cursor advance).
      const deniedB = await runSyncViaApi(pageB)
      expect(deniedB.threw).not.toBeNull()
      expect(String(deniedB.threw)).toContain('pairing-required')
      const deniedStatus = await getSyncStatusViaApi(pageB)
      expect(deniedStatus.lastError).not.toBeNull()
      expect(String(deniedStatus.lastError)).toContain('pairing-required')

      // B requests pairing with A's public device code; duplicate request
      // is idempotent.
      const req1 = await ipc(pageB, 'requestPairing', { targetCode: codeA })
      expect(typeof req1.requestId).toBe('string')
      const req2 = await ipc(pageB, 'requestPairing', { targetCode: codeA })
      expect(req2.requestId).toBe(req1.requestId)
      expect((await getPairStateViaApi(pageB)).state).toBe('outgoing')

      // Explicit accept on A pairs both into one hidden channel.
      await ipc(pageA, 'acceptPairing', req1.requestId)
      expect((await getPairStateViaApi(pageB)).state).toBe('paired')
      expect((await getPairStateViaApi(pageA)).state).toBe('paired')

      // Post-pairing convergence on a covered edit path, both directions.
      const topic = 'e2e-pair-topic-1'
      const msg = 'e2e-pair-msg-1'
      const blk = 'e2e-pair-blk-1'
      await ensureTopicViaApi(pageA, topic, 'Pair Topic')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, 'pair hello'), [
        blockJson(blk, msg, 'pair hello')
      ])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForMessageContent(pageB, topic, msg, 'pair hello')
      await updateMessageViaApi(pageB, topic, msg, { content: 'pair edited' })
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      await pollForMessageContent(pageA, topic, msg, 'pair edited')
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('registration and membership survive app restart without re-pairing', async ({
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
      await pairProfilesViaApi(pageA, pageB)
      const codeBefore = (await getDeviceCodeViaApi(pageB)).deviceCode

      // Clean-close relaunch of B (same userDataDir): registration and
      // membership persist, sync resumes without re-pairing.
      profileB = await relaunchSecondSyncProfile(profileB, ownedTmpRoot, mockPort, {
        expectedEndpoint: relay.endpoint,
        expectedToken: RELAY_TOKEN,
        expectedEnabled: true
      })
      pageB = profileB.page
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      expect((await getDeviceCodeViaApi(pageB)).deviceCode).toBe(codeBefore)
      expect((await getPairStateViaApi(pageB)).state).toBe('paired')
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      // Restart stability: write stable data after relaunch and verify the
      // peer actually converges (ChatDb read), with drained pending, advanced
      // cursor, and no durable error — not just status.
      const topic = 'e2e-restart-stable-topic-1'
      const msg = 'e2e-restart-stable-msg-1'
      const blk = 'e2e-restart-stable-blk-1'
      const content = 'restart stable hello'
      const cursorBefore = (await getSyncStatusViaApi(pageB)).cursor
      await ensureTopicViaApi(pageA, topic, 'Restart Stable')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, content), [blockJson(blk, msg, content)])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForMessageContent(pageB, topic, msg, content)
      const statusA = await getSyncStatusViaApi(pageA)
      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusA.lastError).toBeNull()
      expect(statusB.lastError).toBeNull()
      expect(statusA.pendingCount).toBe(0)
      expect(statusB.pendingCount).toBe(0)
      expect(statusB.cursor).toBeGreaterThan(cursorBefore)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('disconnect stops attachment; connect resumes paired without reconfiguration', async ({
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
      await pairProfilesViaApi(pageA, pageB)
      const codeBefore = (await getDeviceCodeViaApi(pageB)).deviceCode

      await disconnectViaApi(pageB)
      const disc = await getServiceStatusViaApi(pageB)
      expect(disc.state).toBe('disconnected')
      expect(disc.explicitDisconnect).toBe(true)
      expect(disc.deviceCode).toBe(codeBefore)
      // Pairing actions are disabled while disconnected.
      await expect(ipc(pageB, 'unpair')).rejects.toThrow(/disconnect/i)

      // Re-connect re-attaches with the same credential: still paired, and
      // sync converges without any reconfiguration or repair.
      const reconnected = await connectViaApi(pageB)
      expect(reconnected.state).toBe('connected')
      expect((await getDeviceCodeViaApi(pageB)).deviceCode).toBe(codeBefore)
      expect((await getPairStateViaApi(pageB)).state).toBe('paired')
      const topic = 'e2e-reconnect-topic-1'
      const msg = 'e2e-reconnect-msg-1'
      const blk = 'e2e-reconnect-blk-1'
      await ensureTopicViaApi(pageA, topic, 'Reconnect Topic')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, 'reconnect hello'), [
        blockJson(blk, msg, 'reconnect hello')
      ])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForMessageContent(pageB, topic, msg, 'reconnect hello')
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('unpair preserves service attachment and local chats', async ({ mainWindow, ownedTmpRoot, mockPort }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await pairProfilesViaApi(pageA, pageB)

      const topic = 'e2e-unpair-topic-1'
      const msg = 'e2e-unpair-msg-1'
      const blk = 'e2e-unpair-blk-1'
      await ensureTopicViaApi(pageB, topic, 'Unpair Topic')
      await appendMessageViaApi(pageB, topic, messageJson(msg, topic, 'unpair hello'), [
        blockJson(blk, msg, 'unpair hello')
      ])
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      await pollForMessageContent(pageA, topic, msg, 'unpair hello')

      // Unpair B: service stays connected, local chats untouched.
      await unpairViaApi(pageB)
      expect((await getPairStateViaApi(pageB)).state).toBe('unpaired')
      const svc = await getServiceStatusViaApi(pageB)
      expect(svc.state).toBe('connected')
      expect(svc.deviceCode).not.toBeNull()
      const data = await fetchMessagesViaApi(pageB, topic)
      expect((data.messages as any[]).some((m) => m?.id === msg)).toBe(true)
      // Sync after unpair is refused (pairing-required), not silent success.
      const denied = await runSyncViaApi(pageB)
      expect(denied.threw).not.toBeNull()
      expect(String(denied.threw)).toContain('pairing-required')
      // The survivor dissolves to unpaired on next observation.
      expect((await getPairStateViaApi(pageA)).state).toBe('unpaired')
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('rejected request never pairs', async ({ mainWindow, ownedTmpRoot, mockPort }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await connectViaApi(pageA)
      await connectViaApi(pageB)
      const codeA = (await getDeviceCodeViaApi(pageA)).deviceCode as string
      const req = await ipc(pageB, 'requestPairing', { targetCode: codeA })
      await ipc(pageA, 'rejectPairing', req.requestId)
      expect((await getPairStateViaApi(pageB)).state).toBe('unpaired')
      const denied = await runSyncViaApi(pageB)
      expect(denied.threw).not.toBeNull()
      expect(String(denied.threw)).toContain('pairing-required')
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('third device joins the existing channel and observes its traffic', async ({
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
      await pairProfilesViaApi(pageA, pageB)

      // A raw third device joins A's channel through the production accept.
      const observer = await provisionObserverViaRaw(relay.endpoint, RELAY_TOKEN, pageA)
      const topic = 'e2e-join-topic-1'
      const msg = 'e2e-join-msg-1'
      const blk = 'e2e-join-blk-1'
      await ensureTopicViaApi(pageA, topic, 'Join Topic')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, 'join hello'), [
        blockJson(blk, msg, 'join hello')
      ])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      // The joiner observes the channel traffic from its own cursor origin.
      const deadline = Date.now() + 60000
      let seen = false
      while (Date.now() < deadline) {
        const res = await fetch(`${relay.endpoint}/sync/pull?cursor=0&deviceId=${encodeURIComponent('raw-observer')}`, {
          headers: {
            Authorization: `Bearer ${RELAY_TOKEN}`,
            'x-sync-device-code': observer.code,
            'x-sync-device-secret': observer.secret
          }
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { operations: any[] }
        if ((body.operations as any[]).some((o) => o?.entityId === msg)) {
          seen = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(seen).toBe(true)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('paired requester cannot initiate; late accept fails with no merge', async ({
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
      await connectViaApi(pageA)
      await connectViaApi(pageB)
      const codeA = (await getDeviceCodeViaApi(pageA)).deviceCode as string
      const codeB = (await getDeviceCodeViaApi(pageB)).deviceCode as string
      // B requests A while both are unpaired (stays pending).
      const pendingBA = await ipc(pageB, 'requestPairing', { targetCode: codeA })
      // A raw outsider requests B; B accepts and becomes paired first.
      const outReg = await fetch(`${relay.endpoint}/sync/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${RELAY_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      expect(outReg.status).toBe(200)
      const out = (await outReg.json()) as { deviceCode: string; deviceSecret: string }
      const reqOB = await fetch(`${relay.endpoint}/sync/pair/request`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RELAY_TOKEN}`,
          'Content-Type': 'application/json',
          'x-sync-device-code': out.deviceCode,
          'x-sync-device-secret': out.deviceSecret
        },
        body: JSON.stringify({ targetCode: codeB })
      })
      expect(reqOB.status).toBe(200)
      const reqOBBody = (await reqOB.json()) as { requestId: string }
      await ipc(pageB, 'acceptPairing', reqOBBody.requestId)
      expect((await getPairStateViaApi(pageB)).state).toBe('paired')
      // A's late accept of B's stale request fails terminally with no
      // membership change: B already paired, so the stale B->A intent was
      // replaced atomically when B paired (same accept transaction). The
      // existing acceptPairing API surfaces 410 request-replaced; the stale
      // intent never merges and is never revivable.
      let lateError: string | null = null
      try {
        await ipc(pageA, 'acceptPairing', pendingBA.requestId)
      } catch (e) {
        lateError = String((e as Error)?.message ?? e)
      }
      expect(lateError).not.toBeNull()
      expect(String(lateError)).toMatch(/410/)
      expect(String(lateError)).toMatch(/request-replaced/)
      const pairAAfter = await getPairStateViaApi(pageA)
      const pairBAfter = await getPairStateViaApi(pageB)
      expect(pairAAfter.state).toBe('unpaired')
      expect(pairBAfter.state).toBe('paired')
      // The old pending no longer surfaces via the existing pair-state API.
      expect(pairAAfter.incoming.some((r) => r.id === pendingBA.requestId)).toBe(false)
      expect(pairBAfter.outgoing).toBeNull()
      // B (now paired) cannot initiate another pairing: refused client-side.
      await expect(ipc(pageB, 'requestPairing', { targetCode: out.deviceCode })).rejects.toThrow(/already paired/i)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('two independent channels stay invisible with independent cursors', async ({
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
      await pairProfilesViaApi(pageA, pageB)

      // A second independent channel (two raw devices) carries its own traffic.
      const authed = { Authorization: `Bearer ${RELAY_TOKEN}`, 'Content-Type': 'application/json' }
      const reg = async (): Promise<{ code: string; secret: string }> => {
        const res = await fetch(`${relay!.endpoint}/sync/register`, {
          method: 'POST',
          headers: authed,
          body: JSON.stringify({})
        })
        const body = (await res.json()) as { deviceCode: string; deviceSecret: string }
        return { code: body.deviceCode, secret: body.deviceSecret }
      }
      const devC = await reg()
      const devD = await reg()
      const reqCD = await fetch(`${relay.endpoint}/sync/pair/request`, {
        method: 'POST',
        headers: { ...authed, 'x-sync-device-code': devD.code, 'x-sync-device-secret': devD.secret },
        body: JSON.stringify({ targetCode: devC.code })
      })
      expect(reqCD.status).toBe(200)
      const reqCDBody = (await reqCD.json()) as { requestId: string }
      const accCD = await fetch(`${relay.endpoint}/sync/pair/accept`, {
        method: 'POST',
        headers: { ...authed, 'x-sync-device-code': devC.code, 'x-sync-device-secret': devC.secret },
        body: JSON.stringify({ requestId: reqCDBody.requestId })
      })
      expect(accCD.status).toBe(200)
      const otherOp = {
        id: 'op-other-channel-1',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-other-1',
        timestamp: Date.now(),
        deviceId: 'raw-other',
        payload: { id: 't-other-1', name: 'Other' }
      }
      const pushOther = await fetch(`${relay.endpoint}/sync/push`, {
        method: 'POST',
        headers: { ...authed, 'x-sync-device-code': devC.code, 'x-sync-device-secret': devC.secret },
        body: JSON.stringify({ deviceId: 'raw-other', operations: [otherOp] })
      })
      expect(pushOther.status).toBe(200)
      expect(((await pushOther.json()) as { cursor: number }).cursor).toBe(1)

      // The apps' channel is unaffected: A/B sync converges with its own
      // contiguous cursor, and the foreign op never appears there.
      const statusBefore = await getSyncStatusViaApi(pageA)
      const topic = 'e2e-isolation-topic-1'
      const msg = 'e2e-isolation-msg-1'
      const blk = 'e2e-isolation-blk-1'
      await ensureTopicViaApi(pageA, topic, 'Isolation Topic')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, 'isolation hello'), [
        blockJson(blk, msg, 'isolation hello')
      ])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForMessageContent(pageB, topic, msg, 'isolation hello')
      const statusAfter = await getSyncStatusViaApi(pageA)
      expect(statusAfter.cursor).toBeGreaterThan(statusBefore.cursor)
      // No cross-channel leakage: the apps never observe the other op, and
      // the other channel never observes the apps' ops.
      const observer = await provisionObserverViaRaw(relay.endpoint, RELAY_TOKEN, pageA)
      const pullApps = await fetch(
        `${relay.endpoint}/sync/pull?cursor=0&deviceId=${encodeURIComponent('raw-observer')}`,
        {
          headers: {
            Authorization: `Bearer ${RELAY_TOKEN}`,
            'x-sync-device-code': observer.code,
            'x-sync-device-secret': observer.secret
          }
        }
      )
      const pullAppsBody = (await pullApps.json()) as { operations: any[]; cursor: number }
      expect((pullAppsBody.operations as any[]).some((o) => o?.id === 'op-other-channel-1')).toBe(false)
      const seqs = (pullAppsBody.operations as any[]).map((o) => o?.seq)
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      expect(new Set(seqs).size).toBe(seqs.length)
      const pullOther = await fetch(
        `${relay.endpoint}/sync/pull?cursor=0&deviceId=${encodeURIComponent('raw-other')}`,
        {
          headers: {
            Authorization: `Bearer ${RELAY_TOKEN}`,
            'x-sync-device-code': devD.code,
            'x-sync-device-secret': devD.secret
          }
        }
      )
      const pullOtherBody = (await pullOther.json()) as { operations: any[] }
      expect((pullOtherBody.operations as any[]).some((o) => o?.entityId === msg)).toBe(false)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })
})
