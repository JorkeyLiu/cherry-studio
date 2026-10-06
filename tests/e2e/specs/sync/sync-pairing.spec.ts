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
 * - zh-CN address-only connect shows the own device code plus the
 *   partner-code input with the expected waiting state before pairing; the
 *   header holds the enable switch, the server label reads 同步服务器地址,
 *   no token field exists, no HTTP banner appears for LAN HTTP, and one
 *   unknown-code request proves the controls fail closed.
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
  SyncSettingsPage,
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
import { waitForAppReady } from '../../utils/wait-helpers'

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

async function pollForPendingDrained(page: Page, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const s = await getSyncStatusViaApi(page)
    if (s.pendingCount === 0 && s.lastError === null) return
    last = `pending=${s.pendingCount} err=${s.lastError}`
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`pending-drain timeout: ${last}`)
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
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page

      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })

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
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      let pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
      await pairProfilesViaApi(pageA, pageB)
      const codeBefore = (await getDeviceCodeViaApi(pageB)).deviceCode

      // Clean-close relaunch of B (same userDataDir): registration and
      // membership persist, sync resumes without re-pairing.
      profileB = await relaunchSecondSyncProfile(profileB, ownedTmpRoot, mockPort, {
        expectedEndpoint: relay.endpoint,
        expectedEnabled: true
      })
      pageB = profileB.page
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
      expect((await getDeviceCodeViaApi(pageB)).deviceCode).toBe(codeBefore)
      expect((await getPairStateViaApi(pageB)).state).toBe('paired')
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForPendingDrained(pageA, 90000)
      await pollForPendingDrained(pageB, 90000)
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
      await pollForPendingDrained(pageA, 90000)
      await pollForPendingDrained(pageB, 90000)
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
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
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
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
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
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
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
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
      await pairProfilesViaApi(pageA, pageB)

      // A raw third device joins A's channel through the production accept.
      const observer = await provisionObserverViaRaw(relay.endpoint, pageA)
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
          headers: { 'x-sync-device-code': observer.code, 'x-sync-device-secret': observer.secret }
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
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
      await connectViaApi(pageA)
      await connectViaApi(pageB)
      const codeA = (await getDeviceCodeViaApi(pageA)).deviceCode as string
      const codeB = (await getDeviceCodeViaApi(pageB)).deviceCode as string
      // B requests A while both are unpaired (stays pending).
      const pendingBA = await ipc(pageB, 'requestPairing', { targetCode: codeA })
      // A raw outsider requests B; B accepts and becomes paired first.
      const outReg = await fetch(`${relay.endpoint}/sync/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      expect(outReg.status).toBe(200)
      const out = (await outReg.json()) as { deviceCode: string; deviceSecret: string }
      const reqOB = await fetch(`${relay.endpoint}/sync/pair/request`, {
        method: 'POST',
        headers: {
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
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
      await pairProfilesViaApi(pageA, pageB)

      // A second independent channel (two raw devices) carries its own traffic.
      const jsonHeaders = { 'Content-Type': 'application/json' }
      const reg = async (): Promise<{ code: string; secret: string }> => {
        const res = await fetch(`${relay!.endpoint}/sync/register`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({})
        })
        const body = (await res.json()) as { deviceCode: string; deviceSecret: string }
        return { code: body.deviceCode, secret: body.deviceSecret }
      }
      const devC = await reg()
      const devD = await reg()
      const reqCD = await fetch(`${relay.endpoint}/sync/pair/request`, {
        method: 'POST',
        headers: { 'x-sync-device-code': devD.code, 'x-sync-device-secret': devD.secret },
        body: JSON.stringify({ targetCode: devC.code })
      })
      expect(reqCD.status).toBe(200)
      const reqCDBody = (await reqCD.json()) as { requestId: string }
      const accCD = await fetch(`${relay.endpoint}/sync/pair/accept`, {
        method: 'POST',
        headers: { 'x-sync-device-code': devC.code, 'x-sync-device-secret': devC.secret },
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
        headers: { 'x-sync-device-code': devC.code, 'x-sync-device-secret': devC.secret },
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
      const observer = await provisionObserverViaRaw(relay.endpoint, pageA)
      const pullApps = await fetch(
        `${relay.endpoint}/sync/pull?cursor=0&deviceId=${encodeURIComponent('raw-observer')}`,
        {
          headers: { 'x-sync-device-code': observer.code, 'x-sync-device-secret': observer.secret }
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
          headers: { 'x-sync-device-code': devD.code, 'x-sync-device-secret': devD.secret }
        }
      )
      const pullOtherBody = (await pullOther.json()) as { operations: any[] }
      expect((pullOtherBody.operations as any[]).some((o) => o?.entityId === msg)).toBe(false)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('zh-CN address-only connect shows code, waits, then pairs via request/accept', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    test.setTimeout(180000)
    // Start in zh-CN through the app's own persisted language path. A fresh
    // profile defaults Redux settings.language to navigator.language (en-US),
    // which useAppInit then applies over bare localStorage, so localStorage
    // alone leaves the UI in English. Mirror the production GeneralSettings
    // language path coherently after reload: Redux + persisted storage +
    // preload, then let the app's own language effect drive i18n.
    await mainWindow.evaluate(() => {
      window.localStorage.setItem('language', 'zh-CN')
    })
    await mainWindow.reload()
    await waitForAppReady(mainWindow)

    await mainWindow.evaluate(async () => {
      window.localStorage.setItem('language', 'zh-CN')
      ;(window as any).store?.dispatch({ type: 'settings/setLanguage', payload: 'zh-CN' })
      try {
        await (window as any).api?.setLanguage?.('zh-CN')
      } catch {}
    })
    await waitForAppReady(mainWindow)

    const page = mainWindow
    const syncPage = new SyncSettingsPage(page)
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    try {
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      const endpoint = relay.endpoint
      // Address-only configuration on both disposable profiles: no shared
      // token exists anywhere in this flow.
      await setSyncConfigViaApi(page, { endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint, enabled: true })
      await syncPage.openSync()
      await syncPage.waitForHydrated()

      // No token field exists anywhere on the page.
      await expect(page.getByTestId('sync-token-input')).toHaveCount(0)

      // Prove zh-CN is actually rendered: the Connect control must read
      // 连接, not Connect. Ant Design inserts a space between two CJK
      // characters in Buttons ("连 接"), so match whitespace-tolerantly
      // while still requiring both Chinese characters (not English).
      await expect(syncPage.connectButton).toContainText(/连\s*接/)

      // Address-only connect: service attached with the own device code
      // visible and the partner-code input offered for request -> accept.
      await syncPage.connectButton.click()
      await expect(syncPage.serviceStatus).toContainText('已连接')
      await expect(syncPage.deviceCode).toBeVisible()
      await expect(syncPage.targetCodeInput).toBeVisible()

      // Expected waiting before pairing (not a failure): the pairing pill
      // reads 未配对 and the data badge reads 等待配对; manual sync stays
      // disabled. Waiting-only explanatory hints were removed: neither hint
      // node renders.
      await expect(syncPage.pairingPill).toContainText('未配对')
      await expect(syncPage.statusBadge).toContainText('等待配对')
      await expect(page.getByTestId('sync-now-button')).toBeDisabled()
      await expect(page.getByTestId('sync-pairing-required-hint')).toHaveCount(0)
      await expect(page.getByTestId('sync-waiting-hint')).toHaveCount(0)

      // The device code is plain text: it is a span, not a button or
      // link, and carries no tooltip. Only the independent copy button
      // copies the exact public code (no secret material).
      await expect(syncPage.deviceCode).toBeVisible()
      const deviceKind = await syncPage.deviceCode.evaluate((el) => ({
        tag: (el as HTMLElement).tagName,
        role: (el as HTMLElement).getAttribute('role'),
        title: (el as HTMLElement).getAttribute('title')
      }))
      expect(deviceKind.tag).toBe('SPAN')
      expect(deviceKind.role).toBeNull()
      expect(deviceKind.title).toBeNull()
      const deviceCodeCopy = page.getByTestId('sync-device-code-copy')
      await expect(deviceCodeCopy).toBeVisible()
      await expect(deviceCodeCopy).toHaveAttribute('aria-label', /.+/)
      // Scoped to the device-code row only: no question-mark help lives
      // beside the code, while other sync help stays available.
      const deviceRowHasHelp = await page.evaluate(() => {
        const code = document.querySelector('[data-testid="sync-device-code"]')
        const row = code?.parentElement
        return row ? row.querySelector('[role="img"]') !== null : false
      })
      expect(deviceRowHasHelp).toBe(false)
      await expect(page.getByTestId('sync-title-bar')).toContainText('同步')
      const expectedCode = (await getDeviceCodeViaApi(page)).deviceCode as string
      expect(expectedCode).toBeTruthy()
      const marker = 'e2e-sync-copy-marker'
      let priorClipboard: string | null = null
      try {
        priorClipboard = await page.evaluate(async () => {
          try {
            if ((window as any).api?.clipboard?.readText) {
              return await (window as any).api.clipboard.readText()
            }
            return await navigator.clipboard.readText()
          } catch {
            return null
          }
        })
        await page.evaluate(async (text: string) => {
          try {
            if ((window as any).api?.clipboard?.writeText) {
              await (window as any).api.clipboard.writeText(text)
              return
            }
            await navigator.clipboard.writeText(text)
          } catch {}
        }, marker)
        // Clicking the plain code text copies nothing: the marker survives.
        await syncPage.deviceCode.click()
        await page.waitForTimeout(300)
        const afterCodeClick = await page.evaluate(async () => {
          try {
            if ((window as any).api?.clipboard?.readText) {
              return await (window as any).api.clipboard.readText()
            }
            return await navigator.clipboard.readText()
          } catch {
            return null
          }
        })
        expect(afterCodeClick).toBe(marker)
        // The independent copy button copies exactly the public code.
        await deviceCodeCopy.click()
        let clipboardCode: string | null = null
        for (let attempt = 0; attempt < 15; attempt++) {
          clipboardCode = await page.evaluate(async () => {
            try {
              if ((window as any).api?.clipboard?.readText) {
                return await (window as any).api.clipboard.readText()
              }
              return await navigator.clipboard.readText()
            } catch {
              return null
            }
          })
          if (clipboardCode === expectedCode) break
          await page.waitForTimeout(200)
        }
        expect(clipboardCode).toBe(expectedCode)
      } finally {
        await page.evaluate(async (text: string | null) => {
          const restore = typeof text === 'string' ? text : 'e2e-sync-copy-marker'
          try {
            if ((window as any).api?.clipboard?.writeText) {
              await (window as any).api.clipboard.writeText(restore)
              return
            }
            await navigator.clipboard.writeText(restore)
          } catch {}
        }, priorClipboard)
      }

      // Polished header: the enable switch lives in the title bar (far
      // right of 同步) with the sync-scoped accessible name, and the
      // server address uses the fixed wording.
      await expect(syncPage.titleBar).toContainText('同步')
      await expect(syncPage.titleBar.getByTestId('sync-enabled-switch')).toBeVisible()
      await expect(page.getByText('同步服务器地址')).toBeVisible()
      await expect(syncPage.servicePill).toContainText('已连接')

      // No HTTP banner for a LAN HTTP endpoint: HTTP and HTTPS are
      // accepted identically. Restore the fixture endpoint afterwards.
      await syncPage.fillEndpointAndBlur('http://192.168.1.10:3030')
      await expect(page.getByTestId('sync-http-warning')).toHaveCount(0)
      await syncPage.fillEndpointAndBlur(endpoint)
      await expect(page.getByTestId('sync-http-warning')).toHaveCount(0)

      // Bounded control proof: a pairing request against an unknown code
      // fails closed with a visible error (no state change, no secrets).
      // B is connected but never involved, so it stays unpaired.
      await connectViaApi(pageB)
      await syncPage.targetCodeInput.fill('EEEE0000')
      await page.getByTestId('sync-request-pairing').click()
      await expect(syncPage.pairingError).toBeVisible()
      expect((await getPairStateViaApi(pageB)).state).toBe('unpaired')

      // Real request -> accept across the two disposable profiles: B's
      // public code goes into A's rendered input; B accepts via IPC.
      const codeB = (await getDeviceCodeViaApi(pageB)).deviceCode as string
      await syncPage.targetCodeInput.fill(codeB)
      await page.getByTestId('sync-request-pairing').click()
      await expect(syncPage.pairingPill).toContainText('请求待处理')
      let incomingId = ''
      await expect
        .poll(
          async () => {
            const state = await getPairStateViaApi(pageB)
            incomingId = state.incoming[0]?.id ?? ''
            return incomingId
          },
          { timeout: 30000 }
        )
        .not.toBe('')
      await pageB.evaluate(async (requestId: string) => {
        return await (window as any).api.sync.acceptPairing(requestId)
      }, incomingId)
      await expect(syncPage.pairingPill).toContainText('已配对')

      // Post-pairing convergence on a covered edit path (both directions).
      const topic = 'e2e-zhcn-pair-topic-1'
      const msg = 'e2e-zhcn-pair-msg-1'
      const blk = 'e2e-zhcn-pair-blk-1'
      await ensureTopicViaApi(page, topic, 'Zh Pair Topic')
      await appendMessageViaApi(page, topic, messageJson(msg, topic, 'zh pair hello'), [
        blockJson(blk, msg, 'zh pair hello')
      ])
      expect((await runSyncViaApi(page)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForMessageContent(pageB, topic, msg, 'zh pair hello')
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })
})
