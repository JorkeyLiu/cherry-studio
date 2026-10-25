/**
 * Cross-topic history reference SYNC E2E — two isolated profiles over a
 * per-test loopback relay (plus a third cursor-0 receiver for the baseline
 * case).
 *
 * Durable asset guarding the synced cross-topic reference workflow:
 * - The reference target is created through the production Main capability
 *   (`window.api.chatDb.createReferencedTopic`) on the source profile, and its
 *   relation (source topic + source route + precise anchor) reaches the peer
 *   through the production sync path.
 * - On the peer the target renders the LIVE foreign prefix (canonical source
 *   stable IDs, never copied/restamped), the divider at the prefix/suffix
 *   boundary with a live source title link, and its own writable suffix.
 * - Read-only/owned semantics hold on the peer: the foreign prefix is excluded
 *   from the peer's Main-authoritative `mutableMessageIdsByTopic` while the
 *   target-owned suffix stays mutable, and the mutation controls are hidden on
 *   the prefix while present on the owned suffix.
 * - A source mutation (rename + prefix message content edit) reaches the peer
 *   and the peer's divider title + prefix content reflect it (live prefix, not
 *   a snapshot copy).
 * - A missing source does not corrupt the relation: the peer keeps the relation
 *   metadata (source topic + anchor), reports the divider as missing, drops the
 *   foreign prefix, and preserves exactly the target-owned suffix.
 * - Relay baseline + restart: a fresh cursor-0 receiver bootstraps the whole
 *   relationship from the relay after the owned file-backed relay is stopped
 *   and restarted against the same database.
 *
 * Evidence classes: production ChatDb IPC reads (`fetchMessages` per route,
 * `createReferencedTopic`, `topicExists`, `listBranches`), Redux projection
 * snapshots of the resident window (route ids / mutable capability / reference
 * metadata), rendered divider + message containers, and real sync rounds
 * through `window.api.sync.sync()`.
 *
 * Standard shared fixture, two independent disposable profiles under the same
 * owned temp root, mocked external providers, deterministic assertions,
 * fixture-owned cleanup.
 */
import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/electron.fixture'
import {
  appendMessageViaApi,
  ensureTopicViaApi,
  getSyncStatusViaApi,
  isoNow,
  pairProfilesViaApi,
  provisionObserverViaRaw,
  runSyncViaApi,
  setSyncConfigViaApi,
  softDeleteTopicViaApi,
  topicExistsViaApi
} from '../../pages/sync.page'
import { startTestRelay, type TestRelayHandle } from '../../utils/sync-relay'
import {
  assertNoUnresolvedRelayCleanup,
  getFailedRelayHandle,
  startFileBackedRelay,
  type FileBackedRelayHandle
} from '../../utils/sync-relay-process'
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
// Wire / projection shapes (mirror the production contracts this asset reads)
// ---------------------------------------------------------------------------

interface ReferenceWire {
  targetTopicId: string
  sourceTopicId: string
  sourceBranchId: string | null
  anchorMessageId: string
  sourceName: string | null
}

interface HistoryReferenceProjection {
  sourceTopicId: string
  sourceBranchId: string | null
  anchorMessageId: string
  sourceName: string | null
  status: 'available' | 'missing'
  boundaryMessageId: string | null
}

interface TopicProjection {
  currentTopicId: string | null
  ids: string[]
  mutable: string[]
  reference: HistoryReferenceProjection | null
}

interface RouteView {
  ids: string[]
  contents: string[]
}

interface BranchWire {
  id: string
  parentBranchId: string | null
  anchorMessageId: string
  name: string | null
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

// ---------------------------------------------------------------------------
// Spec-local reads, waits and cleanup
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
  return {
    ids: messages.map((m) => String(m.id)),
    contents: messages.map((m) => String(m.content ?? ''))
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

async function createReferencedTopic(
  page: Page,
  args: {
    sourceTopicId: string
    sourceBranchId: string | null
    targetTopicId: string
    anchorMessageId: string
    assistantId: string
    name: string
  }
): Promise<{ topicId: string; reference: ReferenceWire }> {
  const value = unwrapOk(
    await invokeChatDb(page, 'createReferencedTopic', {
      sourceTopicId: args.sourceTopicId,
      branchId: args.sourceBranchId,
      targetTopicId: args.targetTopicId,
      anchorMessageId: args.anchorMessageId,
      assistantId: args.assistantId,
      name: args.name
    }),
    'createReferencedTopic'
  ) as Record<string, unknown>
  const reference = value.reference as ReferenceWire
  if (!reference || typeof reference !== 'object') throw new Error('createReferencedTopic value.reference missing')
  return { topicId: String(value.topicId), reference }
}

async function renameTopic(page: Page, topicId: string, name: string): Promise<void> {
  const raw = await invokeChatDb(page, 'updateTopicMetadata', { topicId, name })
  unwrapOk(raw, 'updateTopicMetadata')
}

async function editMessageContent(page: Page, topicId: string, messageId: string, content: string): Promise<void> {
  // The rendered text of a message is its main_text BLOCK content, not
  // `message.content`. Use the production atomic edit path
  // (`updateMessageAndBlocks`) so the visible block and the message row change
  // together — a message-only patch would leave the rendered text stale for
  // reasons unrelated to sync.
  const value = unwrapOk(
    await invokeChatDb(page, 'fetchMessages', { topicId, branchId: null }),
    'fetchMessages'
  ) as Record<string, unknown>
  const blocks = (Array.isArray(value.blocks) ? value.blocks : []) as Array<Record<string, unknown>>
  const block = blocks.find((candidate) => candidate.messageId === messageId && candidate.type === 'main_text')
  if (!block) throw new Error(`main_text block for ${messageId} not found on topic ${topicId}`)
  const raw = await invokeChatDb(page, 'updateMessageAndBlocks', {
    topicId,
    branchId: null,
    messageUpdates: { id: messageId, content },
    blocksToUpdate: [{ ...block, content }]
  })
  unwrapOk(raw, 'updateMessageAndBlocks')
}

/**
 * Record the Main→renderer history-reference invalidation hints that actually
 * reach this window (the same preload contract the app itself subscribes to).
 * This is what lets a case prove the REMOTE sync path crossed the IPC boundary
 * on a resident route, instead of inferring it from a re-read that another
 * hint (topic rename) could also have caused.
 */
async function installReferenceInvalidationRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      api?: { chatDb?: { onHistoryReferenceInvalidated?: (cb: (event: never) => void) => () => void } }
      __refInvalidations?: Array<{ sourceTopicId: string; targetTopicIds: string[] }>
    }
    w.__refInvalidations = []
    const subscribe = w.api?.chatDb?.onHistoryReferenceInvalidated
    if (typeof subscribe !== 'function') throw new Error('onHistoryReferenceInvalidated is unavailable')
    subscribe((event) => {
      w.__refInvalidations?.push(event as unknown as { sourceTopicId: string; targetTopicIds: string[] })
    })
  })
}

async function readReferenceInvalidations(
  page: Page
): Promise<Array<{ sourceTopicId: string; targetTopicIds: string[] }>> {
  return page.evaluate(
    () =>
      (window as unknown as { __refInvalidations?: Array<{ sourceTopicId: string; targetTopicIds: string[] }> })
        .__refInvalidations ?? []
  )
}

async function setDisplayCount(page: Page, limit: number): Promise<void> {
  await page.evaluate((value: number) => {
    ;(window as unknown as { store: { dispatch: (action: unknown) => void } }).store.dispatch({
      type: 'newMessages/setDisplayCount',
      payload: value
    })
  }, limit)
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

/** Activate a topic in the real UI (resident-window load from Main authority). */
async function openTopicInUi(page: Page, topicId: string): Promise<void> {
  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await expect(item, `topic ${topicId} must be present in the sidebar`).toHaveCount(1, { timeout: 30000 })
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

/** Resident-window projection: route ids, Main-authoritative capability, relation metadata. */
async function readTopicProjection(page: Page, topicId: string): Promise<TopicProjection> {
  return await page.evaluate((tid: string) => {
    const s = (window as unknown as { store: { getState: () => any } }).store.getState() as any
    const reference = s?.messages?.historyReferenceByTopic?.[tid] ?? null
    return {
      currentTopicId: (s?.messages?.currentTopicId ?? null) as string | null,
      ids: ((s?.messages?.messageIdsByTopic?.[tid] ?? []) as string[]).slice(),
      mutable: ((s?.messages?.mutableMessageIdsByTopic?.[tid] ?? []) as string[]).slice(),
      reference: reference
        ? {
            sourceTopicId: String(reference.sourceTopicId),
            sourceBranchId: (reference.sourceBranchId ?? null) as string | null,
            anchorMessageId: String(reference.anchorMessageId),
            sourceName: (reference.sourceName ?? null) as string | null,
            status: reference.status as 'available' | 'missing',
            boundaryMessageId: (reference.boundaryMessageId ?? null) as string | null
          }
        : null
    }
  }, topicId)
}

/** Main-authoritative relation resolution for a reference target (window read). */
async function readMainReference(page: Page, topicId: string): Promise<Record<string, unknown> | null> {
  const value = unwrapOk(
    await invokeChatDb(page, 'fetchMessagesWindow', { kind: 'latest', topicId, branchId: null, limit: 20 }),
    'fetchMessagesWindow'
  ) as Record<string, unknown>
  return (value.reference ?? null) as Record<string, unknown> | null
}

async function waitForReferenceStatus(page: Page, topicId: string, expected: 'available' | 'missing'): Promise<void> {
  await page.waitForFunction(
    ({ tid, want }: { tid: string; want: string }) => {
      const s = (window as unknown as { store?: { getState: () => any } }).store?.getState() as any
      return (s?.messages?.historyReferenceByTopic?.[tid]?.status ?? null) === want
    },
    { tid: topicId, want: expected },
    { timeout: 60000 }
  )
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

async function pollRouteContent(
  page: Page,
  topicId: string,
  branchId: string | null,
  index: number,
  expectedContent: string,
  timeoutMs = 90000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = 'no-read'
  while (Date.now() < deadline) {
    const route = await fetchRoute(page, topicId, branchId)
    const actual = route.contents[index]
    if (actual === expectedContent) return
    last = actual === undefined ? `absent(len=${route.ids.length})` : `content=${JSON.stringify(actual)}`
    await sleep(500)
  }
  throw new Error(
    `route-content timeout topic=${topicId} index=${index} expected=${JSON.stringify(expectedContent)}: ${last}`
  )
}

async function pollPendingDrained(page: Page, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = 'no-read'
  while (Date.now() < deadline) {
    const status = await getSyncStatusViaApi(page)
    if (status.pendingCount === 0 && status.lastError === null) return
    last = `pending=${status.pendingCount} error=${status.lastError}`
    await sleep(500)
  }
  throw new Error(`pending-drain timeout: ${last}`)
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
  if (errors.length > 1) throw new AggregateError(errors, 'history-reference sync E2E cleanup failed')
}

/** File-backed relay teardown: relay child first (exact owned PID), then profiles. */
async function closeFileRelayAndProfiles(
  relay: FileBackedRelayHandle | null,
  profiles: Array<SecondSyncProfile | null>
): Promise<void> {
  const errors: Error[] = []
  const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))
  if (relay) {
    try {
      await relay.close()
    } catch (e) {
      errors.push(asError(e))
    }
    try {
      if (relay.isRunning()) {
        errors.push(new Error('history-reference sync E2E cleanup: owned relay child still live; root preserved'))
      }
      assertNoUnresolvedRelayCleanup('history-reference sync E2E cleanup')
    } catch (e) {
      errors.push(asError(e))
    }
  }
  for (const profile of [...profiles].reverse()) {
    if (!profile) continue
    try {
      await closeSecondSyncProfile(profile)
    } catch (e) {
      errors.push(asError(e))
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'history-reference sync E2E cleanup failed')
}

// ---------------------------------------------------------------------------
// Deterministic reference world (shared by all three cases)
// ---------------------------------------------------------------------------

interface ReferenceWorld {
  sourceTopicId: string
  sourceName: string
  targetTopicId: string
  targetName: string
  /** Stable source route in authority order (anchor is the 4th message). */
  sourceRouteIds: string[]
  /** Foreign prefix: canonical source IDs through the anchor inclusive. */
  prefixIds: string[]
  /** Source message AFTER the anchor: must never enter the reference prefix. */
  afterAnchorId: string
  /** Target-owned writable suffix (user + assistant reply). */
  suffixIds: string[]
  /** Target effective route: prefix + owned suffix. */
  targetRouteIds: string[]
}

/**
 * Seed a source topic on the owning profile, create the reference target
 * through the production Main capability, then append a target-owned writable
 * suffix. Everything below is production IPC: no Redux response fabrication and
 * no direct SQLite write.
 */
async function seedReferenceWorld(
  page: Page,
  args: { assistantId: string; tag: string; sourceName: string; targetName: string }
): Promise<ReferenceWorld> {
  const { assistantId, tag, sourceName, targetName } = args
  const sourceTopicId = `${tag}-src`
  const targetTopicId = `${tag}-dst`
  const msg = (i: number): string => `${tag}-m${i}`
  const blk = (i: number): string => `${tag}-k${i}`

  await ensureTopicViaApi(page, sourceTopicId, sourceName, assistantId)
  // u0, a1(ask u0), u2, a3(ask u2) <- anchor, u4 after the anchor.
  await appendMessageViaApi(
    page,
    sourceTopicId,
    messageJson(msg(0), sourceTopicId, 'user', 'ref-source-user-0', assistantId),
    [blockJson(blk(0), msg(0), 'ref-source-user-0')]
  )
  await appendMessageViaApi(
    page,
    sourceTopicId,
    messageJson(msg(1), sourceTopicId, 'assistant', 'ref-source-assistant-1', assistantId, msg(0)),
    [blockJson(blk(1), msg(1), 'ref-source-assistant-1')]
  )
  await appendMessageViaApi(
    page,
    sourceTopicId,
    messageJson(msg(2), sourceTopicId, 'user', 'ref-source-user-2', assistantId),
    [blockJson(blk(2), msg(2), 'ref-source-user-2')]
  )
  await appendMessageViaApi(
    page,
    sourceTopicId,
    messageJson(msg(3), sourceTopicId, 'assistant', 'ref-source-assistant-3', assistantId, msg(2)),
    [blockJson(blk(3), msg(3), 'ref-source-assistant-3')]
  )
  await appendMessageViaApi(
    page,
    sourceTopicId,
    messageJson(msg(4), sourceTopicId, 'user', 'ref-source-user-after-anchor', assistantId),
    [blockJson(blk(4), msg(4), 'ref-source-user-after-anchor')]
  )

  const sourceRouteIds = (await fetchRoute(page, sourceTopicId, null)).ids
  expect(sourceRouteIds, 'seeded source route must be the 5 seeded messages in order').toEqual([
    msg(0),
    msg(1),
    msg(2),
    msg(3),
    msg(4)
  ])
  const anchorMessageId = msg(3)

  const created = await createReferencedTopic(page, {
    sourceTopicId,
    sourceBranchId: null,
    targetTopicId,
    anchorMessageId,
    assistantId,
    name: targetName
  })
  expect(created.topicId).toBe(targetTopicId)
  expect(created.reference.targetTopicId).toBe(targetTopicId)
  expect(created.reference.sourceTopicId).toBe(sourceTopicId)
  expect(created.reference.sourceBranchId).toBeNull()
  expect(created.reference.anchorMessageId).toBe(anchorMessageId)

  // Target-owned writable suffix (user + assistant reply) in the target's own
  // main route, after the foreign prefix.
  const suffixUser = `${tag}-s0`
  const suffixAssistant = `${tag}-s1`
  await appendMessageViaApi(
    page,
    targetTopicId,
    messageJson(suffixUser, targetTopicId, 'user', 'ref-target-suffix-user', assistantId),
    [blockJson(`${tag}-ks0`, suffixUser, 'ref-target-suffix-user')]
  )
  await appendMessageViaApi(
    page,
    targetTopicId,
    messageJson(suffixAssistant, targetTopicId, 'assistant', 'ref-target-suffix-assistant', assistantId, suffixUser),
    [blockJson(`${tag}-ks1`, suffixAssistant, 'ref-target-suffix-assistant')]
  )

  const prefixIds = sourceRouteIds.slice(0, 4)
  const targetRouteIds = [...prefixIds, suffixUser, suffixAssistant]
  const targetRoute = await fetchRoute(page, targetTopicId, null)
  expect(targetRoute.ids, 'target effective route must be the foreign prefix plus the owned suffix').toEqual(
    targetRouteIds
  )

  return {
    sourceTopicId,
    sourceName,
    targetTopicId,
    targetName,
    sourceRouteIds,
    prefixIds,
    afterAnchorId: msg(4),
    suffixIds: [suffixUser, suffixAssistant],
    targetRouteIds
  }
}

/** One setup manual round on each profile, then wait for the peer routes. */
async function convergeOnPeer(pageA: Page, pageB: Page, world: ReferenceWorld): Promise<void> {
  expect((await runSyncViaApi(pageA)).threw).toBeNull()
  expect((await runSyncViaApi(pageB)).threw).toBeNull()
  await expect.poll(async () => await topicExistsViaApi(pageB, world.sourceTopicId), { timeout: 90000 }).toBe(true)
  await expect.poll(async () => await topicExistsViaApi(pageB, world.targetTopicId), { timeout: 90000 }).toBe(true)
  await pollRouteIds(pageB, world.sourceTopicId, null, world.sourceRouteIds)
  await pollRouteIds(pageB, world.targetTopicId, null, world.targetRouteIds)
}

function uniqueTag(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Cross-topic history reference sync', () => {
  test('reference target syncs as relation + live readonly prefix + owned suffix', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    test.setTimeout(360000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: source topic + reference target created through createReferencedTopic IPC, target-owned suffix appended; one sync round makes the peer hold the identical source route and target effective route (prefix + owned suffix), the peer resident window carries the relation metadata, the foreign prefix keeps canonical source IDs and is excluded from the peer mutableMessageIds while the owned suffix stays mutable, and the peer renders the divider with the live source title.'
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
      const ownerB = await getActiveOwnerAssistantId(pageB)
      expect(ownerB, 'both disposable profiles share the initial owner assistant').toBe(ownerA)

      const world = await seedReferenceWorld(pageA, {
        assistantId: ownerA,
        tag: uniqueTag('e2e-refsync-1'),
        sourceName: 'Synced Reference Source',
        targetName: 'Synced Reference Target'
      })

      await convergeOnPeer(pageA, pageB, world)

      // The peer renders the reference from its own copy of the source: the
      // resident window must carry route ids, capability and relation metadata.
      await openTopicInUi(pageB, world.targetTopicId)
      const projection = await readTopicProjection(pageB, world.targetTopicId)
      expect(projection.currentTopicId).toBe(world.targetTopicId)
      expect(projection.ids, 'peer route must be the live foreign prefix plus the owned suffix').toEqual(
        world.targetRouteIds
      )
      expect(projection.ids, 'the source message after the anchor must never enter the prefix').not.toContain(
        world.afterAnchorId
      )
      expect(projection.reference, 'peer must hold the synced relation metadata').not.toBeNull()
      expect(projection.reference!.sourceTopicId).toBe(world.sourceTopicId)
      expect(projection.reference!.sourceBranchId).toBeNull()
      expect(projection.reference!.anchorMessageId).toBe(world.prefixIds[3])
      expect(projection.reference!.status).toBe('available')
      expect(projection.reference!.sourceName).toBe(world.sourceName)

      // Read-only foreign prefix vs. target-owned writable suffix.
      for (const id of world.prefixIds) {
        expect(projection.mutable, `foreign prefix ${id} must be read-only on the peer`).not.toContain(id)
      }
      for (const id of world.suffixIds) {
        expect(projection.mutable, `target-owned suffix ${id} must stay mutable on the peer`).toContain(id)
      }

      const divider = pageB.locator('[data-testid="history-reference-divider"]')
      await expect(divider).toBeVisible({ timeout: 30000 })
      await expect(divider).toHaveAttribute('data-reference-status', 'available')
      const link = pageB.locator('[data-testid="history-reference-divider-link"]')
      await expect(link).toBeVisible({ timeout: 15000 })
      await expect(link).toContainText(world.sourceName)

      // Rendered prefix and owned suffix (real DOM, not just IPC).
      await expect(pageB.locator('#messages')).toContainText('ref-source-assistant-3', { timeout: 15000 })
      await expect(pageB.locator('#messages')).toContainText('ref-target-suffix-user', { timeout: 15000 })
      await expect(pageB.locator('#messages')).not.toContainText('ref-source-user-after-anchor')

      // Mutation controls: hidden on the read-only prefix anchor, present on the
      // owned suffix assistant message.
      const prefixContainer = pageB.locator(`[data-message-id="${world.prefixIds[3]}"]`).first()
      await expect(prefixContainer).toBeVisible({ timeout: 15000 })
      try {
        await prefixContainer.hover({ timeout: 8000 })
      } catch {
        await prefixContainer.hover({ force: true, timeout: 5000 })
      }
      await expect(prefixContainer.locator('[data-testid="message-more-menu-btn"]')).toBeAttached({ timeout: 15000 })
      await expect(prefixContainer.locator('[data-testid="message-delete-button"]')).toHaveCount(0)
      await expect(prefixContainer.locator('[data-testid="msg-edit-btn"]')).toHaveCount(0)

      const suffixContainer = pageB.locator(`[data-message-id="${world.suffixIds[1]}"]`).first()
      await expect(suffixContainer).toBeVisible({ timeout: 15000 })
      try {
        await suffixContainer.hover({ timeout: 8000 })
      } catch {
        await suffixContainer.hover({ force: true, timeout: 5000 })
      }
      await expect(suffixContainer.locator('[data-testid="message-delete-button"]')).toHaveCount(1)

      // The peer's writes never touch the source route.
      expect((await fetchRoute(pageA, world.sourceTopicId, null)).ids).toEqual(world.sourceRouteIds)
      expect((await fetchRoute(pageB, world.sourceTopicId, null)).ids).toEqual(world.sourceRouteIds)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('source rename and prefix edit reach the peer; a missing source keeps the relation', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    test.setTimeout(360000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: the peer keeps the reference target OPEN (resident window, no topic switch) while a source rename (production updateTopicMetadata) and a foreign-prefix content edit (production updateMessageAndBlocks) propagate over sync. It proves the remote sync path emits the history-reference invalidation to that resident window (recorded preload hint), that the already-open target then re-reads itself (divider title = renamed source, rendered prefix block = edited content, status available) and that the peer never touches the source route. The missing-source (soft delete) stage is a separate documented-gap case below.'
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
      const world = await seedReferenceWorld(pageA, {
        assistantId: ownerA,
        tag: uniqueTag('e2e-refsync-2'),
        sourceName: 'Mutable Reference Source',
        targetName: 'Mutable Reference Target'
      })
      await convergeOnPeer(pageA, pageB, world)

      // The peer keeps the target OPEN for the rest of the case: every later
      // claim below must hold on the already-resident route, with no topic
      // switch that would force a fresh read and mask a missing notification.
      await openTopicInUi(pageB, world.targetTopicId)
      await waitForReferenceStatus(pageB, world.targetTopicId, 'available')
      await expect(pageB.locator('[data-testid="history-reference-divider-link"]')).toContainText(world.sourceName, {
        timeout: 60000
      })
      await expect(pageB.locator('#messages')).toContainText('ref-source-assistant-1', { timeout: 60000 })

      // Record the hints this resident window really receives (preload
      // contract), so the claims below prove the REMOTE path crossed the IPC
      // boundary instead of inferring it from a rename-driven topic refresh.
      await installReferenceInvalidationRecorder(pageB)

      // --- Source rename + foreign-prefix content edit (live prefix) --------
      const renamedName = 'Renamed Reference Source'
      await renameTopic(pageA, world.sourceTopicId, renamedName)
      await editMessageContent(pageA, world.sourceTopicId, world.prefixIds[1], 'ref-source-assistant-1-edited')
      await pollRouteContent(pageA, world.sourceTopicId, null, 1, 'ref-source-assistant-1-edited')

      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await pollRouteContent(pageB, world.sourceTopicId, null, 1, 'ref-source-assistant-1-edited')
      await pollRouteContent(pageB, world.targetTopicId, null, 1, 'ref-source-assistant-1-edited')

      // CURRENT CLAIM: the target that was already open re-reads itself. No
      // topic switch, no manual reload — the remote sync invalidation must
      // reach the resident route.
      await expect(pageB.locator('[data-testid="history-reference-divider-link"]')).toContainText(renamedName, {
        timeout: 60000
      })
      const invalidations = await readReferenceInvalidations(pageB)
      expect(
        invalidations.some(
          (event) => event.sourceTopicId === world.sourceTopicId && event.targetTopicIds.includes(world.targetTopicId)
        ),
        `the remote source change must deliver a history-reference invalidation to the resident target (received ${JSON.stringify(invalidations)})`
      ).toBe(true)
      // The rendered text is BLOCK content, so the projection link that proves
      // the resident window re-read is the main_text block of the edited
      // prefix message (not `message.content`, which a block-based view never
      // renders directly).
      const storeProjection = await pageB.evaluate(
        (ids: { message: string; target: string }) => {
          const s = (window as unknown as { store?: { getState: () => any } }).store?.getState() as any
          const blocks = Object.values(s?.messageBlocks?.entities ?? {}) as Array<Record<string, unknown>>
          const block = blocks.find(
            (candidate) => candidate.messageId === ids.message && candidate.type === 'main_text'
          )
          return {
            blockContent: (block?.content ?? null) as string | null,
            messageContent: (s?.messages?.entities?.[ids.message]?.content ?? null) as string | null,
            targetIds: (s?.messages?.messageIdsByTopic?.[ids.target] ?? null) as string[] | null
          }
        },
        { message: world.prefixIds[1], target: world.targetTopicId }
      )
      expect(
        storeProjection.blockContent,
        `the resident renderer projection must hold the synced prefix edit: ${JSON.stringify(storeProjection)}`
      ).toBe('ref-source-assistant-1-edited')
      expect(storeProjection.targetIds ?? [], 'the resident target still projects the foreign prefix').toContain(
        world.prefixIds[1]
      )
      await expect(pageB.locator('#messages')).toContainText('ref-source-assistant-1-edited', { timeout: 60000 })
      await waitForReferenceStatus(pageB, world.targetTopicId, 'available')
      const afterMutation = await readTopicProjection(pageB, world.targetTopicId)
      expect(afterMutation.currentTopicId, 'the target must still be the resident topic (no switch)').toBe(
        world.targetTopicId
      )
      expect(afterMutation.reference!.sourceName, 'the divider title must follow the synced rename').toBe(renamedName)
      expect(afterMutation.ids).toEqual(world.targetRouteIds)
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  /**
   * Remote SOURCE SOFT DELETE on an already-open target — no topic switch.
   *
   * The peer's Main converges the relation to `status: 'missing'` and the
   * `ChatDb_HistoryReferenceInvalidated` hint reaches the resident window, so
   * the resident renderer owes Main a re-read of the target's window. This case
   * pins that contract end-to-end: the divider degrades to missing, the foreign
   * prefix leaves the projection, the relation metadata (source topic + anchor)
   * survives, the owned suffix stays mutable and rendered, and the target is
   * still the resident topic throughout (no switch is allowed to stand in for
   * the re-read).
   *
   * The obligation cannot ride on the controller's DOM provenance alone: an
   * ordinary projection apply between the hint and the passive route effect
   * re-stamps provenance clean (`noteSameRouteWindowUpdate` / `rebaseClean`), so
   * the effect's idle guard would skip and the stale `available` relation would
   * stay on screen until the next activation. The renderer keeps an explicit
   * one-shot, topic-bound reload obligation that defeats both idle guards and
   * the in-place activation restore, and is consumed where the re-read pipeline
   * takes ownership (see `isReferenceReloadObliged` and its focused unit test).
   */
  test('soft-deleted source degrades an already-open reference target without a topic switch', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    test.setTimeout(360000)
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
      const world = await seedReferenceWorld(pageA, {
        assistantId: ownerA,
        tag: uniqueTag('e2e-refsync-3'),
        sourceName: 'Trashed Reference Source',
        targetName: 'Trashed Reference Target'
      })
      await convergeOnPeer(pageA, pageB, world)
      await openTopicInUi(pageB, world.targetTopicId)
      await waitForReferenceStatus(pageB, world.targetTopicId, 'available')
      await installReferenceInvalidationRecorder(pageB)
      const hintsBeforeDelete = (await readReferenceInvalidations(pageB)).length

      await softDeleteTopicViaApi(pageA, world.sourceTopicId, 'Trashed Reference Source')
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()

      // Main authority: the trashed source degrades the relation.
      const mainReferenceAfterDelete = await readMainReference(pageB, world.targetTopicId)
      expect(
        mainReferenceAfterDelete?.status,
        `the synced soft delete must degrade the relation on the peer (reference=${JSON.stringify(mainReferenceAfterDelete)})`
      ).toBe('missing')
      // The hint must reach the resident window…
      const hintsAfterDelete = await readReferenceInvalidations(pageB)
      expect(
        hintsAfterDelete.length,
        `the synced soft delete must deliver a history-reference hint to the resident target (before=${hintsBeforeDelete} after=${JSON.stringify(hintsAfterDelete)})`
      ).toBeGreaterThan(hintsBeforeDelete)
      // …and the already-open target must re-read without a topic switch.
      await waitForReferenceStatus(pageB, world.targetTopicId, 'missing')
      const divider = pageB.locator('[data-testid="history-reference-divider"]')
      await expect(divider).toHaveAttribute('data-reference-status', 'missing', { timeout: 60000 })
      await expect(pageB.locator('[data-testid="history-reference-divider-missing"]')).toBeVisible()
      await expect(pageB.locator('[data-testid="history-reference-divider-link"]')).toHaveCount(0)
      expect(
        (await readTopicProjection(pageB, world.targetTopicId)).currentTopicId,
        'the target must still be the resident topic (no switch)'
      ).toBe(world.targetTopicId)

      // The relation survives; only the foreign prefix is omitted.
      expect(await topicExistsViaApi(pageB, world.targetTopicId)).toBe(true)
      await pollRouteIds(pageB, world.targetTopicId, null, world.suffixIds)
      const missingProjection = await readTopicProjection(pageB, world.targetTopicId)
      expect(missingProjection.reference, 'the relation must survive a missing source').not.toBeNull()
      expect(missingProjection.reference!.sourceTopicId).toBe(world.sourceTopicId)
      expect(missingProjection.reference!.anchorMessageId).toBe(world.prefixIds[3])
      expect(missingProjection.ids).toEqual(world.suffixIds)
      for (const id of world.prefixIds) {
        expect(missingProjection.ids, `foreign prefix ${id} must be omitted once the source is gone`).not.toContain(id)
      }
      await expect(pageB.locator('#messages')).toContainText('ref-target-suffix-user', { timeout: 15000 })
      for (const id of world.suffixIds) {
        expect(missingProjection.mutable, `owned suffix ${id} must stay mutable`).toContain(id)
      }
    } finally {
      await closeProfileAndRelay(profileB, relay)
    }
  })

  test('relay baseline survives a file-backed restart: a fresh receiver bootstraps the reference', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    test.setTimeout(540000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: after the reference world converges over an owned file-backed relay and the relay child is stopped and restarted against the same database, a fresh cursor-0 receiver joins the channel, bootstraps from the relay baseline, and reconstructs the identical source route, target effective route, relation metadata, divider and readonly/owned semantics. No protocol version literal is asserted (the behaviour is the contract).'
    })

    const pageA = mainWindow
    let relay: FileBackedRelayHandle | null = null
    let failedRelay: FileBackedRelayHandle | null = null
    let profileB: SecondSyncProfile | null = null
    let profileC: SecondSyncProfile | null = null
    let testError: unknown = null
    try {
      try {
        relay = await startFileBackedRelay({ ownedTmpRoot })
      } catch (e) {
        relay = getFailedRelayHandle(e) ?? relay
        throw e
      }
      const endpoint = relay.endpoint
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint, enabled: true })
      await pairProfilesViaApi(pageA, pageB)
      await setDisplayCount(pageB, DISPLAY_LIMIT)

      const ownerA = await getActiveOwnerAssistantId(pageA)
      const world = await seedReferenceWorld(pageA, {
        assistantId: ownerA,
        tag: uniqueTag('e2e-refsync-base'),
        sourceName: 'Baseline Reference Source',
        targetName: 'Baseline Reference Target'
      })
      await convergeOnPeer(pageA, pageB, world)
      await pollPendingDrained(pageA)
      await pollPendingDrained(pageB)

      // The production automation publishes the relay baseline; wait for it to
      // exist (watermark) without pinning any protocol version literal.
      const observer = await provisionObserverViaRaw(endpoint, pageA)
      let watermark = 0
      const deadline = Date.now() + 120000
      while (Date.now() < deadline) {
        const res = await fetch(`${endpoint}/sync/baseline`, {
          headers: { 'x-sync-device-code': observer.code, 'x-sync-device-secret': observer.secret }
        })
        if (res.status === 200) {
          const body = (await res.json()) as { watermark?: unknown }
          if (typeof body.watermark === 'number' && Number.isSafeInteger(body.watermark) && body.watermark > 0) {
            watermark = body.watermark
            break
          }
        }
        await sleep(1000)
      }
      expect(watermark, 'the relay must hold a published baseline').toBeGreaterThan(0)

      // Owned relay restart against the same DB/port.
      expect(relay.pid()).toBeGreaterThan(0)
      await relay.stop()
      expect(relay.isRunning()).toBe(false)
      await expect(fetch(`${endpoint}/health`)).rejects.toThrow()
      try {
        await relay.restart()
      } catch (e) {
        const failed = getFailedRelayHandle(e)
        if (failed && failed !== relay) failedRelay = failed
        throw e
      }
      expect(relay.isRunning()).toBe(true)
      expect(relay.endpoint).toBe(endpoint)
      const health = await fetch(`${endpoint}/health`)
      expect(health.status).toBe(200)
      await health.json().catch(() => ({}))

      // Fresh cursor-0 receiver bootstraps the complete relationship.
      profileC = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageC = profileC.page
      await setSyncConfigViaApi(pageC, { endpoint, enabled: true })
      await pairProfilesViaApi(pageA, pageC)
      await setDisplayCount(pageC, DISPLAY_LIMIT)
      expect((await runSyncViaApi(pageC)).threw).toBeNull()

      await expect.poll(async () => await topicExistsViaApi(pageC, world.targetTopicId), { timeout: 90000 }).toBe(true)
      await pollRouteIds(pageC, world.sourceTopicId, null, world.sourceRouteIds)
      await pollRouteIds(pageC, world.targetTopicId, null, world.targetRouteIds)
      const statusC = await getSyncStatusViaApi(pageC)
      expect(statusC.cursor).toBeGreaterThanOrEqual(watermark)
      expect(statusC.lastError).toBeNull()

      await openTopicInUi(pageC, world.targetTopicId)
      await waitForReferenceStatus(pageC, world.targetTopicId, 'available')
      const projectionC = await readTopicProjection(pageC, world.targetTopicId)
      expect(projectionC.ids).toEqual(world.targetRouteIds)
      expect(projectionC.reference!.sourceTopicId).toBe(world.sourceTopicId)
      expect(projectionC.reference!.anchorMessageId).toBe(world.prefixIds[3])
      expect(projectionC.reference!.sourceName).toBe(world.sourceName)
      for (const id of world.prefixIds) {
        expect(projectionC.mutable, `bootstrapped prefix ${id} must stay read-only`).not.toContain(id)
      }
      for (const id of world.suffixIds) {
        expect(projectionC.mutable, `bootstrapped owned suffix ${id} must stay mutable`).toContain(id)
      }
      await expect(pageC.locator('[data-testid="history-reference-divider"]')).toHaveAttribute(
        'data-reference-status',
        'available',
        { timeout: 30000 }
      )
      await expect(pageC.locator('[data-testid="history-reference-divider-link"]')).toContainText(world.sourceName)
      await expect(pageC.locator('#messages')).toContainText('ref-source-assistant-3', { timeout: 15000 })
    } catch (e) {
      testError = e
      const failed = getFailedRelayHandle(e)
      if (failed && failed !== relay) failedRelay = failed
    }

    let extraCleanupError: Error | null = null
    if (failedRelay) {
      const extra = failedRelay
      failedRelay = null
      try {
        await extra.close()
      } catch (e) {
        extraCleanupError = e instanceof Error ? e : new Error(String(e))
      }
    }
    try {
      await closeFileRelayAndProfiles(relay, [profileC, profileB])
    } catch (cleanupError) {
      const mainErr = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
      if (extraCleanupError) {
        throw new AggregateError([extraCleanupError, mainErr], 'history-reference sync E2E cleanup failed')
      }
      if (testError) {
        throw new AggregateError(
          [testError instanceof Error ? testError : new Error(String(testError)), mainErr],
          'history-reference sync test and cleanup failed'
        )
      }
      throw mainErr
    }
    if (extraCleanupError) throw extraCleanupError
    if (testError) throw testError
  })
})
