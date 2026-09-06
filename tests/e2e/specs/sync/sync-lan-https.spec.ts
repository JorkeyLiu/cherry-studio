/**
 * Native LAN HTTPS relay E2E: two real profiles through the user entrypoint
 * (`scripts/sync-relay/server.ts`) bound to a dynamically discovered
 * non-loopback LAN address with relay-native HTTPS.
 *
 * Disposable self-signed server cert carries SAN IP:<LAN-host>; both app
 * profiles launch with explicit CA trust (`NODE_EXTRA_CA_CERTS` pointing at
 * the disposable cert — no verification bypass anywhere), and the spec
 * process verifies relay reads with explicit `ca` trust. Pairing/trust uses
 * the production flow, convergence uses production IPC ChatDb state, restart
 * reuses the same DB/cert/key/token, and cleanup deletes only the disposable
 * owned root. Skips truthfully when no suitable non-loopback interface (or
 * no openssl to mint the disposable cert) is available; never hardcodes a
 * user-specific IP. No WAN, rotation, backup, or capacity claim.
 */
import type { Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { get as httpsGet, request as httpsRequest } from 'node:https'
import { networkInterfaces } from 'node:os'
import * as path from 'node:path'

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

const RELAY_TOKEN = 'e2e-lan-https-token-1'

function discoverLanIpv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a?.family === 'IPv4' && !a.internal && a.address !== '127.0.0.1') return a.address
    }
  }
  return null
}

function mintServerCert(root: string, host: string): { certPath: string; keyPath: string } {
  const keyPath = path.join(root, 'lan-https.key.pem')
  const certPath = path.join(root, 'lan-https.cert.pem')
  const res = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-nodes',
      '-subj',
      `/CN=${host}`,
      '-addext',
      `subjectAltName=IP:${host}`
    ],
    { timeout: 60000, encoding: 'utf8' }
  )
  if (res.status !== 0 || !fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error(`openssl cert mint failed: ${String(res.error ?? res.stderr).slice(0, 200)}`)
  }
  return { certPath, keyPath }
}

interface HttpsResult {
  status: number
  body: any
}

function httpsJson(
  endpoint: string,
  method: string,
  pathname: string,
  caPath: string,
  headers: Record<string, string> = {},
  payload?: unknown
): Promise<HttpsResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const data = payload === undefined ? undefined : JSON.stringify(payload)
    const url = new URL(pathname, endpoint)
    const req = httpsRequest(
      url,
      {
        method,
        ca: fs.readFileSync(caPath),
        timeout: 10000,
        headers: {
          ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers
        }
      },
      (incoming) => {
        let text = ''
        incoming.on('data', (c: Buffer) => {
          text += c.toString('utf8')
        })
        incoming.on('end', () => {
          try {
            resolvePromise({ status: incoming.statusCode ?? 0, body: text ? JSON.parse(text) : {} })
          } catch (e) {
            rejectPromise(e)
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('https request timeout')))
    req.on('error', rejectPromise)
    if (data === undefined) req.end()
    else req.end(data)
  })
}

function httpsHealthOk(endpoint: string, caPath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const req = httpsGet(`${endpoint}/health`, { ca: fs.readFileSync(caPath), timeout: 10000 }, (incoming) => {
      let text = ''
      incoming.on('data', (c: Buffer) => {
        text += c.toString('utf8')
      })
      incoming.on('end', () => {
        try {
          resolvePromise(incoming.statusCode === 200 && (JSON.parse(text) as { ok?: unknown }).ok === true)
        } catch {
          resolvePromise(false)
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolvePromise(false)
    })
    req.on('error', () => resolvePromise(false))
  })
}

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

async function closeRelayAndProfiles(
  relay: UserEntrypointRelayHandle | null,
  profiles: Array<SecondSyncProfile | null>
): Promise<void> {
  const errors: Error[] = []
  if (relay) {
    try {
      await relay.close()
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)))
    }
    try {
      if (relay.isRunning()) errors.push(new Error('sync lan-https cleanup: owned relay child still live'))
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)))
    }
    try {
      assertNoUnresolvedRelayCleanup('sync lan-https E2E cleanup')
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)))
    }
  }
  for (const p of profiles) {
    if (!p) continue
    try {
      await closeSecondSyncProfile(p)
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)))
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'sync lan-https E2E cleanup failed')
}

test.describe('Sync native LAN HTTPS relay', () => {
  test.setTimeout(300000)

  test('two profiles pair, sync, survive relay restart, and recover after short interruption over LAN HTTPS', async ({
    ownedTmpRoot,
    mockPort
  }) => {
    const lanHost = discoverLanIpv4()
    test.skip(lanHost === null, 'no suitable non-loopback IPv4 interface available for the LAN HTTPS path')
    const host = lanHost as string
    let certPaths: { certPath: string; keyPath: string } | null = null
    try {
      certPaths = mintServerCert(ownedTmpRoot, host)
    } catch (e) {
      test.skip(
        true,
        `cannot mint disposable LAN cert (openssl unavailable?): ${String((e as Error).message).slice(0, 160)}`
      )
      return
    }
    const { certPath, keyPath } = certPaths
    // Explicit CA trust for both app profiles BEFORE either app process is
    // launched (audit blocker fix): the disposable CA path is injected via
    // the narrow launch-env hook (extraEnv) plus process.env snapshot, both
    // set before launchSecondSyncProfile spawns. No verification bypass,
    // no security change, no post-launch process.env mutation claim.
    expect(fs.existsSync(certPath)).toBe(true)
    expect(fs.existsSync(keyPath)).toBe(true)
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '').not.toBe('0')
    const launchCaEnv: Record<string, string> = { NODE_EXTRA_CA_CERTS: certPath }
    const prevCa = process.env.NODE_EXTRA_CA_CERTS
    process.env.NODE_EXTRA_CA_CERTS = certPath
    // Deterministic setup evidence: the launch environment for both profiles
    // includes the CA path before any app process starts.
    expect(launchCaEnv.NODE_EXTRA_CA_CERTS).toBe(certPath)
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(certPath)
    let relay: UserEntrypointRelayHandle | null = null
    let profileA: SecondSyncProfile | null = null
    let profileB: SecondSyncProfile | null = null
    let testError: unknown = null
    try {
      validateOwnedRoot(ownedTmpRoot)
      try {
        relay = await startUserEntrypointRelay({
          ownedTmpRoot,
          token: RELAY_TOKEN,
          host,
          certPath,
          keyPath,
          caPath: certPath
        })
      } catch (e) {
        relay = getUserRelayHandle(e) ?? relay
        throw e
      }
      // User-entrypoint proof: native HTTPS readiness on the LAN host,
      // disposable DB under the owned root, explicit token (not env-only).
      expect(relay.endpoint.startsWith(`https://${host}:`)).toBe(true)
      expect(relay.dbPath.startsWith(ownedTmpRoot)).toBe(true)
      expect(relay.token).toBe(RELAY_TOKEN)
      expect(fs.existsSync(relay.dbPath)).toBe(true)
      expect(await httpsHealthOk(relay.endpoint, certPath)).toBe(true)

      profileA = await launchSecondSyncProfile(ownedTmpRoot, mockPort, launchCaEnv)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort, launchCaEnv)
      // Both real application processes were spawned with the CA in their
      // launch environment (pre-launch injection, not post-launch mutation).
      expect(launchCaEnv.NODE_EXTRA_CA_CERTS).toBe(certPath)
      expect(process.env.NODE_EXTRA_CA_CERTS).toBe(certPath)
      const pageA = profileA.page
      const pageB = profileB.page
      const endpoint = relay.endpoint

      await setSyncConfigViaApi(pageA, { endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint, token: RELAY_TOKEN, enabled: true })
      await pairProfilesViaApi(pageA, pageB)
      // Independent trusted observer proves retained trust/operations/cursor.
      const invite = await pageA.evaluate(async () => await (window as any).api.sync.createInvite())
      if (!invite || typeof invite.code !== 'string') throw new Error('observer pairing: invite missing')
      const reqRes = await httpsJson(
        endpoint,
        'POST',
        '/sync/pair/request',
        certPath,
        { Authorization: `Bearer ${RELAY_TOKEN}` },
        { deviceId: 'e2e-lan-https-observer', code: invite.code }
      )
      if (reqRes.status !== 200) throw new Error(`observer pairing: request ${reqRes.status}`)
      if (typeof reqRes.body.requestId !== 'string' || typeof reqRes.body.deviceAuth !== 'string') {
        throw new Error('observer pairing: malformed response')
      }
      const observer = { deviceId: 'e2e-lan-https-observer', deviceAuth: reqRes.body.deviceAuth as string }
      await pageA.evaluate(
        async (requestId: string) => await (window as any).api.sync.acceptPairing(requestId),
        reqRes.body.requestId as string
      )
      const authedPull = async (cursor: number): Promise<{ status: number; body: any }> =>
        await httpsJson(
          endpoint,
          'GET',
          `/sync/pull?cursor=${cursor}&deviceId=${encodeURIComponent(observer.deviceId)}`,
          certPath,
          {
            Authorization: `Bearer ${RELAY_TOKEN}`,
            'x-sync-device-id': observer.deviceId,
            'x-sync-device-auth': observer.deviceAuth
          }
        )

      const topic = 'e2e-lan-https-topic-1'
      const msg = 'e2e-lan-https-msg-1'
      const blk = 'e2e-lan-https-blk-1'
      const base = 'lan https baseline one'
      await ensureTopicViaApi(pageA, topic, 'LAN HTTPS Topic')
      await appendMessageViaApi(pageA, topic, messageJson(msg, topic, base), [blockJson(blk, msg, base)])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForConvergence(pageB, topic, msg, blk, base)

      const baseline = await authedPull(0)
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

      // Short interruption: stop the relay (DB/cert/key/token retained).
      await relay.stop()
      expect(relay.isRunning()).toBe(false)
      expect(fs.existsSync(relay.dbPath)).toBe(true)
      expect(await httpsHealthOk(endpoint, certPath)).toBe(false)

      const edited = 'lan https edited content one'
      await updateMessageViaApi(pageA, topic, msg, { content: edited })
      await pollForMessageContent(pageA, topic, msg, edited, 30000)
      const failed = await runSyncViaApi(pageA)
      expect(failed.threw).not.toBeNull()
      const failedStatus = await getSyncStatusViaApi(pageA)
      expect(failedStatus.lastError).not.toBeNull()
      expect(failedStatus.pendingCount).toBeGreaterThan(0)
      expect(failedStatus.cursor).toBe(cursorA0)
      expect((await getSyncStatusViaApi(pageB)).cursor).toBe(cursorB0)

      // Restart the same entrypoint against the same DB/cert/key/token.
      await relay.restart()
      expect(relay.isRunning()).toBe(true)
      expect(relay.endpoint).toBe(endpoint)
      expect(await httpsHealthOk(endpoint, certPath)).toBe(true)

      // Retained trust/operations/cursor: the paired observer still verifies
      // (no re-pairing) and the log is contiguous from cursor 0.
      const retained = await authedPull(0)
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
      await closeRelayAndProfiles(relay, [profileA, profileB])
    } catch (cleanupError) {
      const mainErr = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
      if (testError) {
        throw new AggregateError(
          [testError instanceof Error ? testError : new Error(String(testError)), mainErr],
          'sync lan-https test and cleanup failed'
        )
      }
      throw mainErr
    } finally {
      if (prevCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS
      else process.env.NODE_EXTRA_CA_CERTS = prevCa
    }
    if (testError) throw testError
  })
})
