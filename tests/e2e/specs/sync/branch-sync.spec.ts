/**
 * True-branch sync E2E: branch create / owned-suffix / rename-edit / subtree
 * delete / v3 baseline bootstrap over the real two-profile + test-relay path.
 *
 * LOCK-BRANCH-E2E-001: only true-branch ChatDb IPC (createBranch,
 * listBranches, renameBranch, deleteBranch, fetchMessages with branchId,
 * appendMessage/updateMessage with branchId). No legacy clone-prefix
 * (branchMessagesToTopic) anywhere in this spec.
 * LOCK-BRANCH-E2E-002: relay is per-test, in-process, loopback-bound to an
 * ephemeral port, token-protected, fully closed/cleaned in teardown (same
 * contract as sync-two-profiles.spec.ts).
 * LOCK-BRANCH-E2E-003: profiles are independent children of the same owned
 * temp root with exact-token cleanup; no hand-rolled Electron launch and no
 * real/live profile.
 * LOCK-BRANCH-E2E-004: branch IPC has no page-object in tests/e2e/pages, so
 * every branch helper below is spec-local and narrowly typed. Shared fixture
 * (electron.fixture), shared utils (sync-relay, sync-second-profile) and the
 * existing sync.page helpers are reused as-is and never modified here.
 * LOCK-BRANCH-E2E-005: SyncService.publishBaseline has no production
 * IPC/preload/UI entry, and this spec adds none. Baseline publish happens
 * through the production automation (local-enqueue intent ->
 * publishBaselineIfEligible -> relay PUT) and is verified explicitly via an
 * authenticated relay GET plus the bootstrapping profile's converged state.
 * Cursor-0 bootstrap itself runs inside the existing SyncService.sync()
 * receiver path (fetch-before-push), triggered here through the existing
 * window.api.sync.sync() helper.
 */
import type { Page } from '@playwright/test'
import { createServer as createTcpServer } from 'node:net'

import { expect, test } from '../../fixtures/electron.fixture'
import {
  appendMessageViaApi,
  ensureTopicViaApi,
  getDeviceCodeViaApi,
  getSyncStatusViaApi,
  isoNow,
  pairProfilesViaApi,
  provisionObserverViaRaw,
  runSyncViaApi,
  setSyncConfigViaApi,
  topicExistsViaApi
} from '../../pages/sync.page'
import type { SecondSyncProfile } from '../../utils/sync-second-profile'
import { closeSecondSyncProfile, launchSecondSyncProfile } from '../../utils/sync-second-profile'
import type { TestRelayHandle } from '../../utils/sync-relay'
import { startTestRelay } from '../../utils/sync-relay'

const RELAY_TOKEN = 'e2e-branch-sync-token-1'

// Verified against packages/shared/sync/baselineWire.ts (actual source):
// WIRE_VERSION_V5 = 'sync-baseline-wire-v5',
// INVENTORY_VERSION_V5 = 'topic-message-stable-block-order-branch-assistant-attachment-v5'.
// Inlined (not imported) so this Playwright spec never pulls a Vitest-side
// module graph; the relay contract spec pins the same literals by import.
const BASELINE_WIRE_V5 = 'sync-baseline-wire-v5'
const BASELINE_INVENTORY_V5 = 'topic-message-stable-block-order-branch-assistant-attachment-v5'

// ---------------------------------------------------------------------------
// Narrow branch-IPC typings (spec-local; no `any` on owner differences)
// ---------------------------------------------------------------------------

type ChatDbMethod =
  | 'createBranch'
  | 'listBranches'
  | 'renameBranch'
  | 'deleteBranch'
  | 'appendMessage'
  | 'updateMessage'
  | 'fetchMessages'

interface WindowChatDb {
  api?: {
    chatDb?: Record<string, (request: unknown) => Promise<unknown>>
  }
}

async function invokeChatDb(page: Page, method: ChatDbMethod, request: unknown): Promise<unknown> {
  return await page.evaluate(
    ({ method: m, request: req }: { method: ChatDbMethod; request: unknown }) => {
      const w = window as unknown as WindowChatDb
      const fn = w.api?.chatDb?.[m]
      if (typeof fn !== 'function') throw new Error(`window.api.chatDb.${m} not found`)
      return fn(req)
    },
    { method, request }
  )
}

function unwrapOkValue(raw: unknown, source: string): unknown {
  if (!raw || typeof raw !== 'object') throw new Error(`${source} returned non-object`)
  const envelope = raw as Record<string, unknown>
  if (envelope.ok !== true) throw new Error(`${source} failed: ${JSON.stringify(envelope.error ?? null)}`)
  return envelope.value
}

export interface BranchWire {
  id: string
  topicId: string
  parentBranchId: string | null
  anchorMessageId: string
  name: string | null
}

function toBranchWire(raw: unknown, source: string): BranchWire {
  if (!raw || typeof raw !== 'object') throw new Error(`${source} branch is non-object`)
  const b = raw as Record<string, unknown>
  if (typeof b.id !== 'string' || b.id.length === 0) throw new Error(`${source} branch.id must be non-empty string`)
  if (typeof b.topicId !== 'string' || b.topicId.length === 0)
    throw new Error(`${source} branch.topicId must be non-empty string`)
  if (!(b.parentBranchId === null || (typeof b.parentBranchId === 'string' && b.parentBranchId.length > 0)))
    throw new Error(`${source} branch.parentBranchId must be string|null`)
  if (typeof b.anchorMessageId !== 'string' || b.anchorMessageId.length === 0)
    throw new Error(`${source} branch.anchorMessageId must be non-empty string`)
  if (!(typeof b.name === 'string' || b.name === null)) throw new Error(`${source} branch.name must be string|null`)
  return {
    id: b.id,
    topicId: b.topicId,
    parentBranchId: b.parentBranchId,
    anchorMessageId: b.anchorMessageId,
    name: b.name
  }
}

export interface RouteSnapshot {
  messageIds: string[]
  messageContent: Map<string, string | null>
  blockContent: Map<string, string | null>
}

function toRouteSnapshot(raw: unknown, source: string): RouteSnapshot {
  if (!raw || typeof raw !== 'object') throw new Error(`${source} value is non-object`)
  const v = raw as Record<string, unknown>
  if (!Array.isArray(v.messages) || !Array.isArray(v.blocks)) throw new Error(`${source} value shape invalid`)
  const messageIds: string[] = []
  const messageContent = new Map<string, string | null>()
  for (const m of v.messages) {
    if (!m || typeof m !== 'object') throw new Error(`${source} message is non-object`)
    const row = m as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id.length === 0) throw new Error(`${source} message.id invalid`)
    messageIds.push(row.id)
    if (!(typeof row.content === 'string' || row.content === null))
      throw new Error(`${source} message.content must be string|null`)
    messageContent.set(row.id, row.content)
  }
  const blockContent = new Map<string, string | null>()
  for (const b of v.blocks) {
    if (!b || typeof b !== 'object') throw new Error(`${source} block is non-object`)
    const row = b as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id.length === 0) throw new Error(`${source} block.id invalid`)
    if (typeof row.messageId !== 'string' || row.messageId.length === 0)
      throw new Error(`${source} block.messageId invalid`)
    if (!(typeof row.content === 'string' || row.content === null))
      throw new Error(`${source} block.content must be string|null`)
    blockContent.set(row.id, row.content)
  }
  return { messageIds, messageContent, blockContent }
}

async function createBranchViaApi(
  page: Page,
  args: { topicId: string; parentBranchId?: string | null; anchorMessageId: string; name?: string }
): Promise<BranchWire> {
  const value = unwrapOkValue(
    await invokeChatDb(page, 'createBranch', {
      topicId: args.topicId,
      parentBranchId: args.parentBranchId ?? null,
      anchorMessageId: args.anchorMessageId,
      name: args.name ?? null
    }),
    'createBranch'
  )
  if (!value || typeof value !== 'object' || !('branch' in value)) throw new Error('createBranch value.branch missing')
  return toBranchWire((value as Record<string, unknown>).branch, 'createBranch')
}

async function listBranchesViaApi(page: Page, topicId: string): Promise<BranchWire[]> {
  const value = unwrapOkValue(await invokeChatDb(page, 'listBranches', { topicId }), 'listBranches')
  if (!value || typeof value !== 'object' || !Array.isArray((value as Record<string, unknown>).branches))
    throw new Error('listBranches value.branches is not an array')
  return ((value as Record<string, unknown>).branches as unknown[]).map((b) => toBranchWire(b, 'listBranches'))
}

async function renameBranchViaApi(page: Page, topicId: string, branchId: string, name: string): Promise<BranchWire> {
  const value = unwrapOkValue(await invokeChatDb(page, 'renameBranch', { topicId, branchId, name }), 'renameBranch')
  if (!value || typeof value !== 'object' || !('branch' in value)) throw new Error('renameBranch value.branch missing')
  return toBranchWire((value as Record<string, unknown>).branch, 'renameBranch')
}

export interface DeleteBranchResult {
  deletedBranchIds: string[]
  deletedMessageIds: string[]
}

async function deleteBranchViaApi(page: Page, topicId: string, branchId: string): Promise<DeleteBranchResult> {
  const value = unwrapOkValue(await invokeChatDb(page, 'deleteBranch', { topicId, branchId }), 'deleteBranch')
  if (!value || typeof value !== 'object') throw new Error('deleteBranch value is non-object')
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.deletedBranchIds) || !Array.isArray(v.deletedMessageIds))
    throw new Error('deleteBranch deleted id arrays invalid')
  const strings = (arr: unknown[]): string[] =>
    arr.map((id) => {
      if (typeof id !== 'string' || id.length === 0) throw new Error('deleteBranch deleted id invalid')
      return id
    })
  return {
    deletedBranchIds: strings(v.deletedBranchIds as unknown[]),
    deletedMessageIds: strings(v.deletedMessageIds as unknown[])
  }
}

async function appendBranchMessageViaApi(
  page: Page,
  topicId: string,
  branchId: string,
  message: Record<string, unknown>,
  blocks: Record<string, unknown>[]
): Promise<void> {
  const raw = await invokeChatDb(page, 'appendMessage', { topicId, branchId, message, blocks })
  unwrapOkValue(raw, 'appendMessage(branch)')
}

async function updateBranchMessageViaApi(
  page: Page,
  topicId: string,
  branchId: string,
  messageId: string,
  updates: Record<string, unknown>
): Promise<void> {
  const raw = await invokeChatDb(page, 'updateMessage', { topicId, branchId, messageId, updates })
  unwrapOkValue(raw, 'updateMessage(branch)')
}

async function fetchRouteViaApi(page: Page, topicId: string, branchId: string | null): Promise<RouteSnapshot> {
  const raw = await invokeChatDb(page, 'fetchMessages', { topicId, branchId })
  return toRouteSnapshot(unwrapOkValue(raw, `fetchMessages(branch=${branchId ?? 'main'})`), 'fetchMessages')
}

// ---------------------------------------------------------------------------
// Deterministic message/block JSON (same stable shape as the MVP spec)
// ---------------------------------------------------------------------------

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
    type: 'main_text',
    content,
    status: 'success',
    createdAt: now,
    updatedAt: now
  }
}

// ---------------------------------------------------------------------------
// Spec-local polls and teardown (mirrors the MVP spec; shared files untouched)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollForRouteIds(
  page: Page,
  topicId: string,
  branchId: string | null,
  expected: string[],
  timeoutMs = 30000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const route = await fetchRouteViaApi(page, topicId, branchId)
    if (route.messageIds.length === expected.length && route.messageIds.every((id, i) => id === expected[i])) return
    last = `got=[${route.messageIds.join(',')}] expected=[${expected.join(',')}]`
    await sleep(500)
  }
  throw new Error(`route-ids timeout topic=${topicId} branch=${branchId ?? 'main'}: ${last}`)
}

async function pollForBranchName(
  page: Page,
  topicId: string,
  branchId: string,
  expectedName: string,
  timeoutMs = 90000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const branches = await listBranchesViaApi(page, topicId)
    const found = branches.find((b) => b.id === branchId)
    if (found && found.name === expectedName) return
    last = found ? `name-mismatch branches=${branches.length}` : `absent branches=${branches.length}`
    await sleep(500)
  }
  throw new Error(`branch-name timeout topic=${topicId} branch=${branchId}: ${last}`)
}

async function pollForRouteContent(
  page: Page,
  topicId: string,
  branchId: string | null,
  messageId: string,
  expectedContent: string,
  timeoutMs = 90000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const route = await fetchRouteViaApi(page, topicId, branchId)
    const actual = route.messageContent.get(messageId)
    if (actual === expectedContent) return
    last = actual === undefined ? 'absent' : 'content-mismatch'
    await sleep(500)
  }
  throw new Error(`route-content timeout topic=${topicId} branch=${branchId ?? 'main'} msg=${messageId}: ${last}`)
}

async function pollForBranchCatalogIds(
  page: Page,
  topicId: string,
  expectedSorted: string[],
  timeoutMs = 60000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const ids = (await listBranchesViaApi(page, topicId)).map((b) => b.id).sort()
    const want = [...expectedSorted].sort()
    if (ids.length === want.length && ids.every((id, i) => id === want[i])) return
    last = `got=[${ids.join(',')}]`
    await sleep(500)
  }
  throw new Error(`branch-catalog timeout topic=${topicId}: ${last}`)
}

async function pollForPendingDrained(page: Page, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const status = await getSyncStatusViaApi(page)
    if (status.pendingCount === 0 && status.lastError === null) return
    last = `pending=${status.pendingCount} error=${status.lastError}`
    await sleep(500)
  }
  throw new Error(`pending-drain timeout: ${last}`)
}

interface OfflineBlocker {
  endpoint: string
  close: () => Promise<void>
}

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
  if (errors.length > 1) throw new AggregateError(errors, 'branch sync E2E cleanup failed')
}

export interface RelayBaselineV3View {
  watermark: number
  inventoryVersion: string
  branchIds: string[]
  branchSuffixParents: string[]
}

async function pollForRelayBaselineV3(
  endpoint: string,
  token: string,
  observer: { code: string; secret: string },
  timeoutMs = 120000
): Promise<RelayBaselineV3View> {
  const deadline = Date.now() + timeoutMs
  let last = 'no-response'
  while (Date.now() < deadline) {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/sync/baseline`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-sync-device-code': observer.code,
        'x-sync-device-secret': observer.secret
      }
    })
    if (res.status === 200) {
      const body = (await res.json()) as Record<string, unknown>
      const wireVersion = body.wireVersion
      const watermark = body.watermark
      const payload = body.payload as Record<string, unknown> | null
      const inventoryVersion = payload?.inventoryVersion
      if (
        wireVersion === BASELINE_WIRE_V5 &&
        typeof watermark === 'number' &&
        Number.isSafeInteger(watermark) &&
        watermark > 0 &&
        payload !== null &&
        typeof payload === 'object' &&
        inventoryVersion === BASELINE_INVENTORY_V5 &&
        Array.isArray(payload.branches) &&
        Array.isArray(payload.orderFrames) &&
        Array.isArray(payload.topics) &&
        Array.isArray(payload.messages) &&
        Array.isArray(payload.messageBlocks) &&
        Array.isArray((payload as Record<string, unknown>).assistantConfigs) &&
        Array.isArray((payload as Record<string, unknown>).fileAssets)
      ) {
        const branchIds: string[] = []
        for (const b of payload.branches as unknown[]) {
          if (!b || typeof b !== 'object' || typeof (b as Record<string, unknown>).id !== 'string') {
            last = 'branch-wire-invalid'
            break
          }
          branchIds.push((b as Record<string, unknown>).id as string)
        }
        const branchSuffixParents: string[] = []
        for (const f of payload.orderFrames as unknown[]) {
          if (!f || typeof f !== 'object') continue
          const frame = f as Record<string, unknown>
          if (frame.kind === 'branchSuffix' && typeof frame.parentId === 'string') {
            branchSuffixParents.push(frame.parentId)
          }
        }
        // V5 completeness: manifest must be present and complete, all 3 domain arrays present (branch/assistant/attachment)
        const manifest = payload.manifest as Record<string, unknown> | undefined
        if (manifest?.completeness !== 'complete') {
          last = `manifest-incomplete`
        } else if (branchIds.length > 0 && branchSuffixParents.length > 0) {
          return { watermark, inventoryVersion: inventoryVersion as string, branchIds, branchSuffixParents }
        } else {
          last = `branches=${branchIds.length} suffixFrames=${branchSuffixParents.length}`
        }
      } else {
        last = `wire=${String(wireVersion)} wm=${String(watermark)} inv=${String(inventoryVersion)}`
      }
    } else {
      last = `status=${res.status}`
    }
    await sleep(1000)
  }
  throw new Error(`relay-baseline-v5 timeout: ${last}`)
}

test.describe('Branch sync two-profile real path', () => {
  test.setTimeout(300000)

  test('branch create and owned suffix converge with stable IDs and no prefix copy', async ({
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

      // A establishes the versioned main route: two main-owned messages.
      const topic = 'e2e-branch-topic-1'
      await ensureTopicViaApi(pageA, topic, 'Branch Topic One')
      await appendMessageViaApi(pageA, topic, messageJson('e2e-branch-m0', topic, 'branch main zero'), [
        blockJson('e2e-branch-k0', 'e2e-branch-m0', 'branch main zero')
      ])
      await appendMessageViaApi(pageA, topic, messageJson('e2e-branch-m1', topic, 'branch anchor one'), [
        blockJson('e2e-branch-k1', 'e2e-branch-m1', 'branch anchor one')
      ])

      // A forks one branch node at the stable anchor: no topic clone, no
      // message/block prefix copy.
      const created = await createBranchViaApi(pageA, {
        topicId: topic,
        parentBranchId: null,
        anchorMessageId: 'e2e-branch-m1',
        name: 'B1'
      })
      expect(created.topicId).toBe(topic)
      expect(created.parentBranchId).toBeNull()
      expect(created.anchorMessageId).toBe('e2e-branch-m1')
      expect(created.name).toBe('B1')
      const branchId = created.id
      const catalogA = await listBranchesViaApi(pageA, topic)
      expect(catalogA.map((b) => b.id)).toEqual([branchId])

      // Effective route on A: shared stable prefix through the anchor plus an
      // empty owned suffix; the main route is unchanged.
      await pollForRouteIds(pageA, topic, branchId, ['e2e-branch-m0', 'e2e-branch-m1'])
      await pollForRouteIds(pageA, topic, null, ['e2e-branch-m0', 'e2e-branch-m1'])

      // A appends one branch-owned suffix message (owner = the branch).
      await appendBranchMessageViaApi(
        pageA,
        topic,
        branchId,
        messageJson('e2e-branch-mb1', topic, 'branch owned suffix one'),
        [blockJson('e2e-branch-kb1', 'e2e-branch-mb1', 'branch owned suffix one')]
      )
      await pollForRouteIds(pageA, topic, branchId, ['e2e-branch-m0', 'e2e-branch-m1', 'e2e-branch-mb1'])
      await pollForRouteIds(pageA, topic, null, ['e2e-branch-m0', 'e2e-branch-m1'])

      // Manual rounds exchange the branch domain; B converges to the same
      // stable IDs, the same owner suffix, and the creation header name.
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForBranchCatalogIds(pageB, topic, [branchId])
      await pollForRouteIds(pageB, topic, branchId, ['e2e-branch-m0', 'e2e-branch-m1', 'e2e-branch-mb1'])
      await pollForRouteIds(pageB, topic, null, ['e2e-branch-m0', 'e2e-branch-m1'])
      const catalogB = await listBranchesViaApi(pageB, topic)
      expect(catalogB.find((b) => b.id === branchId)?.name).toBe('B1')
      expect(catalogB.find((b) => b.id === branchId)?.anchorMessageId).toBe('e2e-branch-m1')
      // Suffix block content converges on the branch route (not the main route).
      const routeB = await fetchRouteViaApi(pageB, topic, branchId)
      expect(routeB.blockContent.get('e2e-branch-kb1')).toBe('branch owned suffix one')
      const mainB = await fetchRouteViaApi(pageB, topic, null)
      expect(mainB.blockContent.has('e2e-branch-kb1')).toBe(false)
      // Single logical topic on both profiles: the branch fork created no
      // cloned topic and no duplicated prefix rows.
      expect(await topicExistsViaApi(pageA, topic)).toBe(true)
      expect(await topicExistsViaApi(pageB, topic)).toBe(true)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('offline branch rename and owned edit auto-converge without manual sync', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    let offlineBlocker: OfflineBlocker | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page

      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await pairProfilesViaApi(pageA, pageB)

      // Converged branch world first (manual rounds are setup only).
      const topic = 'e2e-branch-topic-2'
      await ensureTopicViaApi(pageA, topic, 'Branch Topic Two')
      await appendMessageViaApi(pageA, topic, messageJson('e2e-branch2-m0', topic, 'auto main zero'), [
        blockJson('e2e-branch2-k0', 'e2e-branch2-m0', 'auto main zero')
      ])
      await appendMessageViaApi(pageA, topic, messageJson('e2e-branch2-m1', topic, 'auto anchor one'), [
        blockJson('e2e-branch2-k1', 'e2e-branch2-m1', 'auto anchor one')
      ])
      const branchId = (
        await createBranchViaApi(pageA, {
          topicId: topic,
          parentBranchId: null,
          anchorMessageId: 'e2e-branch2-m1',
          name: 'AutoB'
        })
      ).id
      await appendBranchMessageViaApi(pageA, topic, branchId, messageJson('e2e-branch2-mb1', topic, 'auto owned one'), [
        blockJson('e2e-branch2-kb1', 'e2e-branch2-mb1', 'auto owned one')
      ])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForRouteIds(pageB, topic, branchId, ['e2e-branch2-m0', 'e2e-branch2-m1', 'e2e-branch2-mb1'])

      // Offline gate: A points at a test-owned unavailable endpoint, then
      // renames the branch header and edits the owned suffix message.
      offlineBlocker = await startOfflineBlocker()
      await setSyncConfigViaApi(pageA, { endpoint: offlineBlocker.endpoint, token: RELAY_TOKEN, enabled: true })
      const renamed = await renameBranchViaApi(pageA, topic, branchId, 'AutoB-renamed')
      expect(renamed.name).toBe('AutoB-renamed')
      await updateBranchMessageViaApi(pageA, topic, branchId, 'e2e-branch2-mb1', { content: 'auto owned edited' })
      await pollForRouteContent(pageA, topic, branchId, 'e2e-branch2-mb1', 'auto owned edited')

      // Manual sync fails truthfully with pending work retained.
      const failed = await runSyncViaApi(pageA)
      expect(failed.threw).not.toBeNull()
      const failedStatus = await getSyncStatusViaApi(pageA)
      expect(failedStatus.lastError).not.toBeNull()
      expect(failedStatus.pendingCount).toBeGreaterThan(0)

      // Restore the relay endpoint. From here recovery is automatic only: no
      // manual runSync is invoked on either profile afterwards.
      try {
        await offlineBlocker.close()
      } finally {
        offlineBlocker = null
      }
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })

      // A's automation drains the queued rename/edit; B's automation pulls
      // them via the relay hint. Both are asserted by polling only.
      await pollForPendingDrained(pageA, 90000)
      await pollForBranchName(pageB, topic, branchId, 'AutoB-renamed', 90000)
      await pollForRouteContent(pageB, topic, branchId, 'e2e-branch2-mb1', 'auto owned edited', 90000)
      await pollForRouteIds(pageB, topic, branchId, ['e2e-branch2-m0', 'e2e-branch2-m1', 'e2e-branch2-mb1'])
      // The main route never carries the branch-owned edit.
      await pollForRouteIds(pageB, topic, null, ['e2e-branch2-m0', 'e2e-branch2-m1'])
      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusB.lastError).toBeNull()
    } finally {
      await closeProfileAndRelay(profileB, relay, offlineBlocker)
    }
  })

  test('nested subtree delete keeps main, ancestor, sibling and owned messages', async ({
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

      // Main prefix plus a nested subtree (B2 under B1) and a sibling (B3).
      const topic = 'e2e-branch-topic-3'
      await ensureTopicViaApi(pageA, topic, 'Branch Topic Three')
      await appendMessageViaApi(pageA, topic, messageJson('e2e-branch3-m0', topic, 'subtree main zero'), [
        blockJson('e2e-branch3-k0', 'e2e-branch3-m0', 'subtree main zero')
      ])
      await appendMessageViaApi(pageA, topic, messageJson('e2e-branch3-m1', topic, 'subtree main one'), [
        blockJson('e2e-branch3-k1', 'e2e-branch3-m1', 'subtree main one')
      ])
      const b1 = (
        await createBranchViaApi(pageA, {
          topicId: topic,
          parentBranchId: null,
          anchorMessageId: 'e2e-branch3-m1',
          name: 'SubB1'
        })
      ).id
      await appendBranchMessageViaApi(pageA, topic, b1, messageJson('e2e-branch3-mb1', topic, 'subtree b1 suffix'), [
        blockJson('e2e-branch3-kb1', 'e2e-branch3-mb1', 'subtree b1 suffix')
      ])
      const b2 = (
        await createBranchViaApi(pageA, {
          topicId: topic,
          parentBranchId: b1,
          anchorMessageId: 'e2e-branch3-mb1',
          name: 'SubB2'
        })
      ).id
      await appendBranchMessageViaApi(pageA, topic, b2, messageJson('e2e-branch3-mb2', topic, 'subtree b2 suffix'), [
        blockJson('e2e-branch3-kb2', 'e2e-branch3-mb2', 'subtree b2 suffix')
      ])
      const b3 = (
        await createBranchViaApi(pageA, {
          topicId: topic,
          parentBranchId: null,
          anchorMessageId: 'e2e-branch3-m1',
          name: 'SubB3'
        })
      ).id
      await appendBranchMessageViaApi(pageA, topic, b3, messageJson('e2e-branch3-mb3', topic, 'subtree b3 suffix'), [
        blockJson('e2e-branch3-kb3', 'e2e-branch3-mb3', 'subtree b3 suffix')
      ])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForBranchCatalogIds(pageB, topic, [b1, b2, b3])
      await pollForRouteIds(pageB, topic, b2, [
        'e2e-branch3-m0',
        'e2e-branch3-m1',
        'e2e-branch3-mb1',
        'e2e-branch3-mb2'
      ])

      const cursorABefore = (await getSyncStatusViaApi(pageA)).cursor
      const cursorBBefore = (await getSyncStatusViaApi(pageB)).cursor

      // A deletes the B1 subtree: B1 + descendant B2 + their owned suffix
      // messages go; main, ancestor prefix, sibling B3 and its suffix stay.
      const deleted = await deleteBranchViaApi(pageA, topic, b1)
      expect([...deleted.deletedBranchIds].sort()).toEqual([b1, b2].sort())
      expect([...deleted.deletedMessageIds].sort()).toEqual(['e2e-branch3-mb1', 'e2e-branch3-mb2'].sort())
      await pollForBranchCatalogIds(pageA, topic, [b3])
      await pollForRouteIds(pageA, topic, null, ['e2e-branch3-m0', 'e2e-branch3-m1'])
      await pollForRouteIds(pageA, topic, b3, ['e2e-branch3-m0', 'e2e-branch3-m1', 'e2e-branch3-mb3'])

      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()

      // Tombstone propagation proof on B: subtree branches/messages absent,
      // main/ancestor/sibling routes byte-identical, cursors advanced.
      await pollForBranchCatalogIds(pageB, topic, [b3])
      await pollForRouteIds(pageB, topic, null, ['e2e-branch3-m0', 'e2e-branch3-m1'])
      await pollForRouteIds(pageB, topic, b3, ['e2e-branch3-m0', 'e2e-branch3-m1', 'e2e-branch3-mb3'])
      const statusA = await getSyncStatusViaApi(pageA)
      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusA.cursor).toBeGreaterThan(cursorABefore)
      expect(statusB.cursor).toBeGreaterThan(cursorBBefore)
      expect(statusA.pendingCount).toBe(0)
      expect(statusB.pendingCount).toBe(0)
      expect(statusA.lastError).toBeNull()
      expect(statusB.lastError).toBeNull()
      expect(await topicExistsViaApi(pageB, topic)).toBe(true)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('cursor-0 profile bootstraps the complete v3 branch domain from the relay baseline', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    let profileC: SecondSyncProfile | null = null
    const closeAll = async (): Promise<void> => {
      const errors: Error[] = []
      for (const profile of [profileC, profileB]) {
        try {
          await closeSecondSyncProfile(profile)
        } catch (e) {
          errors.push(e instanceof Error ? e : new Error(String(e)))
        } finally {
          if (profile === profileC) profileC = null
          else profileB = null
        }
      }
      try {
        await relay?.close()
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)))
      } finally {
        relay = null
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'branch baseline E2E cleanup failed')
    }
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await pairProfilesViaApi(pageA, pageB)

      // A builds the branch inventory; the op path converges B first.
      const topic = 'e2e-branch-topic-4'
      await ensureTopicViaApi(pageA, topic, 'Branch Topic Four')
      await appendMessageViaApi(pageA, topic, messageJson('e2e-branch4-m0', topic, 'baseline main zero'), [
        blockJson('e2e-branch4-k0', 'e2e-branch4-m0', 'baseline main zero')
      ])
      await appendMessageViaApi(pageA, topic, messageJson('e2e-branch4-m1', topic, 'baseline anchor one'), [
        blockJson('e2e-branch4-k1', 'e2e-branch4-m1', 'baseline anchor one')
      ])
      const branchId = (
        await createBranchViaApi(pageA, {
          topicId: topic,
          parentBranchId: null,
          anchorMessageId: 'e2e-branch4-m1',
          name: 'BaseB'
        })
      ).id
      await appendBranchMessageViaApi(
        pageA,
        topic,
        branchId,
        messageJson('e2e-branch4-mb1', topic, 'baseline owned suffix'),
        [blockJson('e2e-branch4-kb1', 'e2e-branch4-mb1', 'baseline owned suffix')]
      )
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollForRouteIds(pageB, topic, branchId, ['e2e-branch4-m0', 'e2e-branch4-m1', 'e2e-branch4-mb1'])

      // The production automation publishes the v3 baseline (local-enqueue
      // intent -> publishBaselineIfEligible -> relay PUT). Poll the relay
      // until it holds the full branch domain; no production publish IPC
      // exists or is added for this.
      const observer = await provisionObserverViaRaw(relay.endpoint, RELAY_TOKEN, pageA)
      const baseline = await pollForRelayBaselineV3(relay.endpoint, RELAY_TOKEN, observer)
      expect(baseline.branchIds).toContain(branchId)
      expect(baseline.branchSuffixParents).toContain(branchId)

      // Fresh receiver C joins the same channel (acceptor A already bound, so
      // C joins A's channel) with empty local state and cursor 0. Its first
      // sync takes the receiver-first baseline bootstrap path inside the
      // existing SyncService.sync() (fetch before push), proven below by the
      // relay's per-device baseline GET-200 counter plus the converged state.
      profileC = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageC = profileC.page
      await setSyncConfigViaApi(pageC, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await pairProfilesViaApi(pageA, pageC)
      const deviceC = await getDeviceCodeViaApi(pageC)
      if (!deviceC.deviceCode) throw new Error('receiver device code missing')
      expect((await runSyncViaApi(pageC)).threw).toBeNull()

      await pollForBranchCatalogIds(pageC, topic, [branchId])
      await pollForRouteIds(pageC, topic, branchId, ['e2e-branch4-m0', 'e2e-branch4-m1', 'e2e-branch4-mb1'])
      await pollForRouteIds(pageC, topic, null, ['e2e-branch4-m0', 'e2e-branch4-m1'])
      const catalogC = await listBranchesViaApi(pageC, topic)
      expect(catalogC.find((b) => b.id === branchId)?.name).toBe('BaseB')
      const routeC = await fetchRouteViaApi(pageC, topic, branchId)
      expect(routeC.blockContent.get('e2e-branch4-kb1')).toBe('baseline owned suffix')
      const statusC = await getSyncStatusViaApi(pageC)
      expect(statusC.cursor).toBeGreaterThanOrEqual(baseline.watermark)
      expect(statusC.pendingCount).toBe(0)
      expect(statusC.lastError).toBeNull()
      // Baseline-fetch proof (not op-replay convergence): C's device actually
      // pulled GET /sync/baseline 200 through the production sync path.
      expect(relay.getBaselineGet200CountForTests(deviceC.deviceCode)).toBeGreaterThanOrEqual(1)
    } finally {
      await closeAll()
    }
  })
})
