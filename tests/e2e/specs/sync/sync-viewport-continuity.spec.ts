/**
 * Sync ↔ open-chat viewport continuity E2E (two disposable profiles, real
 * test-owned relay, production IPC only).
 *
 * The contract under test is the user-visible one, measured on the ACTUAL open
 * chat of the receiving profile while a real sync wave lands:
 *
 *  - a sync wave that invalidates the open topic must never blank the message
 *    area, never hide it, and never remount the rows the reader is looking at;
 *  - a reader scrolled UP INTO HISTORY (real wheel input, so the app persists
 *    the route's viewport anchor) keeps that anchor row's on-screen offset;
 *  - a reader FOLLOWING the newest edge stays pinned there while the wave's
 *    new rows land — the window never slides back into older history;
 *  - the same continuity holds on a NON-MAIN (branch) route with a peer write
 *    landing on that very route;
 *  - a zero-op sync wave is a visual no-op (no row/scroll change at all);
 *  - a genuine remote delete still updates the rows when it lands (the fix must
 *    not suppress real changes) and the area is never empty mid-wave.
 *
 * The sampler is installed ONLY in the disposable profile page (rAF sampling +
 * MutationObserver on the messages container). It is test-local instrumentation
 * and never touches production code or real user data.
 */

import { expect, test } from '../../fixtures/electron.fixture'
import { activateTopic, prepareAssistant, seedSourceTopic } from '../../utils/branch-route-setup'
import {
  closeSecondSyncProfile,
  launchSecondSyncProfile,
  type SecondSyncProfile
} from '../../utils/sync-second-profile'
import { startTestRelay, type TestRelayHandle } from '../../utils/sync-relay'
import { pageWheelAndSettle } from '../../utils/viewport-scroll-sync'
import {
  appendMessageViaApi,
  deleteMessageViaApi,
  pairProfilesViaApi,
  restoreTopicViaApi,
  runSyncViaApi,
  setSyncConfigViaApi,
  softDeleteTopicViaApi
} from '../../pages/sync.page'

interface ContinuitySample {
  t: number
  rowCount: number
  firstId: string | null
  lastId: string | null
  anchorId: string | null
  anchorTop: number | null
  anchorConnected: boolean
  anchorSameNode: boolean
  scrollTop: number
  /**
   * Sampled scroll-host height. The host is content-sized by design
   * (`flex: 0 1 auto` + documented shrink-to-content in shared.tsx), so a wave
   * that legitimately REMOVES rows (e.g. the foreign prefix of a deleted
   * reference source) also shortens the host; `anchorBottomOffset` is the
   * pinned-edge invariant that survives that.
   */
  containerHeight: number
  /** Anchor offset from the container's pinned (newest/bottom) edge. */
  anchorBottomOffset: number | null
  hidden: boolean
  /** `data-viewport-phase` of the sampled frame (diagnostic only). */
  phase: string
}

/**
 * Install the frame/mutation sampler on the receiving profile's open chat.
 * Records one sample per animation frame plus one per relevant DOM mutation.
 * `anchorId` is the stable row identity the reader is anchored on; the sampler
 * tracks that exact DOM node so a remount (node replacement) is observable even
 * when the row list looks identical.
 */
async function installContinuitySampler(page: any, anchorId: string): Promise<void> {
  await page.evaluate((wanted: string) => {
    const container = document.querySelector('#messages') as HTMLElement | null
    if (!container) throw new Error('messages container #messages missing')
    // Canonical message row only: answer-group tab strips also carry
    // data-message-id but are not the reader's row.
    const findRow = (id: string): HTMLElement | null =>
      (container.querySelector(`[id="message-${CSS.escape(id)}"][data-message-id]`) as HTMLElement | null) ?? null
    const anchorRow = findRow(wanted)
    if (!anchorRow) throw new Error(`anchor row ${wanted} missing before sampling`)
    const samples: ContinuitySample[] = []
    let running = true
    let rafId = 0
    const push = () => {
      const rows = Array.from(container.querySelectorAll('.message[data-message-id]')) as HTMLElement[]
      const anchorNow = findRow(wanted)
      let anchorTop: number | null = null
      if (anchorRow.isConnected) {
        const rect = anchorRow.getBoundingClientRect()
        const base = container.getBoundingClientRect()
        anchorTop = Math.round(rect.top - base.top)
      }
      const style = getComputedStyle(container)
      samples.push({
        t: Math.round(performance.now()),
        rowCount: rows.length,
        firstId: rows[0]?.dataset?.messageId ?? null,
        anchorId: anchorNow?.dataset?.messageId ?? null,
        lastId: rows.length > 0 ? (rows[rows.length - 1]?.dataset?.messageId ?? null) : null,
        scrollTop: Math.round(container.scrollTop),
        containerHeight: Math.round(container.clientHeight),
        anchorBottomOffset: anchorTop === null ? null : Math.round(container.clientHeight - anchorTop),
        anchorTop,
        anchorConnected: anchorRow.isConnected,
        anchorSameNode: anchorNow === anchorRow,
        hidden:
          container.offsetParent === null ||
          style.visibility === 'hidden' ||
          Number(style.opacity) === 0 ||
          container.clientHeight === 0,
        phase: container.getAttribute('data-viewport-phase') ?? ''
      })
    }
    const loop = () => {
      if (!running) return
      push()
      rafId = requestAnimationFrame(loop)
    }
    const observer = new MutationObserver(() => push())
    observer.observe(container, { childList: true, subtree: true, attributes: true, characterData: true })
    rafId = requestAnimationFrame(loop)
    ;(window as any).__e2eContinuity = {
      stop: () => {
        running = false
        cancelAnimationFrame(rafId)
        observer.disconnect()
        return samples
      }
    }
    push()
  }, anchorId)
}

/** Stop sampling and return the recorded frames. */
async function collectContinuity(page: any): Promise<ContinuitySample[]> {
  return (await page.evaluate(() => (window as any).__e2eContinuity?.stop?.() ?? [])) as ContinuitySample[]
}

/** Reader-visible failure modes across the sampled wave. */
function expectNoBlankOrRemount(samples: ContinuitySample[], label: string): void {
  expect(samples.length, `${label}: sampler produced frames`).toBeGreaterThan(0)
  const empty = samples.filter((s) => s.rowCount === 0)
  expect(empty.length, `${label}: frames with an EMPTY message area`).toBe(0)
  const hidden = samples.filter((s) => s.hidden)
  expect(hidden.length, `${label}: frames with the message area hidden`).toBe(0)
  const detached = samples.filter((s) => !s.anchorConnected)
  expect(detached.length, `${label}: frames where the anchor row left the DOM`).toBe(0)
  const swapped = samples.filter((s) => !s.anchorSameNode)
  expect(swapped.length, `${label}: frames where the anchor row was remounted`).toBe(0)
}

/** Reading intent preserved: anchor row keeps its on-screen offset (small tolerance). */
function expectAnchorPreserved(samples: ContinuitySample[], label: string, tolerancePx = 4): void {
  const tops = samples.map((s) => s.anchorTop).filter((t): t is number => typeof t === 'number')
  expect(tops.length, `${label}: anchor measured`).toBeGreaterThan(0)
  const min = Math.min(...tops)
  const max = Math.max(...tops)
  expect(max - min, `${label}: anchor row on-screen offset drift`).toBeLessThanOrEqual(tolerancePx)
}

/**
 * Reading intent preserved across a wave that LEGITIMATELY shrinks the
 * document (the reference target loses its whole foreign prefix when the
 * source is trashed): the scroll host is content-sized by design, so the host
 * itself gets shorter and a top-relative anchor offset must move with it.
 *
 * The invariant the reader actually perceives is measured against the edge the
 * viewport pins to (column-reverse bottom / newest edge): the anchor keeps its
 * offset from that edge, and the pinned edge stays exactly where it was
 * (scrollTop unchanged). Measured on the fixed run: host 403px → 302px while
 * the anchor stayed 106px → 105px from the pinned bottom edge and scrollTop
 * stayed 0 — i.e. only the box shrank, the reader never moved.
 *
 * Same ±4px tolerance as the plain case: this is a stricter instrument, not a
 * relaxed one (a scroll jump, re-anchor, or compensation error shows up here
 * immediately).
 */
function expectAnchorPinnedToEdge(samples: ContinuitySample[], label: string, tolerancePx = 4): void {
  const offsets = samples
    .map((s) => s.anchorBottomOffset)
    .filter((offset): offset is number => typeof offset === 'number')
  expect(offsets.length, `${label}: anchor measured against the pinned edge`).toBeGreaterThan(0)
  expect(Math.max(...offsets) - Math.min(...offsets), `${label}: pinned-edge anchor offset drift`).toBeLessThanOrEqual(
    tolerancePx
  )
  const scrolls = [...new Set(samples.map((s) => s.scrollTop))]
  expect(scrolls, `${label}: the pinned edge never moved (scrollTop)`).toHaveLength(1)
}

/**
 * Compact failure diagnostics: one [E2E] line per wave so a failed assertion
 * names the concrete frame pattern (row counts, detach window, scroll drift).
 */
function summarizeSamples(samples: ContinuitySample[], label: string): string {
  if (samples.length === 0) return `${label}: no frames`
  const rowCounts = samples.map((s) => s.rowCount)
  const scrolls = samples.map((s) => s.scrollTop)
  const tops = samples.map((s) => s.anchorTop).filter((t): t is number => typeof t === 'number')
  const bottomOffsets = samples
    .map((s) => s.anchorBottomOffset)
    .filter((offset): offset is number => typeof offset === 'number')
  const heights = samples.map((s) => s.containerHeight)
  const detached = samples.filter((s) => !s.anchorConnected)
  const swapped = samples.filter((s) => !s.anchorSameNode)
  const empty = samples.filter((s) => s.rowCount === 0)
  const hidden = samples.filter((s) => s.hidden)
  const phases = [...new Set(samples.map((s) => s.phase))]
  return [
    `${label}: frames=${samples.length}`,
    `rows=[${Math.min(...rowCounts)}..${Math.max(...rowCounts)}]`,
    `empty=${empty.length}`,
    `empty=${empty.length}`,
    `hidden=${hidden.length}@${hidden[0]?.t ?? -1}..${hidden[hidden.length - 1]?.t ?? -1}`,
    `phases=[${phases.join(',')}]`,
    `remounted=${swapped.length}`,
    `scrollTop=[${Math.min(...scrolls)}..${Math.max(...scrolls)}]`,
    `anchorTop=[${tops.length > 0 ? Math.min(...tops) : 'n/a'}..${tops.length > 0 ? Math.max(...tops) : 'n/a'}]`,
    `anchorBottomOffset=[${bottomOffsets.length > 0 ? Math.min(...bottomOffsets) : 'n/a'}..${bottomOffsets.length > 0 ? Math.max(...bottomOffsets) : 'n/a'}]`,
    `containerHeight=[${Math.min(...heights)}..${Math.max(...heights)}]`,
    `firstId=${samples[0]?.firstId ?? 'n/a'} lastId=${samples[samples.length - 1]?.lastId ?? 'n/a'}`
  ].join(' ')
}
function isoNow(): string {
  return new Date().toISOString()
}

/** Authority-side message/block rows for a remote append (no provider call). */
function remoteMessage(id: string, topicId: string, assistantId: string, content: string): Record<string, unknown> {
  const now = isoNow()
  return {
    id,
    topicId,
    role: 'user',
    assistantId,
    content,
    status: 'success',
    createdAt: now,
    updatedAt: now
  }
}

function remoteBlock(id: string, messageId: string, content: string): Record<string, unknown> {
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

async function appendRemoteMessage(page: any, topicId: string, assistantId: string, text: string): Promise<string> {
  const messageId = `${topicId}-remote-${text}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  await appendMessageViaApi(page, topicId, remoteMessage(messageId, topicId, assistantId, text), [
    remoteBlock(`${messageId}-block`, messageId, text)
  ])
  return messageId
}
/** Production-reads one route's message ids (never a renderer fabric art). */
async function readRouteIds(page: any, topicId: string, branchId: string | null): Promise<string[]> {
  const res = await page.evaluate(
    async (args: { topicId: string; branchId: string | null }) => await (window as any).api.chatDb.fetchMessages(args),
    { topicId, branchId }
  )
  if (!res || res.ok !== true) throw new Error(`fetchMessages failed: ${JSON.stringify(res?.error ?? null)}`)
  const messages = Array.isArray(res.value?.messages) ? res.value.messages : []
  return messages.map((entry: { id?: unknown }) => String(entry.id))
}

/** Fork a child branch at an owned message through the production capability. */
async function createBranchViaApi(page: any, topicId: string, anchorMessageId: string, name: string): Promise<string> {
  const res = await page.evaluate(
    async (args: { topicId: string; anchorMessageId: string; name: string }) =>
      await (window as any).api.chatDb.createBranch({ ...args, parentBranchId: null }),
    { topicId, anchorMessageId, name }
  )
  if (!res || res.ok !== true) throw new Error(`createBranch failed: ${JSON.stringify(res?.error ?? null)}`)
  const branchId = res.value?.branch?.id
  if (typeof branchId !== 'string' || branchId.length === 0) throw new Error('createBranch returned no branch id')
  return branchId
}

/** Peer/owner write into one specific route through the production IPC. */
async function appendMessageToBranchViaApi(
  page: any,
  topicId: string,
  branchId: string,
  assistantId: string,
  text: string
): Promise<string> {
  const messageId = `${topicId}-route-${text}-${Date.now().toString(36)}`
  const now = isoNow()
  const res = await page.evaluate(
    async (args: Record<string, unknown>) => await (window as any).api.chatDb.appendMessage(args),
    {
      topicId,
      branchId,
      message: {
        id: messageId,
        topicId,
        branchId,
        role: 'user',
        assistantId,
        content: text,
        status: 'success',
        createdAt: now,
        updatedAt: now
      },
      blocks: [remoteBlock(`${messageId}-block`, messageId, text)]
    }
  )
  if (!res || res.ok !== true) throw new Error(`appendMessage(route) failed: ${JSON.stringify(res?.error ?? null)}`)
  return messageId
}

/** Typed chat-state snapshot used by the continuity assertions/diagnostics. */
interface ChatStateSnapshot {
  rendered: Array<string | undefined>
  projectionLen: number
  projectionTail: string[]
  displayCount: number | null
  scrollTop: number | null
  scrollHeight: number | null
  clientHeight: number | null
}

async function readChatState(page: any, topicId: string): Promise<ChatStateSnapshot> {
  return (await page.evaluate((tid: string) => {
    const s = (window as any).store.getState()
    const c = document.querySelector('#messages') as HTMLElement | null
    const rows = c
      ? (Array.from(c.querySelectorAll('.message[data-message-id]')) as HTMLElement[]).map((r) => r.dataset.messageId)
      : []
    const projection = ((s?.messages?.messageIdsByTopic?.[tid] ?? []) as string[]).slice()
    return {
      rendered: rows,
      projectionLen: projection.length,
      projectionTail: projection.slice(-16),
      displayCount: s?.messages?.displayCount ?? null,
      scrollTop: c ? Math.round(c.scrollTop) : null,
      scrollHeight: c?.scrollHeight ?? null,
      clientHeight: c?.clientHeight ?? null
    }
  }, topicId)) as ChatStateSnapshot
}
/** Write-first sync round on both profiles. */
async function syncBoth(writer: any, peer: any): Promise<void> {
  await writer.waitForTimeout(300)
  await runSyncViaApi(writer)
  await runSyncViaApi(peer)
}

/** Activate a route in the real UI (branch selector) and wait for it to load. */
async function switchBranchRoute(page: any, topicId: string, branchId: string | null): Promise<void> {
  await page.waitForFunction(
    (args: { topicId: string; branchId: string | null }) => {
      const s = (window as any).store.getState()
      const branches = s?.topicBranch?.branchesByTopic?.[args.topicId] ?? []
      return args.branchId === null || branches.some((b: { id?: string }) => b?.id === args.branchId)
    },
    { topicId, branchId },
    { timeout: 30000 }
  )
  await page.locator('[data-testid="branch-selector-entry"]').first().click()
  await page.locator('[data-testid="branch-selector-popover"]').first().waitFor({ state: 'visible', timeout: 20000 })
  await page
    .locator(`[data-testid="branch-cascader-item-${branchId ?? 'main'}"]`)
    .first()
    .click()
  await page.waitForFunction(
    (args: { topicId: string; branchId: string | null }) => {
      const s = (window as any).store.getState()
      if ((s?.topicBranch?.activeBranchIdByTopic?.[args.topicId] ?? null) !== args.branchId) return false
      const ids = s?.messages?.messageIdsByTopic?.[args.topicId]
      return Array.isArray(ids) && ids.length > 0 && s?.messages?.loadingByTopic?.[args.topicId] !== true
    },
    { topicId, branchId },
    { timeout: 30000 }
  )
}
function seedId(topicId: string, index: number): string {
  return `${topicId}-msg-${String(index).padStart(5, '0')}`
}

/**
 * History-reference setup/observation helpers for the reference-target
 * continuity case. Everything below goes through production IPC
 * (`window.api.chatDb`) or the resident Redux projection — no rendered-state
 * fabrication and no direct database access.
 */
async function chatDbCall(
  page: any,
  method: string,
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await page.evaluate(
    async (args: { method: string; request: Record<string, unknown> }) =>
      await (window as any).api.chatDb[args.method](args.request),
    { method, request }
  )
  if (!res || res.ok !== true) throw new Error(`chatDb.${method} failed: ${JSON.stringify(res?.error ?? null)}`)
  return (res.value ?? {}) as Record<string, unknown>
}

/** Create a reference target over the source route through Main authority. */
async function createReferencedTargetViaApi(
  page: any,
  args: { sourceTopicId: string; targetTopicId: string; anchorMessageId: string; assistantId: string; name: string }
): Promise<{ sourceTopicId: string; anchorMessageId: string }> {
  const value = await chatDbCall(page, 'createReferencedTopic', {
    sourceTopicId: args.sourceTopicId,
    branchId: null,
    targetTopicId: args.targetTopicId,
    anchorMessageId: args.anchorMessageId,
    assistantId: args.assistantId,
    name: args.name
  })
  const reference = (value.reference ?? {}) as Record<string, unknown>
  return {
    sourceTopicId: String(reference.sourceTopicId ?? ''),
    anchorMessageId: String(reference.anchorMessageId ?? '')
  }
}

/**
 * Make the Main-created reference target reachable from the sidebar.
 *
 * `createReferencedTopic` writes the target topic in Main authority only, so the
 * renderer's assistant topic directory (which drives the sidebar) does not list
 * it yet. Test setup registers that exact topic wire the same way
 * `seedSourceTopic` registers its source topic; the case then opens the target
 * with a real click, never by writing `currentTopicId` directly.
 */
async function registerTopicInSidebar(
  page: any,
  args: { topicId: string; assistantId: string; name: string }
): Promise<void> {
  const added = await page.evaluate((a: { topicId: string; assistantId: string; name: string }) => {
    try {
      ;(window as any).store.dispatch({
        type: 'assistants/addTopic',
        payload: {
          assistantId: a.assistantId,
          topic: {
            id: a.topicId,
            assistantId: a.assistantId,
            name: a.name,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        }
      })
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, err: e instanceof Error ? e.message : String(e) }
    }
  }, args)
  expect(added.ok, `sidebar registration failed: ${(added as { err?: string }).err ?? ''}`).toBe(true)
  await page
    .locator(`[data-testid="topic-item"][data-topic-id="${args.topicId}"]`)
    .waitFor({ state: 'attached', timeout: 15000 })
}

/** Source-side rename: the live source title the divider link renders. */
async function renameTopicViaApi(page: any, topicId: string, name: string): Promise<void> {
  await chatDbCall(page, 'updateTopicMetadata', { topicId, name })
}

/** Source-side atomic main_text edit (message row + rendered block together). */
async function editMainTextViaApi(page: any, topicId: string, messageId: string, content: string): Promise<void> {
  const res = await page.evaluate(
    async (args: { topicId: string }) => await (window as any).api.chatDb.fetchMessages({ ...args, branchId: null }),
    { topicId }
  )
  if (!res || res.ok !== true) throw new Error(`fetchMessages failed: ${JSON.stringify(res?.error ?? null)}`)
  const blocks = (Array.isArray(res.value?.blocks) ? res.value.blocks : []) as Array<Record<string, unknown>>
  const block = blocks.find((candidate) => candidate.messageId === messageId && candidate.type === 'main_text')
  if (!block) throw new Error(`main_text block for ${messageId} missing`)
  await chatDbCall(page, 'updateMessageAndBlocks', {
    topicId,
    branchId: null,
    messageUpdates: { id: messageId, content },
    blocksToUpdate: [{ ...block, content }]
  })
}

interface ReferenceStateSnapshot {
  status: string | null
  sourceName: string | null
  ids: string[]
  currentTopicId: string | null
}

/** Resident relation metadata + route window of one topic (store projection). */
async function readReferenceState(page: any, topicId: string): Promise<ReferenceStateSnapshot> {
  return (await page.evaluate((tid: string) => {
    const s = (window as any).store.getState()
    const reference = s?.messages?.historyReferenceByTopic?.[tid] ?? null
    return {
      status: reference ? String(reference.status) : null,
      sourceName: reference ? ((reference.sourceName ?? null) as string | null) : null,
      ids: ((s?.messages?.messageIdsByTopic?.[tid] ?? []) as string[]).slice(),
      currentTopicId: (s?.messages?.currentTopicId ?? null) as string | null
    }
  }, topicId)) as ReferenceStateSnapshot
}

async function waitForReferenceState(page: any, topicId: string, want: 'available' | 'missing'): Promise<void> {
  await page.waitForFunction(
    (args: { tid: string; want: string }) => {
      const s = (window as any).store.getState()
      return (s?.messages?.historyReferenceByTopic?.[args.tid]?.status ?? null) === args.want
    },
    { tid: topicId, want },
    { timeout: 60000 }
  )
}

/** Record the Main→renderer history-reference hints that reach this window. */
async function installReferenceHintRecorder(page: any): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    w.__e2eRefHints = []
    w.__e2eProjectionHints = []
    const subscribe = w.api?.chatDb?.onHistoryReferenceInvalidated
    if (typeof subscribe !== 'function') throw new Error('onHistoryReferenceInvalidated unavailable')
    subscribe((event: any) => w.__e2eRefHints.push({ ...(event ?? {}), at: Math.round(performance.now()) }))
    const subscribeProjection = w.api?.chatDb?.onChatProjectionInvalidated
    if (typeof subscribeProjection === 'function') {
      subscribeProjection((event: any) =>
        w.__e2eProjectionHints.push({
          topicIds: Array.isArray(event?.topicIds) ? event.topicIds : [],
          reason: event?.reason ?? null,
          at: Math.round(performance.now())
        })
      )
    }
  })
}

async function readReferenceHints(
  page: any
): Promise<Array<{ sourceTopicId: string; targetTopicIds: string[]; at?: number }>> {
  return (await page.evaluate(() => (window as any).__e2eRefHints ?? [])) as Array<{
    sourceTopicId: string
    targetTopicIds: string[]
    at?: number
  }>
}

async function readProjectionHints(
  page: any
): Promise<Array<{ topicIds: string[]; reason: string | null; at: number }>> {
  return (await page.evaluate(() => (window as any).__e2eProjectionHints ?? [])) as Array<{
    topicIds: string[]
    reason: string | null
    at: number
  }>
}

/** Return the reader to the newest edge with real wheel input, then settle. */
async function scrollBackToNewest(page: any, snapshotKeys: string[]): Promise<number> {
  const readTop = async (): Promise<number> =>
    (await page.evaluate(() =>
      Math.round((document.querySelector('#messages') as HTMLElement | null)?.scrollTop ?? 0)
    )) as number
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await readTop()) >= -1) break
    await pageWheelAndSettle(page, snapshotKeys, 600)
  }
  return await readTop()
}

test.describe('sync ↔ open chat viewport continuity', () => {
  test.setTimeout(300000)

  let relay: TestRelayHandle | null = null
  let second: SecondSyncProfile | null = null

  /**
   * Record every resident-projection transition of the reference relation while a
   * wave lands: status/route length/current topic/loading, one entry per store
   * change (bounded). Diagnostic only — the strict assertions stay in the case.
   */
  async function installReferenceTrace(page: any, topicId: string): Promise<void> {
    await page.evaluate((tid: string) => {
      const w = window as any
      const trace: Array<Record<string, unknown>> = []
      w.__e2eRefTrace = trace
      const read = () => {
        const s = w.store.getState()
        const reference = s?.messages?.historyReferenceByTopic?.[tid] ?? null
        return {
          t: Math.round(performance.now()),
          status: reference ? String(reference.status) : null,
          sourceName: reference ? ((reference.sourceName ?? null) as string | null) : null,
          ids: ((s?.messages?.messageIdsByTopic?.[tid] ?? []) as string[]).length,
          currentTopicId: (s?.messages?.currentTopicId ?? null) as string | null,
          loading: s?.messages?.loadingByTopic?.[tid] === true,
          phase: (document.querySelector('#messages') as HTMLElement | null)?.getAttribute('data-viewport-phase') ?? ''
        }
      }
      let last = JSON.stringify(read())
      w.__e2eRefTraceStop = () => {
        try {
          w.__e2eRefTraceUnsub?.()
        } catch {
          // already detached
        }
        return trace
      }
      w.__e2eRefTraceUnsub = w.store.subscribe(() => {
        const next = read()
        const key = JSON.stringify(next)
        if (key === last) return
        last = key
        if (trace.length < 400) trace.push(next)
      })
      trace.push(read())
    }, topicId)
  }
  async function collectReferenceTrace(page: any): Promise<Array<Record<string, unknown>>> {
    return (await page.evaluate(() => (window as any).__e2eRefTraceStop?.() ?? [])) as Array<Record<string, unknown>>
  }

  /**
   * Main-side IPC trace: which chatDb commands the renderer actually issues.
   *
   * This is the only way to tell "the resident window re-read from Main" apart
   * from "the resident window never asked" without guessing from the DOM. It
   * wraps the already-registered invoke handlers in the test-owned main process
   * (bounded request summaries only; no payload contents).
   */
  async function installMainIpcTrace(electronApp: any): Promise<void> {
    await electronApp.evaluate(({ ipcMain }: any) => {
      const g = globalThis as any
      if (g.__e2eIpcTraceInstalled) {
        g.__e2eIpcTrace = []
        return
      }
      g.__e2eIpcTrace = []
      const handlers = ipcMain?._invokeHandlers as Map<string, (event: unknown, request: any) => unknown> | undefined
      if (!handlers || typeof handlers.set !== 'function') throw new Error('ipcMain._invokeHandlers unavailable')
      for (const [channel, handler] of Array.from(handlers.entries())) {
        if (!channel.startsWith('chatdb:')) continue
        handlers.set(channel, (event: unknown, request: any) => {
          try {
            if (g.__e2eIpcTrace.length < 400) {
              g.__e2eIpcTrace.push({
                channel,
                topicId: typeof request?.topicId === 'string' ? request.topicId : null,
                kind: typeof request?.kind === 'string' ? request.kind : null,
                at: Date.now()
              })
            }
          } catch {
            // trace only
          }
          return handler(event, request)
        })
      }
      g.__e2eIpcTraceInstalled = true
    })
  }

  async function resetMainIpcTrace(electronApp: any): Promise<void> {
    await electronApp.evaluate(() => {
      ;(globalThis as any).__e2eIpcTrace = []
    })
  }

  async function readMainIpcTrace(electronApp: any): Promise<Array<Record<string, unknown>>> {
    return (await electronApp.evaluate(() => ((globalThis as any).__e2eIpcTrace ?? []).slice())) as Array<
      Record<string, unknown>
    >
  }

  /** How many Main window reads the renderer issued for one topic since the last reset. */
  async function windowReadsSince(electronApp: any, topicId: string): Promise<number> {
    const entries = await readMainIpcTrace(electronApp)
    return entries.filter((entry) => entry.channel === 'chatdb:fetch-messages-window' && entry.topicId === topicId)
      .length
  }

  test.beforeEach(async () => {
    relay = await startTestRelay()
  })

  test.afterEach(async () => {
    if (second) {
      await closeSecondSyncProfile(second).catch(() => {})
      second = null
    }
    if (relay) {
      await relay.close().catch(() => {})
      relay = null
    }
  })

  async function setupPairedProfiles(mainWindow: any, ownedTmpRoot: string, mockPort: number) {
    const pageA = mainWindow
    relay = relay ?? (await startTestRelay())
    second = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
    const pageB = second.page
    await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
    await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
    await pairProfilesViaApi(pageA, pageB)
    return { pageA, pageB }
  }

  /** Seed one topic on A, open it in the UI and settle the window. */
  async function openSeededTopic(
    pageA: any,
    total: number,
    displayCount: number
  ): Promise<{ topicId: string; ids: string[]; assistantId: string }> {
    const assistantId = await prepareAssistant(pageA, displayCount)
    const topicId = `e2e-cont-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const ids = await seedSourceTopic(pageA, {
      assistantId,
      topicId,
      name: 'Continuity',
      total,
      messageIdForIndex: (i: number) => seedId(topicId, i),
      contentPrefix: 'continuity-'
    })
    await activateTopic(pageA, topicId, displayCount)
    return { topicId, ids, assistantId }
  }

  /** Scroll the open chat so a mid-topic row is the reader anchor and settle. */
  async function anchorOnRow(pageA: any, messageId: string): Promise<void> {
    await pageA.evaluate((id: string) => {
      const el = document.querySelector(`#messages [id="message-${CSS.escape(id)}"][data-message-id]`) as HTMLElement
      if (!el) throw new Error(`row ${id} missing`)
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
    }, messageId)
    // Settle: the row is mounted and the topic is not loading…
    await pageA.waitForFunction(
      (id: string) => {
        const s = (window as any).store.getState()
        const c = document.querySelector('#messages') as HTMLElement | null
        const el = document.querySelector(`#messages [id="message-${CSS.escape(id)}"][data-message-id]`)
        const topicId = s?.messages?.currentTopicId
        return !!c && !!el && s?.messages?.loadingByTopic?.[topicId] !== true
      },
      messageId,
      { timeout: 30000 }
    )
    // …and the scroll position is stable across consecutive frames.
    await pageA.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const container = document.querySelector('#messages') as HTMLElement
          let last = -1
          let stable = 0
          const tick = () => {
            const now = Math.round(container.scrollTop)
            stable = now === last ? stable + 1 : 0
            last = now
            if (stable >= 2) resolve()
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
    )
  }

  test('ordinary route: a sync wave keeps rows, visibility and the reading anchor', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const { pageA, pageB } = await setupPairedProfiles(mainWindow, ownedTmpRoot, mockPort)
    const { topicId, ids, assistantId } = await openSeededTopic(pageA, 40, 12)

    // First convergence so both profiles hold the topic, then B becomes the writer.
    await syncBoth(pageA, pageB)

    // Reader position: the default latest position (the reader never scrolled),
    // i.e. the open window holds the newest rows of the route.
    const anchorId = ids[ids.length - 6]
    await anchorOnRow(pageA, anchorId)
    const before = await readChatState(pageA, topicId)
    await installContinuitySampler(pageA, anchorId)

    // Real remote rows written on B (authority side), then a full sync wave.
    const remoteOne = await appendRemoteMessage(pageB, topicId, assistantId, 'remote-one')
    const remoteTwo = await appendRemoteMessage(pageB, topicId, assistantId, 'remote-two')
    await syncBoth(pageB, pageA)
    await pageA.waitForTimeout(1500)

    // A second identical wave (the per-successful-op hint pair re-fires).
    await syncBoth(pageB, pageA)
    await pageA.waitForTimeout(1000)

    const samples = await collectContinuity(pageA)
    console.log(`[E2E] ${summarizeSamples(samples, 'ordinary route')}`)
    expectNoBlankOrRemount(samples, 'ordinary route')
    // The open projection is FOLLOWING the newest edge (this reader never
    // scrolled), so an older row's pixel offset legitimately moves when newer
    // rows land. What must never happen: a blank/remount, a scroll jump, or a
    // window that back-fills older history behind the reader's back.
    const scrollTops = samples.map((s) => s.scrollTop)
    expect(Math.max(...scrollTops) - Math.min(...scrollTops), 'follower stays at the newest edge').toBeLessThanOrEqual(
      1
    )

    // The wave moved the OPEN projection FORWARD: both remote rows are now
    // rendered, the reading position never moved, and the refresh never slid
    // the window backwards into older history behind the reader's back.
    const after = await readChatState(pageA, topicId)
    expect(after.rendered, 'both remote rows are rendered after the wave').toEqual(
      expect.arrayContaining([remoteOne, remoteTwo])
    )
    expect(after.scrollTop, 'the reading position did not move').toBe(before.scrollTop)
    const allowed = new Set<string>([...ids.slice(-14), remoteOne, remoteTwo])
    for (const renderedId of after.rendered) {
      expect(allowed.has(String(renderedId)), `row ${renderedId} is not an older back-filled row`).toBe(true)
    }
  })

  test('scrolled-up reading position: a sync wave keeps the anchor row and its offset', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const { pageA, pageB } = await setupPairedProfiles(mainWindow, ownedTmpRoot, mockPort)
    const { topicId, assistantId } = await openSeededTopic(pageA, 40, 12)
    await syncBoth(pageA, pageB)

    // A real wheel scroll (trusted input) records the reader's own reading
    // position: the app persists the first-visible stable ID as the route's
    // viewport snapshot, which is exactly the anchor a hint refresh must use.
    const snapshotKeys = [`scroll:topic-${topicId}::main`]
    let settled = await pageWheelAndSettle(pageA, snapshotKeys, -400)
    for (let attempt = 0; attempt < 3 && settled.snapshotId === ''; attempt += 1) {
      settled = await pageWheelAndSettle(pageA, snapshotKeys, -300)
    }
    expect(settled.snapshotId, 'the reading position is persisted as a stable row id').not.toBe('')
    expect(settled.scrollTop, 'the reader really scrolled into history').not.toBe(0)

    const anchorId = settled.snapshotId
    const anchorOffset = settled.offset
    await installContinuitySampler(pageA, anchorId)

    // A peer write that only appends far away in the route: the reader's own
    // interval must not be rebuilt or re-centred.
    await appendRemoteMessage(pageB, topicId, assistantId, 'remote-while-reading')
    await syncBoth(pageB, pageA)
    await pageA.waitForTimeout(1500)

    const samples = await collectContinuity(pageA)
    console.log(`[E2E] ${summarizeSamples(samples, 'reading position')}`)
    expectNoBlankOrRemount(samples, 'reading position')
    expectAnchorPreserved(samples, 'reading position')

    // The reader is still on the same rows: the anchor row kept its on-screen
    // offset (asserted above) and the route window still contains it.
    const state = await readChatState(pageA, topicId)
    expect(state.projectionTail, 'the open window still contains the reading anchor').toContain(anchorId)
    expect(typeof anchorOffset).toBe('number')
  })

  test('branch route: the same continuity holds on a non-main route', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const { pageA, pageB } = await setupPairedProfiles(mainWindow, ownedTmpRoot, mockPort)

    // Seed WITHOUT opening the topic: the fork and its owned suffix must exist
    // before the resident route loads, so the branch catalog the UI mounts with
    // already contains the route (no fabricated Redux route state).
    const assistantId = await prepareAssistant(pageA, 12)
    const topicId = `e2e-cont-branch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const ids = await seedSourceTopic(pageA, {
      assistantId,
      topicId,
      name: 'Continuity Branch',
      total: 40,
      messageIdForIndex: (i: number) => seedId(topicId, i),
      contentPrefix: 'continuity-branch-'
    })

    // Deterministic non-main route: fork at a main-route message through the
    // production branch capability and give the route an owned suffix so the
    // reader's anchor has rows below it (no bottom-follow).
    const branchAnchorId = ids[ids.length - 8]
    const branchId = await createBranchViaApi(pageA, topicId, branchAnchorId, 'continuity-branch')
    const suffixIds: string[] = []
    for (const text of ['branch-suffix-0', 'branch-suffix-1', 'branch-suffix-2', 'branch-suffix-3']) {
      suffixIds.push(await appendMessageToBranchViaApi(pageA, topicId, branchId, assistantId, text))
    }

    await activateTopic(pageA, topicId, 12)
    // Converge so B holds the topic and the branch route before it writes.
    await syncBoth(pageA, pageB)
    await switchBranchRoute(pageA, topicId, branchId)

    const anchorId = suffixIds[1]
    await anchorOnRow(pageA, anchorId)
    await installContinuitySampler(pageA, anchorId)
    const routeLengthBefore = (await readRouteIds(pageA, topicId, branchId)).length

    // A peer write lands on THIS route, so the wave the reader sees is a real
    // same-route authority change, not a main-route change in another route.
    const remoteId = await appendMessageToBranchViaApi(pageB, topicId, branchId, assistantId, 'remote-branch-ward')
    await syncBoth(pageB, pageA)
    await pageA.waitForTimeout(1500)

    const samples = await collectContinuity(pageA)
    console.log(`[E2E] ${summarizeSamples(samples, 'branch route')}`)
    expectNoBlankOrRemount(samples, 'branch route')
    expectAnchorPreserved(samples, 'branch route')

    // The branch route really received the remote row after the settle.
    await pageA.waitForFunction(
      (id: string) => !!document.querySelector(`#messages [id="message-${CSS.escape(id)}"][data-message-id]`),
      remoteId,
      { timeout: 30000 }
    )
    const routeLengthAfter = (await readRouteIds(pageA, topicId, branchId)).length
    expect(routeLengthAfter, 'branch route gained exactly the remote row').toBe(routeLengthBefore + 1)
  })

  test('zero-op sync is a visual no-op, and a true remote delete still lands', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const { pageA, pageB } = await setupPairedProfiles(mainWindow, ownedTmpRoot, mockPort)
    const { topicId, ids } = await openSeededTopic(pageA, 40, 12)
    await runSyncViaApi(pageB)
    await runSyncViaApi(pageA)
    await pageB.waitForTimeout(500)

    const anchorId = ids[ids.length - 6]
    await anchorOnRow(pageA, anchorId)

    // Zero-op wave: nothing changed on either side.
    const before = await pageA.evaluate(() => {
      const c = document.querySelector('#messages') as HTMLElement
      const rows = Array.from(c.querySelectorAll('.message[data-message-id]')) as HTMLElement[]
      return {
        count: rows.length,
        first: rows[0]?.dataset?.messageId ?? null,
        last: rows[rows.length - 1]?.dataset?.messageId ?? null,
        scrollTop: Math.round(c.scrollTop)
      }
    })
    await installContinuitySampler(pageA, anchorId)
    await runSyncViaApi(pageB)
    await runSyncViaApi(pageA)
    await runSyncViaApi(pageB)
    await runSyncViaApi(pageA)
    await pageA.waitForTimeout(1200)
    const idleSamples = await collectContinuity(pageA)

    expectNoBlankOrRemount(idleSamples, 'zero-op wave')
    const changed = idleSamples.filter(
      (s) => s.rowCount !== before.count || s.firstId !== before.first || s.lastId !== before.last
    )
    expect(changed.length, 'zero-op sync must not change the rendered rows').toBe(0)
    const scrolled = idleSamples.filter((s) => Math.abs(s.scrollTop - before.scrollTop) > 1)
    expect(scrolled.length, 'zero-op sync must not move the reading position').toBe(0)

    // A genuine remote delete must still reach the open projection.
    const victim = ids[ids.length - 7]
    await deleteMessageViaApi(pageB, topicId, victim)
    await installContinuitySampler(pageA, anchorId)
    await runSyncViaApi(pageB)
    await runSyncViaApi(pageA)
    await pageA.waitForTimeout(1500)
    const deleteSamples = await collectContinuity(pageA)

    // Never blank while applying a real change…
    expectNoBlankOrRemount(deleteSamples, 'delete wave')
    // …and the deleted row really disappears once the wave settles.
    await pageA.waitForFunction(
      (gone: string) => !document.querySelector(`#messages [id="message-${CSS.escape(gone)}"][data-message-id]`),
      victim,
      { timeout: 30000 }
    )
  })

  /**
   * The history-reference refresh contract, measured on the reader's screen.
   *
   * A reference target's foreign prefix is LIVE source data: when the source
   * route changes remotely (rename / content edit / soft delete) the open
   * target must re-read and show the change. What it must never do is trade
   * that update for a visible disturbance: the message area may not go blank,
   * become hidden, remount the rows the reader is looking at, or lose the
   * reader's reading anchor. This case asserts both halves together — exact
   * final relation status/prefix content PLUS continuous visible frames —
   * because the existing reference-sync asset only checks eventual semantics.
   */
  test('reference target: a remote source change updates the open target with no blank frame', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort,
    electronApp
  }) => {
    const { pageA, pageB } = await setupPairedProfiles(mainWindow, ownedTmpRoot, mockPort)
    await installMainIpcTrace(electronApp)
    const assistantId = await prepareAssistant(pageA, 12)
    const tag = `e2e-cont-ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const sourceTopicId = `${tag}-src`
    const targetTopicId = `${tag}-dst`
    const sourceName = 'Continuity Ref Source'

    // Source route (20 rows) is created first; the reference target then takes
    // the WHOLE source route as its read-only foreign prefix (anchor = last
    // source row) and appends its own writable suffix after the divider, so the
    // open target window is scrollable and the divider sits inside it.
    const sourceIds = await seedSourceTopic(pageA, {
      assistantId,
      topicId: sourceTopicId,
      name: sourceName,
      total: 20,
      messageIdForIndex: (i: number) => `${tag}-m${String(i).padStart(2, '0')}`,
      contentPrefix: 'cont-ref-src-'
    })
    const createdReference = await createReferencedTargetViaApi(pageA, {
      sourceTopicId,
      targetTopicId,
      anchorMessageId: sourceIds[sourceIds.length - 1],
      assistantId,
      name: 'Continuity Ref Target'
    })
    expect(createdReference.sourceTopicId, 'the relation points at the source topic').toBe(sourceTopicId)
    expect(createdReference.anchorMessageId).toBe(sourceIds[sourceIds.length - 1])
    // The target topic exists in Main authority; give the sidebar its entry so
    // the reader can open it with a real click (same setup idiom as the source).
    await registerTopicInSidebar(pageA, {
      topicId: targetTopicId,
      assistantId,
      name: 'Continuity Ref Target'
    })
    const suffixIds: string[] = []
    for (const [index, text] of ['cont-ref-suffix-0', 'cont-ref-suffix-1'].entries()) {
      const id = `${tag}-s${index}`
      await appendMessageViaApi(pageA, targetTopicId, remoteMessage(id, targetTopicId, assistantId, text), [
        remoteBlock(`${id}-block`, id, text)
      ])
      suffixIds.push(id)
    }
    expect(
      await readRouteIds(pageA, targetTopicId, null),
      'the target effective route is the foreign prefix plus the owned suffix'
    ).toEqual([...sourceIds, ...suffixIds])

    // Converge so the peer holds both topics before it writes to the source.
    await syncBoth(pageA, pageB)
    await expect
      .poll(async () => (await readRouteIds(pageB, sourceTopicId, null)).length, { timeout: 90000 })
      .toBe(sourceIds.length)
    await expect
      .poll(async () => (await readRouteIds(pageB, targetTopicId, null)).length, { timeout: 90000 })
      .toBe(sourceIds.length + suffixIds.length)

    // The reader opens the reference target and stays on it for every wave.
    await activateTopic(pageA, targetTopicId, 12)
    await waitForReferenceState(pageA, targetTopicId, 'available')
    await expect(pageA.locator('[data-testid="history-reference-divider"]')).toBeVisible({ timeout: 30000 })
    await installReferenceHintRecorder(pageA)

    // Reader position: a real wheel scroll persists their own reading anchor.
    const snapshotKeys = [`scroll:topic-${targetTopicId}::main`]
    let settled = await pageWheelAndSettle(pageA, snapshotKeys, -400)
    for (let attempt = 0; attempt < 3 && settled.snapshotId === ''; attempt += 1) {
      settled = await pageWheelAndSettle(pageA, snapshotKeys, -300)
    }
    expect(settled.snapshotId, 'the reading position is persisted as a stable row id').not.toBe('')
    const readingAnchor = settled.snapshotId
    expect(settled.scrollTop, 'the reader really scrolled into the foreign prefix').not.toBe(0)

    // Wave 1 — source rename (live divider title).
    await installContinuitySampler(pageA, readingAnchor)
    const hintsBeforeRename = (await readReferenceHints(pageA)).length
    const renamedSource = 'Continuity Ref Source Renamed'
    await resetMainIpcTrace(electronApp)
    await renameTopicViaApi(pageB, sourceTopicId, renamedSource)
    await syncBoth(pageB, pageA)
    await expect(pageA.locator('[data-testid="history-reference-divider-link"]')).toContainText(renamedSource, {
      timeout: 60000
    })
    await pageA.waitForTimeout(1200)
    const renameSamples = await collectContinuity(pageA)
    console.log(`[E2E] rename wave window reads=${await windowReadsSince(electronApp, targetTopicId)}`)
    console.log(`[E2E] ${summarizeSamples(renameSamples, 'reference rename wave')}`)
    expect(
      (await readReferenceHints(pageA)).length,
      'the synced source rename must deliver a history-reference hint to the resident target'
    ).toBeGreaterThan(hintsBeforeRename)
    expectNoBlankOrRemount(renameSamples, 'reference rename wave')
    expectAnchorPreserved(renameSamples, 'reference rename wave')
    const afterRename = await readReferenceState(pageA, targetTopicId)
    expect(afterRename.sourceName, 'the relation carries the live source name').toBe(renamedSource)
    expect(afterRename.status).toBe('available')
    expect(afterRename.currentTopicId, 'the target is still the resident topic').toBe(targetTopicId)

    // Wave 2 — a foreign prefix message edit (live prefix content).
    await installContinuitySampler(pageA, readingAnchor)
    const editedSourceRow = sourceIds[18]
    await resetMainIpcTrace(electronApp)
    await editMainTextViaApi(pageB, sourceTopicId, editedSourceRow, 'cont-ref-src-00018-edited')
    await syncBoth(pageB, pageA)
    await expect(pageA.locator('#messages')).toContainText('cont-ref-src-00018-edited', { timeout: 60000 })
    await pageA.waitForTimeout(1200)
    const editSamples = await collectContinuity(pageA)
    console.log(`[E2E] edit wave window reads=${await windowReadsSince(electronApp, targetTopicId)}`)
    console.log(`[E2E] ${summarizeSamples(editSamples, 'reference prefix-edit wave')}`)
    expectNoBlankOrRemount(editSamples, 'reference prefix-edit wave')
    expectAnchorPreserved(editSamples, 'reference prefix-edit wave')
    expect(
      (await readReferenceState(pageA, targetTopicId)).ids,
      'the edited prefix row keeps its canonical source identity'
    ).toContain(editedSourceRow)

    // Wave 3 — the source is trashed. The reader is back at the newest edge and
    // anchored on an owned suffix row that must survive the degradation.
    const newestEdge = await scrollBackToNewest(pageA, snapshotKeys)
    expect(newestEdge, 'the reader returned to the newest edge').toBeGreaterThanOrEqual(-1)
    await installContinuitySampler(pageA, suffixIds[1])
    await installReferenceTrace(pageA, targetTopicId)
    {
      const waves12 = await readMainIpcTrace(electronApp)
      const byChannel: Record<string, number> = {}
      for (const entry of waves12) {
        const key = `${String(entry.channel).replace('chatdb:', '')}${entry.topicId === targetTopicId ? '(target)' : ''}`
        byChannel[key] = (byChannel[key] ?? 0) + 1
      }
      console.log(`[E2E] reference waves 1-2 renderer IPC=${JSON.stringify(byChannel)}`)
    }
    await resetMainIpcTrace(electronApp)
    const deleteWaveStart = (await pageA.evaluate(() => Math.round(performance.now()))) as number
    const hintsBeforeDelete = (await readReferenceHints(pageA)).length
    // Capture the resident renderer's diagnostic output for the WHOLE delete
    // wave (the reference path can log while the hint itself is being handled,
    // i.e. before this point used to install the listener).
    const rendererConsole: string[] = []
    const onConsole = (msg: any) => {
      try {
        const text = String(msg.text?.() ?? '')
        if (/reference|routeInvalidation|historyReference|fetchMessagesWindow|window/i.test(text)) {
          rendererConsole.push(`[${String(msg.type?.() ?? 'log')}] ${text}`)
        }
      } catch {
        // ignore capture failures
      }
    }
    pageA.on('console', onConsole)
    await softDeleteTopicViaApi(pageB, sourceTopicId, sourceName)
    await syncBoth(pageB, pageA)
    // Diagnostics first: name the layer (Main relation vs hint delivery vs
    // resident re-read) before the strict assertions below.
    const deleteWaveIpcEntries = await readMainIpcTrace(electronApp)
    const deleteWaveChannels: Record<string, number> = {}
    for (const entry of deleteWaveIpcEntries) {
      const key = `${String(entry.channel).replace('chatdb:', '')}${entry.topicId === targetTopicId ? '(target)' : ''}`
      deleteWaveChannels[key] = (deleteWaveChannels[key] ?? 0) + 1
    }
    const deleteWaveProjectionHints = (await readProjectionHints(pageA)).filter((hint) => hint.at >= deleteWaveStart)
    {
      const windowValue = await chatDbCall(pageA, 'fetchMessagesWindow', {
        kind: 'latest',
        topicId: targetTopicId,
        branchId: null,
        limit: 20
      })
      const mainReference = (windowValue.reference ?? null) as Record<string, unknown> | null
      const resident = await readReferenceState(pageA, targetTopicId)
      const hints = await readReferenceHints(pageA)
      console.log(
        `[E2E] reference soft-delete wave: mainReference=${JSON.stringify(mainReference)} ` +
          `residentStatus=${JSON.stringify(resident.status)} residentIds=${resident.ids.length}`
      )
      console.log(
        `[E2E] reference soft-delete wave hints: before=${hintsBeforeDelete} waveStart=${deleteWaveStart} ` +
          `all=${JSON.stringify(hints)}`
      )
      console.log(
        `[E2E] reference soft-delete wave renderer IPC=${JSON.stringify(deleteWaveChannels)} ` +
          `projectionHints=${JSON.stringify(
            deleteWaveProjectionHints.map((hint) => ({
              reason: hint.reason,
              targets: hint.topicIds.includes(targetTopicId) ? 1 : 0,
              at: hint.at
            }))
          )}`
      )
      console.log(`[E2E] reference soft-delete wave renderer console=${JSON.stringify(rendererConsole.slice(-60))}`)
    }
    try {
      await waitForReferenceState(pageA, targetTopicId, 'missing')
    } catch (error) {
      console.log(
        `[E2E] delete-wave diagnostics trace=${JSON.stringify(await collectReferenceTrace(pageA)).slice(0, 4000)}`
      )
      console.log(`[E2E] delete-wave renderer console=${JSON.stringify(rendererConsole.slice(-40))}`)
      // Layer probe: replay the SAME production hint through the real Main→
      // renderer channel. If the resident window re-reads now, the handler and
      // the re-read pipeline are healthy and the delete-time hint was lost or
      // swallowed; if it still does not, the hint path itself is broken.
      await electronApp.evaluate(
        ({ BrowserWindow }: any, payload: any) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (win && !win.isDestroyed()) win.webContents.send('chatdb:history-reference-invalidated', payload)
          }
        },
        { sourceTopicId, targetTopicIds: [targetTopicId] }
      )
      await resetMainIpcTrace(electronApp)
      await pageA.waitForTimeout(4000)
      const replayState = await readReferenceState(pageA, targetTopicId)
      console.log(
        `[E2E] delete-wave replay hint: reads=${await windowReadsSince(electronApp, targetTopicId)} ` +
          `status=${JSON.stringify(replayState.status)} ids=${replayState.ids.length}`
      )
      // Second discriminator: is the reference refresh pipeline stuck at this
      // state, or does it refuse only the missing-relation answer? Restore the
      // source and rename it: a live relation change must re-read.
      await restoreTopicViaApi(pageB, sourceTopicId)
      await syncBoth(pageB, pageA)
      await renameTopicViaApi(pageB, sourceTopicId, 'Continuity Ref Source Restored')
      await syncBoth(pageB, pageA)
      await pageA.waitForTimeout(3000)
      const probeState = await readReferenceState(pageA, targetTopicId)
      console.log(
        `[E2E] delete-wave post-restore probe: reads=${await windowReadsSince(electronApp, targetTopicId)} ` +
          `status=${JSON.stringify(probeState.status)} sourceName=${JSON.stringify(probeState.sourceName)} ` +
          `ids=${probeState.ids.length}`
      )
      pageA.off('console', onConsole)
      throw error
    }
    pageA.off('console', onConsole)
    await expect(pageA.locator('[data-testid="history-reference-divider"]')).toHaveAttribute(
      'data-reference-status',
      'missing',
      { timeout: 60000 }
    )
    await pageA.waitForTimeout(1200)
    const deleteSamples = await collectContinuity(pageA)
    console.log(`[E2E] ${summarizeSamples(deleteSamples, 'reference soft-delete wave')}`)
    expect(
      (await readReferenceHints(pageA)).length,
      'the synced source soft delete must deliver a history-reference hint to the resident target'
    ).toBeGreaterThan(hintsBeforeDelete)
    expectNoBlankOrRemount(deleteSamples, 'reference soft-delete wave')
    // The trashed source drops the WHOLE foreign prefix, so the content-sized
    // scroll host legitimately gets shorter; the reader's own anchor row must
    // still hold its offset from the pinned newest edge and that edge must not
    // move (same ±4px tolerance, measured against the edge the viewport pins to).
    expectAnchorPinnedToEdge(deleteSamples, 'reference soft-delete wave')
    const afterDelete = await readReferenceState(pageA, targetTopicId)
    expect(afterDelete.currentTopicId, 'no topic switch stands in for the re-read').toBe(targetTopicId)
    expect(afterDelete.ids, 'the foreign prefix is dropped and exactly the owned suffix survives').toEqual(suffixIds)
    expect(afterDelete.status).toBe('missing')
    await expect(pageA.locator('#messages')).toContainText('cont-ref-suffix-0', { timeout: 15000 })
    await expect(pageA.locator('#messages')).not.toContainText('cont-ref-src-00018-edited', { timeout: 15000 })
  })
})
