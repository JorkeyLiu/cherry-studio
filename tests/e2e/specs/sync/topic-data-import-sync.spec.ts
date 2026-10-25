/**
 * Topic-data JSON import SYNC E2E — two isolated profiles over a per-test
 * loopback relay.
 *
 * Durable asset guarding the synced full-topic import workflow:
 * - A topic exported through the production `exportTopicData` capability (main
 *   route + one internal branch + a supported local attachment) is imported
 *   through the production `importTopicData` capability on the source profile,
 *   then converges on the peer with the EXACT main-route order, the EXACT
 *   branch catalog (parent + anchor) and the EXACT branch route order
 *   (shared prefix through the anchor + branch-owned suffix) — ordering is
 *   asserted, never counts.
 * - The supported attachment identity survives the import and its BYTES are
 *   available on the peer (read back from the receiver file store), so an
 *   availability/count-only claim cannot pass.
 * - A reference-target export (materialized foreign prefix) imports as fully
 *   target-owned rows with FRESH ids and recreates NO live relation; that
 *   "no relation" posture survives the sync to the peer (still no relation
 *   metadata, no divider, and every materialized row stays mutable/owned
 *   instead of read-only foreign prefix).
 *
 * Evidence classes: production ChatDb IPC reads (`exportTopicData`,
 * `importTopicData`, `fetchMessages` per route, `listBranches`,
 * `topicExists`), file-store byte reads on the receiver, Redux projection
 * snapshots of the peer resident window, rendered message containers, and real
 * sync rounds through `window.api.sync.sync()`.
 *
 * Standard shared fixture, two independent disposable profiles under the same
 * owned temp root, mocked external providers, deterministic assertions,
 * fixture-owned cleanup. Newly created fixture data only.
 */
import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/electron.fixture'
import {
  appendMessageViaApi,
  ensureTopicViaApi,
  isoNow,
  pairProfilesViaApi,
  runSyncViaApi,
  setSyncConfigViaApi,
  topicExistsViaApi
} from '../../pages/sync.page'
import { startTestRelay, type TestRelayHandle } from '../../utils/sync-relay'
import {
  closeSecondSyncProfile,
  launchSecondSyncProfile,
  type SecondSyncProfile
} from '../../utils/sync-second-profile'

const DISPLAY_LIMIT = 20

// ---------------------------------------------------------------------------
// Spec-local narrow IPC typing (no shared helper is modified by this asset)
// ---------------------------------------------------------------------------

async function invokeChatDb(page: Page, method: string, request: unknown): Promise<unknown> {
  return await page.evaluate(
    ({ method: m, request: req }: { method: string; request: unknown }) => {
      const w = window as unknown as { api?: { chatDb?: Record<string, (r: unknown) => Promise<unknown>> } }
      const fn = w.api?.chatDb?.[m]
      if (typeof fn !== 'function') throw new Error(`window.api.chatDb.${m} not found`)
      return fn(req)
    },
    { method, request }
  )
}

function unwrapOk(raw: unknown, source: string): unknown {
  if (!raw || typeof raw !== 'object') throw new Error(`${source} returned non-object`)
  const envelope = raw as Record<string, unknown>
  if (envelope.ok !== true) throw new Error(`${source} failed: ${JSON.stringify(envelope.error ?? null)}`)
  return envelope.value
}

// ---------------------------------------------------------------------------
// Wire shapes (mirror the production contracts this asset reads)
// ---------------------------------------------------------------------------

interface ExportPayload {
  format: string
  version: number
  messages: Array<Record<string, unknown>>
  blocks: Array<Record<string, unknown>>
  branches: Array<Record<string, unknown>>
  segments: Array<Record<string, unknown>>
  fileReferences: Array<Record<string, unknown>>
  historySnapshot?: { status: 'materialized' | 'missing' }
}

interface RouteView {
  ids: string[]
  contents: string[]
  blocks: Array<Record<string, unknown>>
}

interface BranchWire {
  id: string
  parentBranchId: string | null
  anchorMessageId: string
  name: string | null
}

interface ImportResult {
  topicId: string
  messageCount: number
  blockCount: number
  branchCount: number
  segmentCount: number
  fileReferenceCount: number
}

// ---------------------------------------------------------------------------
// Deterministic message/block JSON
// ---------------------------------------------------------------------------

function messageJson(
  id: string,
  topicId: string,
  role: 'user' | 'assistant',
  content: string,
  assistantId: string,
  askId?: string
): Record<string, unknown> {
  const now = isoNow()
  const message: Record<string, unknown> = {
    id,
    topicId,
    role,
    assistantId,
    content,
    status: 'success',
    createdAt: now,
    updatedAt: now
  }
  if (askId) message.askId = askId
  return message
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

/** Supported local file block: a real FILE attachment with a real local byte payload. */
function fileBlockJson(
  id: string,
  messageId: string,
  file: { id: string; name: string; originName: string; path: string; size: number; ext: string; type: string }
): Record<string, unknown> {
  const now = isoNow()
  return {
    id,
    messageId,
    type: 'file',
    content: 'file',
    status: 'success',
    createdAt: now,
    updatedAt: now,
    file: {
      id: file.id,
      name: file.name,
      origin_name: file.originName,
      path: file.path,
      size: file.size,
      ext: file.ext,
      type: file.type,
      created_at: now
    }
  }
}

// ---------------------------------------------------------------------------
// Spec-local reads, waits, file helpers and cleanup
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchRoute(page: Page, topicId: string, branchId: string | null): Promise<RouteView> {
  const value = unwrapOk(await invokeChatDb(page, 'fetchMessages', { topicId, branchId }), 'fetchMessages') as Record<
    string,
    unknown
  >
  const messages = (Array.isArray(value.messages) ? value.messages : []) as Array<Record<string, unknown>>
  const blocks = (Array.isArray(value.blocks) ? value.blocks : []) as Array<Record<string, unknown>>
  return {
    ids: messages.map((m) => String(m.id)),
    contents: messages.map((m) => String(m.content ?? '')),
    blocks
  }
}

async function listBranches(page: Page, topicId: string): Promise<BranchWire[]> {
  const value = unwrapOk(await invokeChatDb(page, 'listBranches', { topicId }), 'listBranches') as Record<
    string,
    unknown
  >
  const branches = (Array.isArray(value.branches) ? value.branches : []) as Array<Record<string, unknown>>
  return branches.map((b) => ({
    id: String(b.id),
    parentBranchId: (b.parentBranchId ?? null) as string | null,
    anchorMessageId: String(b.anchorMessageId),
    name: (b.name ?? null) as string | null
  }))
}

async function createBranch(
  page: Page,
  args: { topicId: string; parentBranchId?: string | null; anchorMessageId: string; name: string }
): Promise<BranchWire> {
  const value = unwrapOk(
    await invokeChatDb(page, 'createBranch', {
      topicId: args.topicId,
      parentBranchId: args.parentBranchId ?? null,
      anchorMessageId: args.anchorMessageId,
      name: args.name
    }),
    'createBranch'
  ) as Record<string, unknown>
  const branch = value.branch as Record<string, unknown>
  return {
    id: String(branch.id),
    parentBranchId: (branch.parentBranchId ?? null) as string | null,
    anchorMessageId: String(branch.anchorMessageId),
    name: (branch.name ?? null) as string | null
  }
}

async function appendBranchMessageViaApi(
  page: Page,
  topicId: string,
  branchId: string,
  message: Record<string, unknown>,
  blocks: Record<string, unknown>[]
): Promise<void> {
  unwrapOk(await invokeChatDb(page, 'appendMessage', { topicId, branchId, message, blocks }), 'appendMessage(branch)')
}

async function createReferencedTarget(
  page: Page,
  args: { sourceTopicId: string; targetTopicId: string; anchorMessageId: string; assistantId: string; name: string }
): Promise<void> {
  unwrapOk(
    await invokeChatDb(page, 'createReferencedTopic', {
      sourceTopicId: args.sourceTopicId,
      branchId: null,
      targetTopicId: args.targetTopicId,
      anchorMessageId: args.anchorMessageId,
      assistantId: args.assistantId,
      name: args.name
    }),
    'createReferencedTopic'
  )
}

async function exportTopicData(page: Page, topicId: string): Promise<ExportPayload> {
  const value = unwrapOk(await invokeChatDb(page, 'exportTopicData', { topicId }), 'exportTopicData') as Record<
    string,
    unknown
  >
  const payload = value.payload as ExportPayload
  if (!payload || typeof payload !== 'object') throw new Error('exportTopicData value.payload missing')
  return payload
}

async function importTopicData(page: Page, payload: ExportPayload, assistantId: string): Promise<ImportResult> {
  const value = unwrapOk(
    await invokeChatDb(page, 'importTopicData', { payload, assistantId }),
    'importTopicData'
  ) as Record<string, unknown>
  const topic = value.topic as Record<string, unknown>
  if (!topic || typeof topic !== 'object') throw new Error('importTopicData value.topic missing')
  return {
    topicId: String(topic.id),
    messageCount: Number(value.messageCount),
    blockCount: Number(value.blockCount),
    branchCount: Number(value.branchCount),
    segmentCount: Number(value.segmentCount),
    fileReferenceCount: Number(value.fileReferenceCount)
  }
}

/** Active assistant owner id (the sidebar directory only lists owned topics). */
async function getActiveOwnerAssistantId(page: Page): Promise<string> {
  const ownerId = await page.evaluate(() => {
    const s = (window as unknown as { store?: { getState: () => any } }).store?.getState() as any
    const topicId = typeof s?.messages?.currentTopicId === 'string' ? s.messages.currentTopicId : ''
    const assistants = (s?.assistants?.assistants ?? []) as Array<{ id?: string; topics?: Array<{ id?: string }> }>
    if (topicId) {
      const owner = assistants.find((a) => Array.isArray(a?.topics) && a.topics.some((t) => t?.id === topicId))
      if (typeof owner?.id === 'string' && owner.id.length > 0) return owner.id
    }
    const first = assistants?.[0]?.id
    return typeof first === 'string' ? first : ''
  })
  expect(ownerId, 'active owner assistant id must be explicit').not.toBe('')
  return ownerId
}

async function setDisplayCount(page: Page, limit: number): Promise<void> {
  await page.evaluate((value: number) => {
    ;(window as unknown as { store: { dispatch: (action: unknown) => void } }).store.dispatch({
      type: 'newMessages/setDisplayCount',
      payload: value
    })
  }, limit)
}

async function openTopicInUi(page: Page, topicId: string): Promise<void> {
  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await expect(item, `topic ${topicId} must be present in the peer sidebar`).toHaveCount(1, { timeout: 30000 })
  await item.scrollIntoViewIfNeeded()
  await item.click()
  await page.waitForFunction(
    (tid: string) => {
      const s = (window as unknown as { store?: { getState: () => any } }).store?.getState() as any
      if (s?.messages?.currentTopicId !== tid) return false
      if (s?.messages?.loadingByTopic?.[tid] === true) return false
      const ids = s?.messages?.messageIdsByTopic?.[tid]
      return Array.isArray(ids) && ids.length > 0
    },
    topicId,
    { timeout: 30000 }
  )
}

interface PeerProjection {
  ids: string[]
  mutable: string[]
  hasReference: boolean
  referenceStatus: string | null
}

async function readPeerProjection(page: Page, topicId: string): Promise<PeerProjection> {
  return await page.evaluate((tid: string) => {
    const s = (window as unknown as { store: { getState: () => any } }).store.getState() as any
    const reference = s?.messages?.historyReferenceByTopic?.[tid] ?? null
    return {
      ids: ((s?.messages?.messageIdsByTopic?.[tid] ?? []) as string[]).slice(),
      mutable: ((s?.messages?.mutableMessageIdsByTopic?.[tid] ?? []) as string[]).slice(),
      hasReference: Boolean(reference),
      referenceStatus: reference ? String(reference.status) : null
    }
  }, topicId)
}

async function pollRouteIds(
  page: Page,
  topicId: string,
  branchId: string | null,
  expected: string[],
  timeoutMs = 90000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = 'no-read'
  while (Date.now() < deadline) {
    const route = await fetchRoute(page, topicId, branchId)
    if (route.ids.length === expected.length && route.ids.every((id, i) => id === expected[i])) return
    last = `got=[${route.ids.join(',')}] expected=[${expected.join(',')}]`
    await sleep(500)
  }
  throw new Error(`route-ids timeout topic=${topicId} branch=${branchId ?? 'main'}: ${last}`)
}

async function pollBranchCatalog(page: Page, topicId: string, expectedIds: string[], timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = 'no-read'
  while (Date.now() < deadline) {
    const ids = (await listBranches(page, topicId)).map((b) => b.id).sort()
    const want = [...expectedIds].sort()
    if (ids.length === want.length && ids.every((id, i) => id === want[i])) return
    last = `got=[${ids.join(',')}]`
    await sleep(500)
  }
  throw new Error(`branch-catalog timeout topic=${topicId}: ${last}`)
}

/** Write real bytes into the profile's local Files dir under the attachment id. */
async function writeSyntheticFile(page: Page, fileId: string, ext: string, b64: string): Promise<void> {
  await page.evaluate(
    async ({ fileName, data }: { fileName: string; data: string }) => {
      const w = window as unknown as {
        api?: {
          getAppInfo?: () => Promise<{ filesPath: string }>
          file?: { mkdir: (p: string) => Promise<void>; write: (p: string, bytes: Uint8Array) => Promise<void> }
        }
      }
      const info = await w.api!.getAppInfo!()
      await w.api!.file!.mkdir(info.filesPath)
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
      await w.api!.file!.write(`${info.filesPath}/${fileName}`, bytes)
    },
    { fileName: `${fileId}${ext}`, data: b64 }
  )
}

/** Read the attachment bytes back from the profile's local Files dir. */
async function verifyFileBytes(page: Page, fileId: string, ext: string, expectedB64: string): Promise<boolean> {
  return await page.evaluate(
    async ({ fileName, expected }: { fileName: string; expected: string }) => {
      const w = window as unknown as {
        api?: { getAppInfo?: () => Promise<{ filesPath: string }>; fs?: { read: (p: string) => Promise<unknown> } }
      }
      const info = await w.api!.getAppInfo!()
      try {
        const data = await w.api!.fs!.read(`${info.filesPath}/${fileName}`)
        let buf: Uint8Array
        if (data instanceof Uint8Array) buf = data
        else if (Array.isArray(data)) buf = Uint8Array.from(data as number[])
        else if (typeof data === 'object' && data !== null && 'data' in (data as Record<string, unknown>)) {
          const inner = (data as Record<string, unknown>).data
          if (inner instanceof Uint8Array) buf = inner
          else if (Array.isArray(inner)) buf = Uint8Array.from(inner as number[])
          else buf = new TextEncoder().encode(String(inner))
        } else {
          buf = new TextEncoder().encode(String(data))
        }
        let binary = ''
        for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i])
        return btoa(binary) === expected
      } catch {
        return false
      }
    },
    { fileName: `${fileId}${ext}`, expected: expectedB64 }
  )
}

async function closeProfileAndRelay(profile: SecondSyncProfile | null, relay: TestRelayHandle | null): Promise<void> {
  const errors: Error[] = []
  const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))
  if (profile) {
    try {
      await closeSecondSyncProfile(profile)
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
  if (errors.length > 1) throw new AggregateError(errors, 'topic-data import sync E2E cleanup failed')
}

function uniqueTag(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// Fixture world: main route + one internal branch + a supported attachment
// ---------------------------------------------------------------------------

interface ImportWorld {
  sourceTopicId: string
  branchId: string
  branchAnchorId: string
  fileId: string
  fileExt: string
  fileB64: string
  mainContents: string[]
  branchContents: string[]
}

async function seedBranchingTopicWithAttachment(
  page: Page,
  args: { assistantId: string; tag: string }
): Promise<ImportWorld> {
  const { assistantId, tag } = args
  const sourceTopicId = `${tag}-src`
  const fileId = randomUUID()
  const fileExt = '.pdf'
  const fileBytes = Buffer.from(`e2e-topic-data-import-bytes-${tag}`)
  const fileB64 = fileBytes.toString('base64')
  await writeSyntheticFile(page, fileId, fileExt, fileB64)

  await ensureTopicViaApi(page, sourceTopicId, 'Import Sync Source', assistantId)
  const u1 = `${tag}-u1`
  const a1 = `${tag}-a1`
  const u2 = `${tag}-u2`
  await appendMessageViaApi(
    page,
    sourceTopicId,
    messageJson(u1, sourceTopicId, 'user', 'import main u1', assistantId),
    [blockJson(`${tag}-k-u1`, u1, 'import main u1')]
  )
  await appendMessageViaApi(
    page,
    sourceTopicId,
    messageJson(a1, sourceTopicId, 'assistant', 'import main a1', assistantId, u1),
    [blockJson(`${tag}-k-a1`, a1, 'import main a1')]
  )
  await appendMessageViaApi(
    page,
    sourceTopicId,
    messageJson(u2, sourceTopicId, 'user', 'import main u2', assistantId),
    [
      blockJson(`${tag}-k-u2`, u2, 'import main u2'),
      fileBlockJson(`${tag}-k-u2-file`, u2, {
        id: fileId,
        name: `${fileId}${fileExt}`,
        originName: 'import-doc.pdf',
        path: `/tmp/${fileId}${fileExt}`,
        size: fileBytes.length,
        ext: fileExt,
        type: 'document'
      })
    ]
  )

  const branch = await createBranch(page, {
    topicId: sourceTopicId,
    anchorMessageId: a1,
    name: 'ImportL1'
  })
  const u3 = `${tag}-u3`
  const a3 = `${tag}-a3`
  await appendBranchMessageViaApi(
    page,
    sourceTopicId,
    branch.id,
    messageJson(u3, sourceTopicId, 'user', 'import branch u3', assistantId),
    [blockJson(`${tag}-k-u3`, u3, 'import branch u3')]
  )
  await appendBranchMessageViaApi(
    page,
    sourceTopicId,
    branch.id,
    messageJson(a3, sourceTopicId, 'assistant', 'import branch a3', assistantId, u3),
    [blockJson(`${tag}-k-a3`, a3, 'import branch a3')]
  )

  const main = await fetchRoute(page, sourceTopicId, null)
  expect(main.contents).toEqual(['import main u1', 'import main a1', 'import main u2'])
  const branchRoute = await fetchRoute(page, sourceTopicId, branch.id)
  expect(branchRoute.ids, 'branch route must be the shared prefix through the anchor plus branch rows').toEqual([
    u1,
    a1,
    u3,
    a3
  ])

  return {
    sourceTopicId,
    branchId: branch.id,
    branchAnchorId: a1,
    fileId,
    fileExt,
    fileB64,
    mainContents: ['import main u1', 'import main a1', 'import main u2'],
    branchContents: ['import main u1', 'import main a1', 'import branch u3', 'import branch a3']
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Topic data import sync', () => {
  test('imported main + branch + attachment topic converges with exact ordering and attachment bytes', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    test.setTimeout(420000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: production exportTopicData of a topic with a main route, one internal branch and a real local FILE attachment, then production importTopicData on the source profile; one sync round gives the peer the identical main-route order, the identical branch catalog (parent + anchor) and the identical branch-route order, and the attachment BYTES are readable from the peer file store (receiver-local path, byte-exact).'
    })

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
      await setDisplayCount(pageB, DISPLAY_LIMIT)

      const ownerA = await getActiveOwnerAssistantId(pageA)
      const world = await seedBranchingTopicWithAttachment(pageA, {
        assistantId: ownerA,
        tag: uniqueTag('e2e-tdimport-1')
      })

      const payload = await exportTopicData(pageA, world.sourceTopicId)
      expect(payload.format).toBe('cherry-chat-topic-data')
      expect(payload.version).toBe(1)
      expect(payload.messages).toHaveLength(5)
      // Five main_text blocks (main route u1/u2/a1 + branch route u3/a3) and
      // the FILE block on `import main u2`.
      expect(payload.blocks).toHaveLength(6)
      expect(payload.branches).toHaveLength(1)
      expect(payload.fileReferences).toHaveLength(1)
      expect(payload.fileReferences[0].fileId).toBe(world.fileId)
      expect(payload.historySnapshot, 'an ordinary topic export records no history snapshot').toBeUndefined()

      const imported = await importTopicData(pageA, payload, ownerA)
      expect(imported.topicId).not.toBe(world.sourceTopicId)
      expect(imported.messageCount).toBe(5)
      expect(imported.blockCount).toBe(6)
      expect(imported.branchCount).toBe(1)
      expect(imported.segmentCount).toBe(0)
      expect(imported.fileReferenceCount).toBe(1)

      // Source-side authority after import: fresh branch node, same structure.
      const importedMainA = await fetchRoute(pageA, imported.topicId, null)
      expect(importedMainA.contents, 'imported main route order').toEqual(world.mainContents)
      const importedBranchesA = await listBranches(pageA, imported.topicId)
      expect(importedBranchesA).toHaveLength(1)
      const importedBranchA = importedBranchesA[0]
      expect(importedBranchA.parentBranchId).toBeNull()
      expect(importedBranchA.name).toBe('ImportL1')
      const mainByIdA = new Map(importedMainA.ids.map((id, index) => [id, importedMainA.contents[index]]))
      expect(
        mainByIdA.get(importedBranchA.anchorMessageId),
        'branch anchor must be the imported `import main a1`'
      ).toBe('import main a1')
      const importedBranchRouteA = await fetchRoute(pageA, imported.topicId, importedBranchA.id)
      expect(importedBranchRouteA.contents, 'imported branch route order').toEqual(world.branchContents)

      // The import preserves the attachment identity (never copies payloads).
      const reExportA = await exportTopicData(pageA, imported.topicId)
      expect(reExportA.fileReferences[0].fileId).toBe(world.fileId)

      // --- Sync to the peer -------------------------------------------------
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await expect.poll(async () => await topicExistsViaApi(pageB, imported.topicId), { timeout: 90000 }).toBe(true)

      await pollRouteIds(pageB, imported.topicId, null, importedMainA.ids)
      const importedMainB = await fetchRoute(pageB, imported.topicId, null)
      expect(importedMainB.contents, 'peer main-route order must be identical').toEqual(world.mainContents)

      await pollBranchCatalog(pageB, imported.topicId, [importedBranchA.id])
      const importedBranchesB = await listBranches(pageB, imported.topicId)
      expect(importedBranchesB).toHaveLength(1)
      expect(importedBranchesB[0].parentBranchId).toBeNull()
      expect(importedBranchesB[0].name).toBe('ImportL1')
      expect(importedBranchesB[0].anchorMessageId).toBe(importedBranchA.anchorMessageId)

      await pollRouteIds(pageB, imported.topicId, importedBranchA.id, importedBranchRouteA.ids)
      const importedBranchRouteB = await fetchRoute(pageB, imported.topicId, importedBranchA.id)
      expect(importedBranchRouteB.contents, 'peer branch-route order must be identical').toEqual(world.branchContents)

      // --- Attachment: identity + real bytes on the peer --------------------
      const fileBlockB = importedMainB.blocks.find((b) => {
        const file = b.file as Record<string, unknown> | undefined
        return !!file && file.id === world.fileId
      })
      expect(fileBlockB, `peer must carry the imported FILE block for ${world.fileId}`).toBeTruthy()
      expect((fileBlockB!.file as Record<string, unknown>).ext).toBe(world.fileExt)
      // Auto-retrying (never a fixed sleep): the receiver writes the verified
      // bytes inside its own sync round, so the assertion reads durable state.
      await expect
        .poll(async () => await verifyFileBytes(pageB, world.fileId, world.fileExt, world.fileB64), {
          timeout: 60000,
          message: 'the receiver must hold the byte-exact attachment payload'
        })
        .toBe(true)

      const reExportB = await exportTopicData(pageB, imported.topicId)
      expect(reExportB.messages).toHaveLength(5)
      // Same 5 main_text blocks + the FILE block the source export carried.
      expect(reExportB.blocks).toHaveLength(6)
      expect(reExportB.branches).toHaveLength(1)
      expect(reExportB.fileReferences[0].fileId).toBe(world.fileId)
      expect(reExportB.historySnapshot).toBeUndefined()

      // Rendered peer projection of the synced import.
      await openTopicInUi(pageB, imported.topicId)
      await expect(pageB.locator('#messages')).toContainText('import main u1', { timeout: 20000 })
      await expect(pageB.locator('#messages')).toContainText('import main u2', { timeout: 20000 })
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('imported reference-target snapshot materializes as owned rows and recreates no relation across sync', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    test.setTimeout(360000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: a reference target is exported (its foreign prefix MATERIALIZED as standalone snapshot rows, provenance posture only, no source identity) and imported through production importTopicData; the imported topic owns every row with fresh ids and no live relation, and after sync the peer holds the identical owned route with no relation metadata, no divider and every row mutable — the read-only foreign prefix is NOT recreated.'
    })

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
      await setDisplayCount(pageB, DISPLAY_LIMIT)

      const ownerA = await getActiveOwnerAssistantId(pageA)
      const tag = uniqueTag('e2e-tdimport-2')
      const sourceTopicId = `${tag}-src`
      const targetTopicId = `${tag}-dst`
      await ensureTopicViaApi(pageA, sourceTopicId, 'Snapshot Reference Source', ownerA)
      const sourceIds = [`${tag}-p0`, `${tag}-p1`, `${tag}-p2`, `${tag}-p3`]
      const sourceContents = [
        'snapshot prefix user 0',
        'snapshot prefix assistant 1',
        'snapshot prefix user 2',
        'snapshot prefix assistant 3'
      ]
      for (let i = 0; i < sourceIds.length; i++) {
        const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant'
        await appendMessageViaApi(
          pageA,
          sourceTopicId,
          messageJson(
            sourceIds[i],
            sourceTopicId,
            role,
            sourceContents[i],
            ownerA,
            i % 2 === 0 ? undefined : sourceIds[i - 1]
          ),
          [blockJson(`${tag}-kp${i}`, sourceIds[i], sourceContents[i])]
        )
      }
      await createReferencedTarget(pageA, {
        sourceTopicId,
        targetTopicId,
        anchorMessageId: sourceIds[3],
        assistantId: ownerA,
        name: 'Snapshot Reference Target'
      })
      const suffixIds = [`${tag}-t0`, `${tag}-t1`]
      const suffixContents = ['snapshot target suffix user', 'snapshot target suffix assistant']
      await appendMessageViaApi(
        pageA,
        targetTopicId,
        messageJson(suffixIds[0], targetTopicId, 'user', suffixContents[0], ownerA),
        [blockJson(`${tag}-kt0`, suffixIds[0], suffixContents[0])]
      )
      await appendMessageViaApi(
        pageA,
        targetTopicId,
        messageJson(suffixIds[1], targetTopicId, 'assistant', suffixContents[1], ownerA, suffixIds[0]),
        [blockJson(`${tag}-kt1`, suffixIds[1], suffixContents[1])]
      )

      // Export records only the snapshot posture (never a live source identity).
      const payload = await exportTopicData(pageA, targetTopicId)
      expect(payload.historySnapshot?.status).toBe('materialized')
      expect(payload.messages).toHaveLength(6)
      expect((payload.messages as Array<Record<string, unknown>>).every((m) => m.branchId === null)).toBe(true)
      const serialized = JSON.stringify(payload.historySnapshot ?? {})
      for (const foreignId of [sourceTopicId, targetTopicId, ...sourceIds]) {
        expect(serialized, 'the export never records a live source identity').not.toContain(foreignId)
      }

      const imported = await importTopicData(pageA, payload, ownerA)
      expect(imported.topicId).not.toBe(targetTopicId)
      expect(imported.messageCount).toBe(6)
      expect(imported.blockCount).toBe(6)
      expect(imported.branchCount).toBe(0)
      expect(imported.fileReferenceCount).toBe(0)

      // No live relation is recreated: provenance is absent on the import.
      const reExportA = await exportTopicData(pageA, imported.topicId)
      expect(reExportA.historySnapshot, 'an imported snapshot must not recreate a relation').toBeUndefined()

      const expectedContents = [...sourceContents, ...suffixContents]
      const importedRouteA = await fetchRoute(pageA, imported.topicId, null)
      expect(importedRouteA.contents, 'materialized prefix + owned suffix in canonical order').toEqual(expectedContents)
      const foreignIds = new Set([...sourceIds, ...suffixIds])
      for (const id of importedRouteA.ids) {
        expect(foreignIds.has(id), `imported row ${id} must use a fresh id, never the source stable id`).toBe(false)
      }

      // --- Sync to the peer -------------------------------------------------
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await expect.poll(async () => await topicExistsViaApi(pageB, imported.topicId), { timeout: 90000 }).toBe(true)
      await pollRouteIds(pageB, imported.topicId, null, importedRouteA.ids)
      const importedRouteB = await fetchRoute(pageB, imported.topicId, null)
      expect(importedRouteB.contents, 'peer must keep the identical materialized order').toEqual(expectedContents)

      // The peer never reconstructs a reference: no relation, no divider, and
      // every materialized row is target-owned (mutable), never read-only.
      await openTopicInUi(pageB, imported.topicId)
      const projectionB = await readPeerProjection(pageB, imported.topicId)
      expect(projectionB.ids).toEqual(importedRouteA.ids)
      expect(projectionB.hasReference, 'the synced snapshot must not carry reference metadata').toBe(false)
      expect(projectionB.referenceStatus).toBeNull()
      await expect(pageB.locator('[data-testid="history-reference-divider"]')).toHaveCount(0)
      for (const id of importedRouteA.ids) {
        expect(
          projectionB.mutable,
          `materialized row ${id} must stay mutable (owned, not foreign) on the peer`
        ).toContain(id)
      }
      const reExportB = await exportTopicData(pageB, imported.topicId)
      expect(reExportB.historySnapshot).toBeUndefined()
      expect(reExportB.messages).toHaveLength(6)
      await expect(pageB.locator('#messages')).toContainText('snapshot prefix user 0', { timeout: 20000 })
      await expect(pageB.locator('#messages')).toContainText('snapshot target suffix assistant', { timeout: 20000 })
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })
})
