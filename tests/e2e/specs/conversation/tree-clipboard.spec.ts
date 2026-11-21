/**
 * Tree clipboard — opt-in "copy/cut including child branches" — INTEGRATED E2E.
 *
 * Durable asset for ONE coherent business workflow: a user selects a complete
 * turn group on the active route, opts in to the tree action hanging off the
 * ordinary copy/cut button, and the captured closure — the selected root group
 * plus the OWN rows of every child branch anchored at a selected root, all the
 * way down its descendants — travels as one Main-authority tree payload. The
 * paste creates an independent target topology (fresh message/block/branch/
 * segment IDs, remapped anchors, parents and own rows) and the whole command is
 * ONE history action that a single Undo/Redo replays from Main's own snapshot.
 *
 * Covered promises (approved behavior):
 * - Discoverability without a new permanent control: the ordinary toolbar
 *   copy/cut buttons keep their testids, their default action and their
 *   keyboard shortcuts (`Meta+c` / `Meta+x`). The opt-in tree action is the
 *   copy/cut item's SUBMENU of the message context menu, offered only while the
 *   selection really carries the anchor of a direct child branch, so the
 *   ordinary actions keep their meaning and no control is added to the bar.
 * - Capture scope: only branches whose parent is the source route AND whose
 *   anchor is one of the selected root messages (plus their complete subtrees,
 *   OWN rows only) are captured — an unrelated sibling branch anchored outside
 *   the selection is never pulled in, and no ancestor/shared prefix is
 *   re-materialized.
 * - Paste: fresh independent IDs, remapped assistant `askId`, remapped branch
 *   parents/anchors, remapped segment membership/header, root rows owned by the
 *   target route and branch rows owned by the generated branches. The source
 *   topic is never modified by a copy.
 * - `copy` payloads stay reusable (a second paste generates a second independent
 *   ID set); a `cut` payload is spent on a successful paste and the clipboard is
 *   cleared, and its source removal happens in the SAME Main transaction as the
 *   target insert (staging a cut never mutates the source).
 * - ONE history action of type `clipboard_tree` per paste carrying Main's
 *   snapshot: one Undo restores the source rows/branches AND removes exactly the
 *   inserted target rows; one Redo re-applies the same structure with the same
 *   generated IDs.
 * - Persistence: the final topology is read back from Main after a topic/route
 *   revisit and, post-exit, from SQLite itself.
 * - Windowed history: a tree copy taken on a route whose older pages are loaded
 *   keeps the loaded projection (Main's own route delta is merged in place), so
 *   the pages the user paged in survive the paste, one Undo and one Redo, the
 *   copied rows still render at the tail, and older paging keeps working
 *   afterwards — all without leaving the topic.
 *
 * Evidence classes: real UI gestures (edit-mode turn cover selection, genuine
 * wheel paging to the older edge, right-click context menu + copy/cut submenu,
 * keyboard `Meta+v` / `Meta+z` / `Meta+Shift+z`, topic list activation,
 * topic-header route switch, true-branch toolbar fork) plus read-only Main
 * authority probes (`fetchMessagesWindow`, `listBranches`, `listSegments`) and
 * post-exit SQLite queries. Redux reads are used only as projection/queue
 * oracles, never as persistence proof. No production code is bypassed on the
 * proof path.
 *
 * Disclosed setup: topics, branch-owned rows and segment catalogs are seeded
 * through the existing read/write IPC (`ensureTopic`/`pasteMessagesToTopic`/
 * `upsertSegment`) and the display-count reducer, exactly like the sibling
 * conversation specs. FIRST-level branches are forked through the real
 * true-branch toolbar control; a NESTED branch cannot be forked through the UI
 * (a child route renders its rows inside the collapsed branch holder, which has
 * no message menubars), and the windowed case needs a direct child branch to
 * exist before its topic is first displayed, so those two fixtures are created
 * through the same `createBranch` IPC the toolbar itself calls; each one's
 * anchor/parent is asserted before use.
 */
import * as fs from 'fs'

import { expect, getChatDbPath, queryChatDbViaElectronWithRetry, test } from '../../fixtures/electron.fixture'
import { letterMessageId, listBranches, pad, prepareAssistant, seedSourceTopic } from '../../utils/branch-route-setup'

const EPOCH = '2026-01-01T00:00:00.000Z'

function uniqueTopicId(prefix: string): string {
  return `e2e-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

interface SeededEntry {
  message: Record<string, unknown>
  blocks: Record<string, unknown>[]
}

/** Deterministic alternating user/assistant entries (assistant askId = previous id). */
function entriesFor(topicId: string, ids: string[], contents: string[]): SeededEntry[] {
  return ids.map((id, index) => {
    const role = index % 2 === 0 ? 'user' : 'assistant'
    const blockId = `${id}-block`
    const message: Record<string, unknown> = {
      id,
      topicId,
      role,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      status: 'success',
      blocks: [blockId],
      sortOrder: index
    }
    if (role === 'assistant') {
      message.model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
      message.modelId = 'mock-model'
      message.askId = ids[index - 1]
    }
    return {
      message,
      blocks: [
        {
          id: blockId,
          messageId: id,
          type: 'main_text',
          content: contents[index],
          status: 'success',
          createdAt: EPOCH,
          updatedAt: EPOCH
        }
      ]
    }
  })
}

/** Setup only: persist rows directly as the OWN rows of one branch route. */
async function seedBranchRows(
  page: any,
  topicId: string,
  branchId: string,
  ids: string[],
  contents: string[]
): Promise<void> {
  const entries = entriesFor(topicId, ids, contents)
  const result: any = await page.evaluate(
    async ({ topicId, branchId, entries }: { topicId: string; branchId: string; entries: SeededEntry[] }) => {
      try {
        const api: any = (window as any).api.chatDb
        const pasted = await api.pasteMessagesToTopic({ topicId, branchId, entries })
        return { ok: pasted?.ok === true, raw: pasted }
      } catch (e) {
        return { ok: false, raw: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, branchId, entries }
  )
  expect(result.ok, `branch-row seed failed: ${JSON.stringify(result.raw)}`).toBe(true)
}

/** Setup only: one segment group with exact membership on the addressed route. */
async function seedSegment(
  page: any,
  topicId: string,
  branchId: string | null,
  segmentId: string,
  messageIds: string[]
): Promise<void> {
  const result: any = await page.evaluate(
    async ({
      topicId,
      branchId,
      segmentId,
      messageIds
    }: {
      topicId: string
      branchId: string | null
      segmentId: string
      messageIds: string[]
    }) => {
      try {
        const api: any = (window as any).api.chatDb
        const created = await api.upsertSegment({ segmentId, topicId, branchId, name: segmentId, messageIds })
        return { ok: created?.ok === true, raw: created }
      } catch (e) {
        return { ok: false, raw: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, branchId, segmentId, messageIds }
  )
  expect(result.ok, `segment seed failed: ${JSON.stringify(result.raw)}`).toBe(true)
}

interface RouteRead {
  ids: string[]
  contentById: Record<string, string>
}

/** Read-only Main authority probe: effective route rows plus their block contents. */
async function readRoute(page: any, topicId: string, branchId: string | null): Promise<RouteRead> {
  const result: any = await page.evaluate(
    async ({ topicId, branchId }: { topicId: string; branchId: string | null }) => {
      const api: any = (window as any).api.chatDb
      const res = await api.fetchMessagesWindow({ kind: 'latest', topicId, branchId, limit: 100 })
      if (res?.ok !== true) return { ok: false, raw: res }
      const messages = (res.value.messages ?? []) as any[]
      const blocks = (res.value.blocks ?? []) as any[]
      return {
        ok: true,
        ids: messages.map((message: any) => String(message.id)),
        blocks: blocks.map((block: any) => ({
          messageId: String(block.messageId),
          content: String(block.content ?? '')
        }))
      }
    },
    { topicId, branchId }
  )
  expect(result.ok, `fetchMessagesWindow(${topicId}, ${branchId}) failed: ${JSON.stringify(result.raw)}`).toBe(true)
  const contentById: Record<string, string> = {}
  for (const block of result.blocks as Array<{ messageId: string; content: string }>) {
    contentById[block.messageId] = block.content
  }
  return { ids: result.ids as string[], contentById }
}

async function readRouteIds(page: any, topicId: string, branchId: string | null): Promise<string[]> {
  return (await readRoute(page, topicId, branchId)).ids
}

/**
 * Every message id currently rendered in the chat viewport. A topic activation
 * settles on its own loaded projection, but a route of the PREVIOUS topic can
 * have the same row count, so a rendering claim always polls this instead of
 * reading it once.
 */
async function readRenderedIds(page: any): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#messages [data-message-id]')).map((node) =>
      String(node.getAttribute('data-message-id'))
    )
  )
}

/**
 * The loaded (resident) projection of one topic: the app's own record of which
 * pages the user has paged in. This is the oracle for "the window the user was
 * reading survived the command", never a DOM row count.
 */
async function readLoadedIds(page: any, topicId: string): Promise<string[]> {
  return page.evaluate((tid: string) => {
    const ids = (window as any).store.getState().messages?.messageIdsByTopic?.[tid]
    return Array.isArray(ids) ? ids.map((id: any) => String(id)) : []
  }, topicId)
}

/**
 * Genuine user paging: wheel UP over `#messages` until the app's own older-page
 * request grows the loaded projection. The growth must leave the previously
 * loaded rows as the list's SUFFIX — older pages are prepended, so "the loaded
 * window survived" stays a meaningful claim for the write under proof.
 */
async function wheelLoadOlder(page: any, topicId: string): Promise<string[]> {
  const before = await readLoadedIds(page, topicId)
  const box = await page.locator('#messages').first().boundingBox()
  expect(box, '#messages scroll host must be laid out for paging').toBeTruthy()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  let current = before
  for (let step = 0; step < 48 && current.length === before.length; step++) {
    await page.mouse.wheel(0, -2400)
    await frameSettle(page)
    await page.waitForTimeout(160)
    current = await readLoadedIds(page, topicId)
  }
  expect(current.length, 'wheel paging must load an older page from genuine user intent').toBeGreaterThan(before.length)
  expect(current.slice(current.length - before.length), 'older pages prepend to the loaded window').toEqual(before)
  return current
}

/**
 * Renderer branch catalog of one topic (`null` while it has not been fetched):
 * the menu offers the opt-in tree action only against a known catalog, so the
 * gesture waits for the app's own catalog rather than guessing.
 */
async function readBranchCatalogIds(page: any, topicId: string): Promise<string[] | null> {
  return page.evaluate((tid: string) => {
    const branches = (window as any).store.getState().topicBranch?.branchesByTopic?.[tid]
    return Array.isArray(branches) ? branches.map((branch: any) => String(branch.id)) : null
  }, topicId)
}

/**
 * Genuine user intent at the newest edge: wheel DOWN over `#messages` until the
 * host reaches its physical bottom, then prove the given rows are real rendered
 * rows there. Nothing is scrolled programmatically, so the in-place projection
 * commit is proven to be reachable by reading forward.
 *
 * "Reachable" is bounded by viewport height, not by an absolute claim: a group
 * taller than the 403px viewport can never show all of its rows at once, so the
 * claim is (a) every row is rendered, (b) the LAST row is inside the viewport at
 * the true bottom, and (c) the host really is at its maximum scroll offset.
 * A failed reveal reports the host scroll metrics and the rendered tail so a
 * windowing stall is distinguishable from a wrong gesture.
 */
async function revealTailRows(page: any, ids: string[]): Promise<void> {
  const box = await page.locator('#messages').first().boundingBox()
  expect(box, '#messages scroll host must be laid out to reveal the tail').toBeTruthy()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  const readTailState = async (): Promise<Record<string, unknown>> =>
    page.evaluate((targetIds: string[]) => {
      const host = document.getElementById('messages') as HTMLElement | null
      if (!host) return { why: '#messages absent' }
      const viewport = host.getBoundingClientRect()
      const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
      const inViewport = (row: HTMLElement): boolean => {
        const rect = row.getBoundingClientRect()
        return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
      }
      const renderedIds = rows.map((row) => String(row.getAttribute('data-message-id')))
      const lastTarget = targetIds[targetIds.length - 1]
      const lastRow = rows.find((row) => row.getAttribute('data-message-id') === lastTarget)
      return {
        scrollTop: Math.round(host.scrollTop),
        scrollHeight: Math.round(host.scrollHeight),
        clientHeight: Math.round(host.clientHeight),
        atBottom: Math.round(host.scrollTop + host.clientHeight) >= Math.round(host.scrollHeight) - 1,
        unrendered: targetIds.filter((id) => !renderedIds.includes(id)),
        lastTargetInViewport: lastRow ? inViewport(lastRow) : false,
        renderedTail: renderedIds.slice(-8)
      }
    }, ids)
  const reachedNewestEdge = (state: Record<string, unknown>): boolean =>
    state.atBottom === true && (state.unrendered as string[]).length === 0 && state.lastTargetInViewport === true
  let steps = 0
  let state = await readTailState()
  while (steps < 48 && !reachedNewestEdge(state)) {
    await page.mouse.wheel(0, 2400)
    await frameSettle(page)
    await page.waitForTimeout(120)
    state = await readTailState()
    steps++
  }
  expect(
    reachedNewestEdge(state),
    `genuine scrolling must reach the newest edge with the pasted rows rendered there: ${JSON.stringify(state)}`
  ).toBe(true)
}

interface SegmentRead {
  id: string
  headerMessageId: string | null
  messageIds: string[]
}
/** Rendered segment group headers: `{id, header}` of the DOM the user sees. */
async function readRenderedSegmentGroups(page: any): Promise<Array<{ id: string | null; header: string | null }>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="topic-segment-group"]')).map((node) => ({
      id: node.getAttribute('data-segment-id'),
      header: node.getAttribute('data-segment-header')
    }))
  )
}

/**
 * The renderer's own segment catalog (never Main): the segment projection the
 * message list renders group headers from. Used to separate "the app never
 * converged the catalog" from "the group exists but is not mounted".
 */
async function readRendererSegment(
  page: any,
  topicId: string,
  segmentId: string
): Promise<{ present: boolean; header: string | null; members: string[] | null; ids: string[] }> {
  return page.evaluate(
    ({ topicId, segmentId }: { topicId: string; segmentId: string }) => {
      const state = (window as any).store.getState()
      const ids = (state.topicSegments?.segmentsByTopic?.[topicId] ?? []) as string[]
      const entity = state.topicSegments?.segments?.entities?.[segmentId] ?? null
      return {
        present: ids.includes(segmentId),
        header: entity ? (entity.headerMessageId == null ? null : String(entity.headerMessageId)) : null,
        members: entity ? ((entity.messageIds ?? []) as unknown[]).map(String) : null,
        ids: ids.map(String)
      }
    },
    { topicId, segmentId }
  )
}

async function readSegments(page: any, topicId: string): Promise<SegmentRead[]> {
  const result: any = await page.evaluate(async (tid: string) => {
    const api: any = (window as any).api.chatDb
    const res = await api.listSegments({ topicId: tid })
    if (res?.ok !== true) return { ok: false, raw: res }
    return {
      ok: true,
      segments: (res.value ?? []).map((segment: any) => ({
        id: String(segment.id),
        headerMessageId: segment.headerMessageId == null ? null : String(segment.headerMessageId),
        messageIds: (segment.messageIds ?? []).map((id: any) => String(id))
      }))
    }
  }, topicId)
  expect(result.ok, `listSegments(${topicId}) failed: ${JSON.stringify(result.raw)}`).toBe(true)
  return result.segments as SegmentRead[]
}

interface HistoryRead {
  undo: Array<{ id: string; type: string }>
  redo: Array<{ id: string; type: string }>
}

async function readHistory(page: any): Promise<HistoryRead> {
  return page.evaluate(() => {
    const state = (window as any).store.getState()
    const mapAction = (action: any) => ({ id: String(action.id), type: String(action.type) })
    return {
      undo: ((state.undoStack?.undoStack ?? []) as any[]).map(mapAction),
      redo: ((state.undoStack?.redoStack ?? []) as any[]).map(mapAction)
    }
  })
}

interface ClipboardRead {
  mode: string | null
  itemGroups: number
  itemMessageCount: number
  treePresent: boolean
  treeMeta: any
  tree: {
    sourceTopicId: string
    sourceBranchId: string | null
    rootMessageIds: string[]
    messageIds: string[]
    branches: Array<{ id: string; parent: string | null; anchor: string; depth: number }>
    segments: Array<{ id: string; header: string | null; members: string[] }>
  } | null
}

async function readClipboard(page: any): Promise<ClipboardRead> {
  return page.evaluate(() => {
    const state = (window as any).store.getState()
    const clipboard = state.clipboard ?? {}
    const items = (clipboard.items ?? []) as any[]
    const tree = clipboard.tree ?? null
    return {
      mode: clipboard.mode ?? null,
      itemGroups: items.length,
      itemMessageCount: items.reduce((sum: number, item: any) => sum + (item?.messages?.length ?? 0), 0),
      treePresent: tree != null,
      treeMeta: tree?.meta ?? null,
      tree:
        tree == null
          ? null
          : {
              sourceTopicId: String(tree.payload.source.topicId),
              sourceBranchId: tree.payload.source.branchId ?? null,
              rootMessageIds: ((tree.payload.roots ?? []) as any[]).flatMap((root: any) =>
                (root.messageIds ?? []).map((id: any) => String(id))
              ),
              messageIds: ((tree.payload.messages ?? []) as any[]).map((message: any) => String(message.id)),
              branches: ((tree.payload.branches ?? []) as any[]).map((branch: any) => ({
                id: String(branch.sourceBranchId),
                parent: branch.parentSourceBranchId ?? null,
                anchor: String(branch.anchorMessageId),
                depth: Number(branch.depth)
              })),
              segments: ((tree.payload.segments ?? []) as any[]).map((segment: any) => ({
                id: String(segment.sourceSegmentId),
                header: segment.headerMessageId == null ? null : String(segment.headerMessageId),
                members: ((segment.memberIds ?? []) as any[]).map((id: any) => String(id))
              }))
            }
    }
  })
}

async function readActiveRoute(page: any, topicId: string): Promise<string | null> {
  return page.evaluate((tid: string) => {
    const state = (window as any).store.getState()
    return (state.topicBranch?.activeBranchIdByTopic?.[tid] ?? null) as string | null
  }, topicId)
}

async function readEditEnabled(page: any): Promise<boolean> {
  return page.evaluate(() => (window as any).store.getState().editMode?.enabled === true)
}

/** Real UI: enable edit mode through its toggle when it is not already on. */
async function ensureEditMode(page: any): Promise<void> {
  if (await readEditEnabled(page)) {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="edit-turn"]').length > 0, undefined, {
      timeout: 30000
    })
    return
  }
  const toggle = page.locator('[data-testid="edit-mode-toggle"]').first()
  await expect(toggle, 'edit-mode toggle must be available').toBeVisible({ timeout: 30000 })
  await toggle.click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="edit-turn"]').length > 0, undefined, {
    timeout: 30000
  })
}

/**
 * One truthfully hit-testable point on the edit-turn cover of `askId`.
 *
 * In edit mode the turn content is inert and a sibling
 * `[data-testid=edit-turn-cover]` receives pointer input, so a real gesture
 * needs a point the browser itself resolves to that cover. The point is chosen
 * inside cover ∩ `#messages` ∩ window, skips the floating action-bar buttons
 * (they sit above the viewport and would swallow the click), and is accepted
 * only when `elementFromPoint` lands on the cover of the SAME turn — a bounding
 * box alone happily reports an off-screen coordinate as clickable.
 */
interface TurnCoverPoint {
  ok: boolean
  x: number
  y: number
  coverRect: { x: number; y: number; width: number; height: number } | null
  containerRect: { x: number; y: number; width: number; height: number } | null
  detail: Record<string, unknown>
}

async function readTurnCoverPoint(page: any, askId: string): Promise<TurnCoverPoint> {
  return page.evaluate((turnAsk: string) => {
    const escapeAttr = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const detail: Record<string, unknown> = {}
    const turn = document.querySelector(
      `[data-testid="edit-turn"][data-turn-ask="${escapeAttr(turnAsk)}"]`
    ) as HTMLElement | null
    const container = document.getElementById('messages') as HTMLElement | null
    const miss = (why: string) => ({
      ok: false,
      x: -1,
      y: -1,
      coverRect: null,
      containerRect: null,
      detail: { ...detail, why }
    })
    if (!turn) return miss('no edit turn for this ask id')
    if (!container) return miss('#messages scroll host absent')
    const cover = turn.querySelector('[data-testid="edit-turn-cover"]') as HTMLElement | null
    if (!cover) return miss('the turn has no cover')
    const cr = cover.getBoundingClientRect()
    const vr = container.getBoundingClientRect()
    const coverRect = { x: cr.left, y: cr.top, width: cr.width, height: cr.height }
    const containerRect = { x: vr.left, y: vr.top, width: vr.width, height: vr.height }
    detail.coverRect = coverRect
    detail.containerRect = containerRect
    // The floating edit action bar occludes the top band of the viewport.
    let barTop = Infinity
    let barBottom = -Infinity
    let barLeft = Infinity
    let barRight = -Infinity
    for (const button of Array.from(document.querySelectorAll('[data-testid^="edit-"][data-testid$="-btn"]'))) {
      const rect = (button as HTMLElement).getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      barTop = Math.min(barTop, rect.top)
      barBottom = Math.max(barBottom, rect.bottom)
      barLeft = Math.min(barLeft, rect.left)
      barRight = Math.max(barRight, rect.right)
    }
    const inBar = (x: number, y: number) =>
      Number.isFinite(barTop) && x >= barLeft - 6 && x <= barRight + 6 && y >= barTop - 6 && y <= barBottom + 6
    const ix0 = Math.max(cr.left, vr.left) + 5
    const iy0 = Math.max(cr.top, vr.top) + 5
    const ix1 = Math.min(cr.right, vr.right) - 5
    const iy1 = Math.min(cr.bottom, vr.bottom) - 5
    // Preserve the measured rects: the reveal loop steers by them, so dropping
    // them here would make an out-of-viewport cover look "unmeasurable".
    if (ix1 - ix0 < 8 || iy1 - iy0 < 8) {
      return {
        ok: false,
        x: -1,
        y: -1,
        coverRect,
        containerRect,
        detail: { ...detail, why: 'the cover is not inside the scroll viewport' }
      }
    }
    for (const fy of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const x = ix0 + (ix1 - ix0) * fx
        const y = iy0 + (iy1 - iy0) * fy
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue
        if (inBar(x, y)) continue
        const hit = document.elementFromPoint(x, y) as HTMLElement | null
        if (!hit) continue
        const hitCover = hit.closest('[data-testid="edit-turn-cover"]') as HTMLElement | null
        const hitTurn = hit.closest('[data-testid="edit-turn"]') as HTMLElement | null
        if (!hitCover || !hitTurn || hitTurn.getAttribute('data-turn-ask') !== turnAsk) continue
        return { ok: true, x, y, coverRect, containerRect, detail: { ...detail, hit: hit.tagName } }
      }
    }
    return {
      ok: false,
      x: -1,
      y: -1,
      coverRect,
      containerRect,
      detail: { ...detail, why: 'no point of this cover owns its hit target' }
    }
  }, askId)
}

/**
 * Direction hint for a turn that is not mounted at all: compare its position in
 * the app's own loaded window against the positions of the rows currently in the
 * DOM. Without it a reveal has no geometry to follow and would guess.
 */
async function readTurnScrollHint(page: any, askId: string): Promise<'up' | 'down' | null> {
  return page.evaluate((turnAsk: string) => {
    const byTopic = (window as any).store.getState().messages?.messageIdsByTopic ?? {}
    let loaded: string[] | null = null
    for (const ids of Object.values(byTopic) as unknown[]) {
      if (Array.isArray(ids) && (ids as unknown[]).map(String).includes(turnAsk)) {
        loaded = (ids as unknown[]).map(String)
        break
      }
    }
    if (!loaded) return null
    const targetIndex = loaded.indexOf(turnAsk)
    const renderedIndexes = Array.from(document.querySelectorAll('#messages [data-message-id]'))
      .map((node) => loaded!.indexOf(String(node.getAttribute('data-message-id'))))
      .filter((index) => index >= 0)
    if (renderedIndexes.length === 0) return 'up'
    if (targetIndex < Math.min(...renderedIndexes)) return 'up'
    if (targetIndex > Math.max(...renderedIndexes)) return 'down'
    return null
  }, askId)
}

async function frameSettle(page: any): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
}

/**
 * Genuine user-intent reveal: wheel over `#messages` (the scroll host owns the
 * overflow, while the route-stable viewport keeper compensates programmatic
 * `scrollIntoView`) and follow the cover's own geometry on every step instead
 * of assuming a scroll distance, remeasuring after each wheel.
 *
 * A failed reveal reports the first wheel steps (wheel delta, host scrollTop and
 * the cover's viewport y) so a stuck scroll is distinguishable from a wrong
 * direction or a host that re-pins itself.
 */
async function wheelTurnIntoView(page: any, askId: string, maxSteps = 40): Promise<TurnCoverPoint> {
  const focusMessages = async (): Promise<void> => {
    const box = await page.locator('#messages').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  }
  const readScrollTop = async (): Promise<number | null> =>
    page.evaluate(() => {
      const host = document.getElementById('messages') as HTMLElement | null
      return host ? Math.round(host.scrollTop) : null
    })
  await focusMessages()
  let last = await readTurnCoverPoint(page, askId)
  const steps: Array<Record<string, unknown>> = []
  for (let step = 0; step < maxSteps && !last.ok; step++) {
    let dy = 480
    if (last.coverRect && last.containerRect) {
      const cTop = last.containerRect.y
      const cBottom = last.containerRect.y + last.containerRect.height
      const middle = last.coverRect.y + last.coverRect.height / 2
      if (last.coverRect.y + last.coverRect.height <= cTop) {
        dy = -Math.min(3000, Math.max(420, Math.round(cTop - middle)))
      } else if (last.coverRect.y >= cBottom) {
        dy = Math.min(3000, Math.max(420, Math.round(middle - (cTop + (cBottom - cTop) / 2))))
      } else {
        dy = middle < cTop + (cBottom - cTop) / 2 ? -240 : 240
      }
    } else {
      // The turn is not mounted yet: follow the loaded-window order instead of
      // guessing a direction (a resident row can be far outside the mounted DOM).
      const hint = await readTurnScrollHint(page, askId)
      if (hint === 'up') dy = -1600
      else if (hint === 'down') dy = 1600
    }
    const scrollTopBefore = await readScrollTop()
    await focusMessages()
    await page.mouse.wheel(0, dy)
    await frameSettle(page)
    await page.waitForTimeout(120)
    last = await readTurnCoverPoint(page, askId)
    if (steps.length < 6) {
      steps.push({
        dy,
        scrollTopBefore,
        scrollTopAfter: await readScrollTop(),
        coverY: last.coverRect ? Math.round(last.coverRect.y) : null,
        why: last.ok ? null : last.detail.why
      })
    }
  }
  if (!last.ok) return { ...last, detail: { ...last.detail, steps } }
  return last
}

/** Real UI: one click (optionally with Meta held) on a selected/selecting turn. */
async function clickTurnCover(page: any, askId: string, options: { meta?: boolean } = {}): Promise<void> {
  const point = await wheelTurnIntoView(page, askId)
  expect(point.ok, `edit turn ${askId} must expose a hit-testable cover point: ${JSON.stringify(point.detail)}`).toBe(
    true
  )
  if (!options.meta) {
    await page.mouse.click(point.x, point.y)
    return
  }
  await page.keyboard.down('Meta')
  try {
    await page.mouse.click(point.x, point.y)
  } finally {
    await page.keyboard.up('Meta')
  }
}

async function readSelectedGroupIds(page: any): Promise<string[]> {
  return page.evaluate(() => ((window as any).store.getState().editMode?.selectedGroupIds ?? []) as string[])
}

/**
 * Real UI: select one complete turn group through its cover, then prove the
 * selection registered in the app's own state before a menu action reads it.
 */
async function selectTurn(page: any, askId: string): Promise<void> {
  await clickTurnCover(page, askId)
  await page.waitForFunction(
    (expected: string) => {
      const state = (window as any).store.getState()
      const selected = (state.editMode?.selectedGroupIds ?? []) as string[]
      return selected.includes(expected)
    },
    askId,
    { timeout: 30000 }
  )
}

/**
 * Ordinary clipboard confirmations render in the same top band as a menu opened
 * over a turn; they auto-dismiss, so they are waited out instead of clicked
 * through.
 */
async function waitForToastsCleared(page: any): Promise<void> {
  await expect
    .poll(async () => page.locator('.ant-message-notice').count(), {
      timeout: 20000,
      intervals: [250, 500],
      message: 'app toasts must clear before the turn menu is addressed'
    })
    .toBe(0)
}

/** Real UI: the production turn context menu, opened on a hit-tested cover point. */
async function openTurnContextMenu(page: any, askId: string): Promise<void> {
  const point = await wheelTurnIntoView(page, askId)
  expect(
    point.ok,
    `edit turn ${askId} must expose a right-clickable cover point: ${JSON.stringify(point.detail)}`
  ).toBe(true)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(
    page.locator('.ant-dropdown-menu:visible').first(),
    'the turn context menu must open at the right-clicked turn'
  ).toBeVisible({ timeout: 15000 })
}

/**
 * Does the app clipboard currently carry a captured tree payload?
 */
async function readClipboardTreePresent(page: any): Promise<boolean> {
  return page.evaluate(() => (window as any).store.getState().clipboard?.tree != null)
}

/**
 * Real UI: run the opt-in tree action from its product location.
 *
 * The action is NOT a permanent toolbar control: while the selection really
 * carries the anchor of a direct child branch, the copy/cut item of the turn
 * context menu becomes a SUBMENU whose second row is "… including child
 * branches", so the ordinary action keeps its own meaning one level up and the
 * action bar keeps its existing buttons.
 *
 * Everything here is addressed by rc-menu key suffix, never by label text: the
 * visible strings are locale values. The parent row is a grouping item (hover
 * and click only expand it — clicking it must not run any copy/cut), which the
 * helper proves by comparing the clipboard across that click.
 */
async function runTreeActionFromContextMenu(page: any, askId: string, kind: 'copy' | 'cut'): Promise<void> {
  await waitForToastsCleared(page)
  // The turn menu acts on the user's selection, so opening it must not change
  // that selection (a collapsed selection would capture fewer roots than the
  // user chose). Both sides are recorded for the failure diagnostic.
  const selectedBefore = await readSelectedGroupIds(page)
  await openTurnContextMenu(page, askId)
  const selectedAfter = await readSelectedGroupIds(page)
  // Both rows are addressed by rc-menu key suffix (labels are locale values).
  // The grouping ROW carries `data-menu-id` on its title element (rc-menu puts
  // the id on the title div, not on the `li`); the leaf row carries it on its
  // menu item, which only exists once the submenu popup is open.
  const childRow = page.locator(`.ant-dropdown-menu-submenu-popup [data-menu-id$="-${kind}WithChildren"]`).first()
  const submenuTitle = page.locator(`.ant-dropdown-menu-submenu-title[data-menu-id$="-${kind}"]`).first()
  const childVisible = async (timeout = 2000): Promise<boolean> =>
    childRow
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false)
  const readMenuSnapshot = async (): Promise<Record<string, unknown>> =>
    page.evaluate((suffix: string) => {
      const rectOf = (el: Element | null): number[] | null => {
        if (!el) return null
        const rect = el.getBoundingClientRect()
        return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]
      }
      const title = document.querySelector(`.ant-dropdown-menu-submenu-title[data-menu-id$="${suffix}"]`)
      const titleRect = title instanceof Element ? title.getBoundingClientRect() : null
      const at =
        titleRect && titleRect.width > 0
          ? document.elementFromPoint(titleRect.x + titleRect.width / 2, titleRect.y + titleRect.height / 2)
          : null
      return {
        dropdowns: document.querySelectorAll('.ant-dropdown-menu').length,
        submenuTitles: document.querySelectorAll('.ant-dropdown-menu-submenu-title').length,
        submenuPopups: document.querySelectorAll('.ant-dropdown-menu-submenu-popup').length,
        submenuOpen: document.querySelectorAll('.ant-dropdown-menu-submenu-open').length,
        submenuTitleRect: rectOf(title),
        submenuTitleSelf: !!at && !!title && (title === at || (title instanceof Element && title.contains(at))),
        submenuVisibleIds: Array.from(document.querySelectorAll('.ant-dropdown-menu [data-menu-id]'))
          .map((node) => String(node.getAttribute('data-menu-id')))
          .filter((id) => id.length > 0),
        selectingGroups:
          (((window as any).store.getState().editMode?.selectedGroupIds ?? []) as string[]).length ?? null
      }
    }, `-${kind}`)

  // A user expands the grouping row by hovering it — the row carries no action
  // of its own — and a press expands it too. Both paths are used, but only once
  // the row is really laid out: rc-menu mounts the item list before the popup is
  // measured, and a hover on a zero-width row dispatches nothing.
  const openChildUnderSubmenu = async (): Promise<boolean> => {
    const laidOut = await submenuTitle
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false)
    if (!laidOut) return false
    await page.mouse.move(2, 2)
    await submenuTitle.hover()
    if (await childVisible()) return true
    await submenuTitle.click()
    await frameSettle(page)
    return childVisible()
  }

  // A user expands the grouping row by hovering it (the row carries no action);
  // a press expands it too, which is used when the pointer path does not.
  let opened = false
  const attempts: Array<Record<string, unknown>> = []
  for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
    const menuOpen = await page
      .locator('.ant-dropdown-menu:visible')
      .first()
      .isVisible()
      .catch(() => false)
    if (!menuOpen) {
      // A user reopens a dismissed menu with another right-click on the same
      // turn — no Escape first: Escape is a selection-level shortcut in edit
      // mode and would drop the multi-selection the action must capture.
      await frameSettle(page)
      await openTurnContextMenu(page, askId)
    }
    const before = await readMenuSnapshot()
    opened = await openChildUnderSubmenu()
    attempts.push({
      attempt,
      opened,
      menuOpen,
      selectedBefore,
      selectedAfter,
      selectionNow: await readSelectedGroupIds(page),
      before,
      after: await readMenuSnapshot()
    })
  }
  expect(
    opened,
    `the ${kind} item must offer the opt-in "… including child branches" submenu for this selection: ${JSON.stringify(
      attempts
    )}`
  ).toBe(true)
  expect(selectedAfter, 'opening the turn menu must not change the user selection').toEqual(selectedBefore)

  // The grouping row only expands: pressing it must leave the clipboard
  // untouched (never an implicit ordinary or tree capture).
  if (await childVisible(500)) {
    const treeBeforeParentClick = await readClipboardTreePresent(page)
    await submenuTitle.click()
    await frameSettle(page)
    expect(
      await readClipboardTreePresent(page),
      'pressing the copy/cut grouping row must not perform any capture'
    ).toBe(treeBeforeParentClick)
  }

  // The press may have toggled the submenu shut; reopen it through the same
  // real gesture before choosing the row.
  if (!(await childVisible(500))) {
    expect(await openChildUnderSubmenu(), `the submenu must reopen: ${JSON.stringify(await readMenuSnapshot())}`).toBe(
      true
    )
  }
  expect(
    await childVisible(1000),
    `the "… including child branches" row must open under the ${kind} item: ${JSON.stringify(await readMenuSnapshot())}`
  ).toBe(true)
  await childRow.click()
}

/**
 * Submenu geometry: outer-border distance between the level-1 panel and the
 * level-2 popup, signed by open direction. `right` = popup opens to the right
 * of the parent (gap = sub.left - root.right); `left` = flipped (gap =
 * root.left - sub.right). The product promise is a flush seam: 0..2px either
 * way, never an overlap and never a hover-breaking gap. `titleTopDelta` pins
 * the row alignment the engine renders: the popup top sits on the hovered
 * grouping-title row top.
 */
interface SubmenuGeometry {
  direction: 'left' | 'right'
  gap: number
  titleTopDelta: number
  rootBox: { x: number; y: number; width: number; height: number }
  subBox: { x: number; y: number; width: number; height: number }
}

/**
 * Read-only geometry probe of the two open popup panels (no clicks).
 *
 * Ghost-proof: antd keeps every submenu popup mounted (copy/cut/delete share
 * the menu), so a first-match query can measure a stale sibling or a popup
 * caught mid-transition. This probe takes the laid-out popup that actually
 * hosts the open delete row, with the grouping title scoped under the same
 * level-1 panel.
 */
async function readSubmenuGeometry(page: any): Promise<SubmenuGeometry | null> {
  return page.evaluate((rowSuffix: string) => {
    const roundBox = (element: Element | null) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    }
    const laidOut = (element: Element | null): boolean => {
      if (!(element instanceof HTMLElement)) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const root = document.querySelector('.ant-dropdown .ant-dropdown-menu') as HTMLElement | null
    const title = root?.querySelector('.ant-dropdown-menu-submenu-title[data-menu-id$="-delete"]') as HTMLElement | null
    const subHost =
      Array.from(document.querySelectorAll('.ant-dropdown-menu-submenu-popup')).find(
        (popup) => popup.querySelector(`[data-menu-id$="${rowSuffix}"]`) && laidOut(popup)
      ) ?? null
    const sub = (subHost?.querySelector('.ant-dropdown-menu') ?? null) as HTMLElement | null
    if (!root || !title || !sub) return null
    const rootBox = roundBox(root)!
    const titleBox = roundBox(title)!
    const subBox = roundBox(sub)!
    const titleTopDelta = subBox.y - titleBox.y
    if (subBox.x >= rootBox.x + rootBox.width) {
      return {
        direction: 'right',
        gap: subBox.x - (rootBox.x + rootBox.width),
        titleTopDelta,
        rootBox,
        subBox
      }
    }
    return {
      direction: 'left',
      gap: rootBox.x - (subBox.x + subBox.width),
      titleTopDelta,
      rootBox,
      subBox
    }
  }, '-deleteWithChildren')
}

/**
 * Steady-state gate for the submenu geometry read. Webfont application can
 * still resize the popup after its row turns visible (the flip side anchors
 * the far edge, so a transitional width reads as a gap), and the open motion
 * may still be running. Waits for applied fonts, then for the level-1 panel
 * and every laid-out submenu popup to hold the same half-pixel bbox across
 * consecutive animation frames — no fixed sleeps, bounded by a deadline that
 * falls through to whatever is laid out.
 */
async function settleSubmenuGeometry(page: any): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const deadline = performance.now() + 5000
        const keyOf = () => {
          const panels = Array.from(
            document.querySelectorAll('.ant-dropdown .ant-dropdown-menu, .ant-dropdown-menu-submenu-popup')
          ).filter((panel) => {
            const rect = panel.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          })
          return panels
            .map((panel) => {
              const rect = panel.getBoundingClientRect()
              return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 2) / 2).join(',')
            })
            .join('|')
        }
        let lastKey = ''
        let stableFrames = 0
        const tick = () => {
          const key = keyOf()
          stableFrames = key === lastKey ? stableFrames + 1 : 0
          lastKey = key
          if (stableFrames >= 6 || performance.now() > deadline) resolve()
          else requestAnimationFrame(tick)
        }
        tick()
      })
  )
}

/**
 * Real UI: run the opt-in \"delete including child branches\" from its product
 * location and prove the submenu geometry on the way.
 *
 * Same addressing contract as the copy/cut helper (rc-menu key suffixes, never
 * label text; the parent row only expands), plus the delete-specific safety
 * case: pressing the grouping parent must leave Main authority AND the history
 * exactly untouched — it must never run an ordinary delete as a side effect.
 * Returns the measured submenu geometry so the caller asserts the flush seam.
 */
async function runTreeDeleteFromContextMenu(page: any, askId: string): Promise<SubmenuGeometry> {
  await waitForToastsCleared(page)
  const selectedBefore = await readSelectedGroupIds(page)
  const routeBefore = await readRouteIds(page, await readActiveTopicId(page), await readActiveRouteOf(page))
  const historyBefore = await readHistory(page)
  await openTurnContextMenu(page, askId)
  const selectedAfter = await readSelectedGroupIds(page)
  const childRow = page.locator('.ant-dropdown-menu-submenu-popup [data-menu-id$="-deleteWithChildren"]').first()
  const submenuTitle = page.locator('.ant-dropdown-menu-submenu-title[data-menu-id$="-delete"]').first()
  const childVisible = async (timeout = 2000): Promise<boolean> =>
    childRow
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false)
  const openChildUnderSubmenu = async (): Promise<boolean> => {
    const laidOut = await submenuTitle
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false)
    if (!laidOut) return false
    await page.mouse.move(2, 2)
    await submenuTitle.hover()
    if (await childVisible()) return true
    await submenuTitle.click()
    await frameSettle(page)
    return childVisible()
  }
  let opened = false
  for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
    const menuOpen = await page
      .locator('.ant-dropdown-menu:visible')
      .first()
      .isVisible()
      .catch(() => false)
    if (!menuOpen) {
      await frameSettle(page)
      await openTurnContextMenu(page, askId)
    }
    opened = await openChildUnderSubmenu()
  }
  expect(opened, 'the delete item must offer the "including child branches" submenu for this selection').toBe(true)
  expect(selectedAfter, 'opening the turn menu must not change the user selection').toEqual(selectedBefore)

  // The grouping row only expands: pressing it must leave Main authority and
  // the history exactly untouched (never an ordinary delete as a side effect).
  const treeBeforeParentClick = await readClipboardTreePresent(page)
  await submenuTitle.click()
  await frameSettle(page)
  expect(await readClipboardTreePresent(page), 'pressing the delete grouping row must not capture anything').toBe(
    treeBeforeParentClick
  )
  const activeTopicNow = await readActiveTopicId(page)
  expect(
    await readRouteIds(page, activeTopicNow, await readActiveRouteOf(page)),
    'pressing the delete grouping row must not delete any row'
  ).toEqual(routeBefore)
  expect((await readHistory(page)).undo.length, 'pressing the delete grouping row must record no history').toBe(
    historyBefore.undo.length
  )

  if (!(await childVisible(500))) {
    expect(await openChildUnderSubmenu(), 'the delete submenu must reopen').toBe(true)
  }
  expect(await childVisible(1000), 'the "including child branches" row must open under the delete item').toBe(true)
  // Measure only at rest (applied fonts + stable frames, never a sleep): the
  // flip side anchors the far edge, so a transitional width reads as a gap.
  await settleSubmenuGeometry(page)
  const geometry = await readSubmenuGeometry(page)
  expect(geometry, 'both popup panels must be laid out while the delete submenu is open').not.toBeNull()
  // eslint-disable-next-line no-console
  console.log(
    `[E2E] delete submenu geometry: direction=${geometry!.direction} gap=${geometry!.gap} ` +
      `titleTopDelta=${geometry!.titleTopDelta} ` +
      `root=${JSON.stringify(geometry!.rootBox)} sub=${JSON.stringify(geometry!.subBox)}`
  )
  await childRow.click()
  return geometry!
}

/** Active topic id from the app's own runtime state (setup/test oracle). */
async function readActiveTopicId(page: any): Promise<string> {
  return page.evaluate(() => (window as any).store.getState().runtime?.chat?.activeTopic?.id as string)
}

/** Active route of a topic from the app's own branch state (setup/test oracle). */
async function readActiveRouteOf(page: any): Promise<string | null> {
  const topicId = await readActiveTopicId(page)
  return readActiveRoute(page, topicId)
}

/**
 * Real UI: activate a seeded topic through the topic list. The list is a
 * virtualized drag-reorder list, so the row must be geometrically settled
 * before exactly ONE activation click (same contract as the sibling specs).
 */
async function activateTopicThroughList(page: any, topicId: string, atLeast: number): Promise<void> {
  const selector = `[data-testid="topic-item"][data-topic-id="${topicId}"]`
  const topicItem = page.locator(selector)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  const settled = await page.evaluate(async (rowSelector: string) => {
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const rectOf = () => {
      const element = document.querySelector(rowSelector) as HTMLElement | null
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    let previous = rectOf()
    for (let attempt = 0; attempt < 60; attempt++) {
      await nextFrame()
      const current = rectOf()
      if (!previous || !current) {
        previous = current
        continue
      }
      if (
        Math.abs(current.x - previous.x) < 0.5 &&
        Math.abs(current.y - previous.y) < 0.5 &&
        Math.abs(current.width - previous.width) < 0.5 &&
        Math.abs(current.height - previous.height) < 0.5
      ) {
        return true
      }
      previous = current
    }
    return false
  }, selector)
  expect(settled, `topic row ${topicId} must be settled before the activation click`).toBe(true)
  await topicItem.click()
  // The switch is proven by the app's own active topic, never by a row count: a
  // route of the topic being left can have the same number of rows, so a count
  // alone would let the caller act while the previous topic is still mounted.
  try {
    await page.waitForFunction(
      ({ topicId, atLeast }: { topicId: string; atLeast: number }) => {
        const state = (window as any).store.getState()
        const ids = state.messages?.messageIdsByTopic?.[topicId]
        const loading = state.messages?.loadingByTopic?.[topicId]
        const activeTopicId = state.runtime?.chat?.activeTopic?.id ?? null
        return Array.isArray(ids) && ids.length >= atLeast && loading !== true && activeTopicId === topicId
      },
      { topicId, atLeast },
      { timeout: 30000 }
    )
  } catch (error) {
    // A stuck activation is otherwise indistinguishable from a slow one: report
    // the three app-side facts the wait consumes instead of only "timeout".
    const diagnostic = await page.evaluate((tid: string) => {
      const state = (window as any).store.getState()
      return {
        loadedLength: (state.messages?.messageIdsByTopic?.[tid] as string[] | undefined)?.length ?? null,
        loading: state.messages?.loadingByTopic?.[tid] ?? null,
        activeTopicId: state.runtime?.chat?.activeTopic?.id ?? null,
        activeBranch: state.topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
        renderedRows: document.querySelectorAll('#messages [data-message-id]').length
      }
    }, topicId)
    throw new Error(
      `[E2E] topic ${topicId} did not settle on its loaded window (wanted >= ${atLeast} rows): ${JSON.stringify(diagnostic)}`
    )
  }
  await page.waitForFunction(
    (minimum: number) => document.querySelectorAll('#messages [data-message-id]').length >= minimum,
    atLeast,
    { timeout: 30000 }
  )
}

/** Real UI: switch route through the topic-header branch selector. */
async function switchRouteViaTopSelector(page: any, branchId: string | null): Promise<void> {
  await page.locator('[data-testid="branch-selector-entry"]').first().click()
  await expect(
    page.locator('[data-testid="branch-selector-popover"]').first(),
    'branch selector must open'
  ).toBeVisible({ timeout: 15000 })
  const item = page.locator(`[data-testid="branch-cascader-item-${branchId ?? 'main'}"]`).first()
  await expect(item, `the topic-header selector must offer route ${branchId ?? 'main'}`).toBeVisible({
    timeout: 15000
  })
  await item.click()
}

async function waitForActiveRoute(page: any, topicId: string, branchId: string | null): Promise<void> {
  await page.waitForFunction(
    ({ topicId, branchId }: { topicId: string; branchId: string | null }) => {
      const state = (window as any).store.getState()
      return (
        (state.topicBranch?.activeBranchIdByTopic?.[topicId] ?? null) === branchId &&
        state.messages?.loadingByTopic?.[topicId] !== true
      )
    },
    { topicId, branchId },
    { timeout: 30000 }
  )
}

/** Make sure the topic's active route is the expected one (switch only if needed). */
async function ensureRoute(page: any, topicId: string, branchId: string | null): Promise<void> {
  const current = await page.evaluate((tid: string) => {
    const state = (window as any).store.getState()
    return (state.topicBranch?.activeBranchIdByTopic?.[tid] ?? null) as string | null
  }, topicId)
  if (current !== branchId) {
    await switchRouteViaTopSelector(page, branchId)
  }
  await waitForActiveRoute(page, topicId, branchId)
}

/**
 * Real UI: reveal the owner message menubar, prove the true-branch control is
 * genuinely interactive, then deliver exactly ONE real click (a forced click on
 * a covered control lands on the message body and silently creates no branch).
 */
async function clickTrueBranchControl(page: any, messageId: string): Promise<void> {
  const escaped = messageId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const container = page.locator(`[id="message-${escaped}"][data-message-id="${escaped}"]`).first()
  await expect(container, `message container ${messageId} must be visible`).toBeVisible({ timeout: 30000 })
  await container.scrollIntoViewIfNeeded()
  await expect(async () => {
    await container.hover({ timeout: 5000 })
    const hit: any = await page.evaluate((id: string) => {
      const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const owner = document.querySelector(`[id="message-${esc}"][data-message-id="${esc}"]`)
      const control = owner?.querySelector('[data-testid="msg-true-branch-btn"]') as HTMLElement | null
      if (!control) return { found: false }
      const rect = control.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return { found: true, laidOut: false }
      const atPoint = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return { found: true, laidOut: true, self: !!atPoint && (control === atPoint || control.contains(atPoint)) }
    }, messageId)
    expect(
      hit?.self === true,
      `true-branch control for ${messageId} must own its hit target: ${JSON.stringify(hit)}`
    ).toBe(true)
  }).toPass({ timeout: 30000, intervals: [250, 500, 1000] })
  await container.locator('[data-testid="msg-true-branch-btn"]').first().click({ timeout: 15000 })
}

/** Real UI: fork one internal branch at an owned anchor and return its Main ID. */
async function forkAt(page: any, topicId: string, anchorMessageId: string): Promise<string> {
  const before = await listBranches(page, topicId)
  await clickTrueBranchControl(page, anchorMessageId)
  await expect
    .poll(async () => (await listBranches(page, topicId)).length, {
      timeout: 30000,
      message: `real toolbar fork at ${anchorMessageId} must create one branch row`
    })
    .toBe(before.length + 1)
  const branches = await listBranches(page, topicId)
  const created = branches.filter((branch: any) => !before.some((prev: any) => prev.id === branch.id))
  expect(created.length, 'exactly one new branch must appear').toBe(1)
  expect(created[0].anchorMessageId, 'fork must capture the clicked anchor').toBe(anchorMessageId)
  return created[0].id as string
}

/**
 * Setup-only branch: the production `createBranch` authority command the
 * assistant-message toolbar control issues, addressed at an OWNED anchor.
 * Used for the deep fixture topology where the toolbar control is not reachable
 * (a child route renders its owned rows inside a collapsed branch holder), and
 * for a fixture branch created before its topic is first displayed. The
 * behavior under proof — copy/cut opt-in, paste, undo/redo — is exercised
 * through real UI gestures only.
 */
async function createBranchViaSetup(
  page: any,
  topicId: string,
  parentBranchId: string | null,
  anchorMessageId: string
): Promise<string> {
  const before = await listBranches(page, topicId)
  const result: any = await page.evaluate(
    async ({
      topicId,
      parentBranchId,
      anchorMessageId
    }: {
      topicId: string
      parentBranchId: string | null
      anchorMessageId: string
    }) => {
      try {
        const api: any = (window as any).api.chatDb
        const created = await api.createBranch({ topicId, parentBranchId, anchorMessageId })
        return { ok: created?.ok === true, raw: created }
      } catch (e) {
        return { ok: false, raw: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, parentBranchId, anchorMessageId }
  )
  expect(result.ok, `nested branch setup failed: ${JSON.stringify(result.raw)}`).toBe(true)
  const branches = await listBranches(page, topicId)
  const created = branches.filter((branch: any) => !before.some((prev: any) => prev.id === branch.id))
  expect(created.length, 'exactly one nested branch must appear').toBe(1)
  expect(created[0].parentBranchId, 'nested branch must hang off its parent route').toBe(parentBranchId)
  expect(created[0].anchorMessageId, 'nested branch must anchor at the parent-owned message').toBe(anchorMessageId)
  return created[0].id as string
}

/**
 * Real gesture gate for the production clipboard shortcuts:
 * - the runtime drops keys while an edit operation is settling, so wait for idle;
 * - production deliberately yields Meta+C/V/X/Z to native handling while a text
 *   input owns focus, and activating a topic auto-focuses the composer, so move
 *   focus off the input first (the same blur the sibling clipboard specs use).
 */
async function pressEditShortcutWhenIdle(page: any, keys: string): Promise<void> {
  await page.waitForFunction(() => (window as any).store?.getState?.()?.editMode?.isProcessing !== true, undefined, {
    timeout: 30000
  })
  const focusOwner: string | null = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    if (active && typeof active.blur === 'function') active.blur()
    const after = document.activeElement as HTMLElement | null
    if (!after) return null
    const testId = after.getAttribute('data-testid')
    return `${after.tagName.toLowerCase()}${testId ? `[${testId}]` : ''}`
  })
  expect(focusOwner, 'an edit-mode clipboard shortcut is only handled while no text input owns focus').not.toMatch(
    /^(input|textarea)/
  )
  await page.keyboard.press(keys)
}

async function waitForHistoryType(
  page: any,
  expectedCount: number,
  expectedType: string,
  label: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const history = await readHistory(page)
        return { count: history.undo.length, lastType: history.undo.at(-1)?.type ?? null }
      },
      { timeout: 30000, message: `${label}: expected ${expectedCount} undo entries ending with ${expectedType}` }
    )
    .toEqual({ count: expectedCount, lastType: expectedType })
}

/**
 * Post-exit durable-state poll: the bounded-retry query helper owns the
 * transient TIMEOUT/SPAWN/SIGNAL/BUSY/LOCKED retries, and this poll waits for
 * the exact expected row count (no fixed sleeps).
 */
async function pollDbUntil(
  dbPath: string,
  sql: string,
  validate: (rows: any[]) => boolean,
  timeoutMs = 30000
): Promise<any[]> {
  let captured: any[] | null = null
  await expect
    .poll(
      async () => {
        const res = await queryChatDbViaElectronWithRetry(dbPath, sql)
        if (!res.ok) return null
        const rows = (res as any).rows as any[]
        if (!Array.isArray(rows)) return null
        if (!validate(rows)) return null
        captured = rows
        return rows
      },
      { timeout: timeoutMs, intervals: [250, 500, 1000] }
    )
    .not.toBeNull()
  return captured!
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

function contentOf(contentById: Record<string, string>, messageId: string, label: string): string {
  const content = contentById[messageId]
  expect(content, `${label}: message ${messageId} must expose its block content`).toBeTruthy()
  return content
}

/** First line of a message's captured block content (fixture rows are multi-line). */
function firstLineOf(contentById: Record<string, string>, messageId: string, label: string): string {
  return contentOf(contentById, messageId, label).split('\n')[0]
}

test.describe('tree clipboard (opt-in copy/cut including child branches)', () => {
  test('opt-in tree copy carries only the branches anchored in the selection, pastes a fresh remapped topology into another topic, and stays reusable', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)
    const page = mainWindow
    const assistantId = await prepareAssistant(page, 20)
    const sourceTopicId = uniqueTopicId('tree-copy-src')
    const sourceIds = await seedSourceTopic(page, {
      assistantId,
      topicId: sourceTopicId,
      name: `src-${sourceTopicId}`,
      total: 6,
      messageIdForIndex: (index: number) => letterMessageId(sourceTopicId, index),
      contentPrefix: 'src-'
    })
    await activateTopicThroughList(page, sourceTopicId, sourceIds.length)

    // Selected root group = turn 2 (`sourceIds[2]` user + `sourceIds[3]` assistant).
    const rootAskId = sourceIds[2]
    const childRows = [`${sourceTopicId}-c1-0`, `${sourceTopicId}-c1-1`]
    const grandRows = [`${sourceTopicId}-c2-0`, `${sourceTopicId}-c2-1`]
    const unrelatedRows = [`${sourceTopicId}-un-0`, `${sourceTopicId}-un-1`]

    // Direct child branch anchored at the selected root's assistant row: the real
    // assistant-message toolbar control (it forks and switches the active route).
    const childBranchId = await forkAt(page, sourceTopicId, sourceIds[3])
    await waitForActiveRoute(page, sourceTopicId, childBranchId)
    await seedBranchRows(page, sourceTopicId, childBranchId, childRows, ['c1-00000', 'c1-00001'])
    // Grandchild branch via the same Main command the toolbar issues (setup):
    // the nested-fork control is not reachable through the collapsed branch
    // holder that renders the child route's owned rows, so the branch topology
    // fixture is created through the disclosed setup IPC instead.
    const grandBranchId = await createBranchViaSetup(page, sourceTopicId, childBranchId, childRows[1])
    await seedBranchRows(page, sourceTopicId, grandBranchId, grandRows, ['c2-00000', 'c2-00001'])
    // Unrelated direct child of the main route anchored OUTSIDE the selection.
    await switchRouteViaTopSelector(page, null)
    await waitForActiveRoute(page, sourceTopicId, null)
    const unrelatedBranchId = await forkAt(page, sourceTopicId, sourceIds[1])
    await waitForActiveRoute(page, sourceTopicId, unrelatedBranchId)
    await seedBranchRows(page, sourceTopicId, unrelatedBranchId, unrelatedRows, ['un-00000', 'un-00001'])
    await switchRouteViaTopSelector(page, null)
    await waitForActiveRoute(page, sourceTopicId, null)
    await expect.poll(() => readRouteIds(page, sourceTopicId, null), { timeout: 30000 }).toEqual(sourceIds)

    // Segments: one inside the selected root, one inside the child branch.
    await seedSegment(page, sourceTopicId, null, `${sourceTopicId}-seg-root`, [sourceIds[2], sourceIds[3]])
    await seedSegment(page, sourceTopicId, childBranchId, `${sourceTopicId}-seg-child`, childRows)
    await expect.poll(async () => (await readSegments(page, sourceTopicId)).length, { timeout: 30000 }).toBe(2)

    await ensureEditMode(page)
    await selectTurn(page, rootAskId)

    // Ordinary copy stays the linear group capture it always was (brief case;
    // the ordinary paste path is already covered by the sibling clipboard specs).
    await page.locator('[data-testid="edit-copy-btn"]').first().click()
    await page.waitForFunction(
      () => {
        const clipboard = (window as any).store.getState().clipboard
        return (clipboard?.items?.length ?? 0) > 0 && clipboard?.tree == null
      },
      undefined,
      { timeout: 30000 }
    )
    const ordinaryClipboard = await readClipboard(page)
    expect(ordinaryClipboard.mode).toBe('copy')
    expect(ordinaryClipboard.itemGroups).toBe(1)
    expect(ordinaryClipboard.itemMessageCount).toBe(2)
    expect(ordinaryClipboard.treePresent).toBe(false)

    // Opt-in tree capture through the real turn context menu (copy submenu).
    await runTreeActionFromContextMenu(page, rootAskId, 'copy')
    await page.waitForFunction(() => (window as any).store.getState().clipboard?.tree != null, undefined, {
      timeout: 30000
    })
    const clipboard = await readClipboard(page)
    expect(clipboard.mode).toBe('copy')
    expect(clipboard.itemGroups).toBe(0)
    expect(clipboard.treePresent).toBe(true)
    expect(clipboard.treeMeta).toMatchObject({
      completeness: 'clipboard-tree',
      topicId: sourceTopicId,
      branchId: null,
      requestedCount: 1,
      returnedCount: 1,
      returnedMessageCount: 6,
      returnedBranchCount: 2,
      returnedSegmentCount: 2
    })
    expect(sorted(clipboard.treeMeta.ownedRootMessageIds as string[])).toEqual(sorted([sourceIds[2], sourceIds[3]]))
    expect(clipboard.treeMeta.inheritedRootMessageIds).toEqual([])
    expect(clipboard.tree!.sourceTopicId).toBe(sourceTopicId)
    expect(clipboard.tree!.sourceBranchId).toBeNull()
    expect(clipboard.tree!.rootMessageIds).toEqual([sourceIds[2], sourceIds[3]])
    // Closure = selected roots (route order) + child branch OWN rows + grandchild OWN rows.
    expect(clipboard.tree!.messageIds).toEqual([sourceIds[2], sourceIds[3], ...childRows, ...grandRows])
    expect(clipboard.tree!.branches).toEqual([
      { id: childBranchId, parent: null, anchor: sourceIds[3], depth: 1 },
      { id: grandBranchId, parent: childBranchId, anchor: childRows[1], depth: 2 }
    ])
    // Segment capture is order-free here (catalog order is Main-internal).
    expect(clipboard.tree!.segments.map((segment) => segment.id).sort()).toEqual(
      [`${sourceTopicId}-seg-root`, `${sourceTopicId}-seg-child`].sort()
    )
    const rootSegment = clipboard.tree!.segments.find((segment) => segment.id === `${sourceTopicId}-seg-root`)
    const childSegment = clipboard.tree!.segments.find((segment) => segment.id === `${sourceTopicId}-seg-child`)
    expect(rootSegment).toEqual({
      id: `${sourceTopicId}-seg-root`,
      header: sourceIds[2],
      members: [sourceIds[2], sourceIds[3]]
    })
    expect(childSegment).toEqual({
      id: `${sourceTopicId}-seg-child`,
      header: childRows[0],
      members: childRows
    })
    expect(clipboard.tree!.messageIds).not.toContain(unrelatedRows[0])

    const targetTopicId = uniqueTopicId('tree-copy-dst')
    const targetIds = await seedSourceTopic(page, {
      assistantId,
      topicId: targetTopicId,
      name: `dst-${targetTopicId}`,
      total: 4,
      messageIdForIndex: (index: number) => letterMessageId(targetTopicId, index),
      contentPrefix: 'tgt-'
    })
    await activateTopicThroughList(page, targetTopicId, targetIds.length)
    await ensureRoute(page, targetTopicId, null)
    await ensureEditMode(page)

    const historyBefore = await readHistory(page)
    await pressEditShortcutWhenIdle(page, 'Meta+v')
    await waitForHistoryType(page, historyBefore.undo.length + 1, 'clipboard_tree', 'one history action')
    const afterFirstPaste = await readRoute(page, targetTopicId, null)
    // The addressed main route owns the selected ROOT rows only; the captured
    // child subtrees stay branch-owned, exactly as they were captured.
    expect(afterFirstPaste.ids.length).toBe(6)
    expect(afterFirstPaste.ids.slice(0, 4)).toEqual(targetIds)
    const insertedRootIds = afterFirstPaste.ids.slice(4)
    expect(insertedRootIds.length).toBe(2)
    expect(insertedRootIds.some((id) => sourceIds.includes(id))).toBe(false)
    expect(insertedRootIds.some((id) => unrelatedRows.includes(id))).toBe(false)
    // Inserted rows keep the captured content verbatim.
    expect(contentOf(afterFirstPaste.contentById, insertedRootIds[0], 'inserted root user')).toBe('src-00002')
    expect(contentOf(afterFirstPaste.contentById, insertedRootIds[1], 'inserted root assistant')).toBe('src-00003')

    // Fresh independent topology: branch parents/anchors remapped to generated rows.
    const targetBranches = await listBranches(page, targetTopicId)
    expect(targetBranches.length, 'exactly the two captured branches must be recreated').toBe(2)
    const targetChild = targetBranches.find((branch: any) => branch.anchorMessageId === insertedRootIds[1])
    expect(targetChild, 'child branch must anchor at the inserted copy of the selected assistant row').toBeTruthy()
    expect(targetChild.parentBranchId ?? null).toBeNull()
    expect(targetChild.id).not.toBe(childBranchId)
    // The recreated child route = target prefix through the anchor + copied child OWN rows.
    const targetChildRoute = await readRoute(page, targetTopicId, targetChild.id)
    expect(targetChildRoute.ids.slice(0, 6)).toEqual(afterFirstPaste.ids)
    const insertedChildIds = targetChildRoute.ids.slice(6)
    expect(insertedChildIds.length).toBe(2)
    expect(insertedChildIds.map((id) => contentOf(targetChildRoute.contentById, id, 'inserted child row'))).toEqual([
      'c1-00000',
      'c1-00001'
    ])
    const targetGrand = targetBranches.find((branch: any) => branch.parentBranchId === targetChild.id)
    expect(targetGrand, 'grandchild branch must hang off the copied child branch').toBeTruthy()
    expect(targetGrand.anchorMessageId).toBe(insertedChildIds[1])
    expect(targetGrand.id).not.toBe(grandBranchId)
    const targetGrandRoute = await readRoute(page, targetTopicId, targetGrand.id)
    expect(targetGrandRoute.ids.length).toBe(10)
    expect(targetGrandRoute.ids.slice(0, 8)).toEqual([...afterFirstPaste.ids, ...insertedChildIds])
    expect(
      targetGrandRoute.ids.slice(8).map((id) => contentOf(targetGrandRoute.contentById, id, 'inserted grandchild row'))
    ).toEqual(['c2-00000', 'c2-00001'])
    // Branch-owned rows never leak into the target main route.
    expect(afterFirstPaste.ids).not.toContain(insertedChildIds[0])

    // Segment membership/header remapped to the generated IDs.
    const targetSegments = await readSegments(page, targetTopicId)
    expect(targetSegments.length).toBe(2)
    const rootSegmentCopy = targetSegments.find((segment) => segment.headerMessageId === insertedRootIds[0])
    const childSegmentCopy = targetSegments.find((segment) => segment.headerMessageId === insertedChildIds[0])
    expect(rootSegmentCopy?.messageIds).toEqual(insertedRootIds)
    expect(childSegmentCopy?.messageIds).toEqual(insertedChildIds)

    // The copy never touched the source: rows, branches and segments are intact.
    expect(await readRouteIds(page, sourceTopicId, null)).toEqual(sourceIds)
    const sourceBranchesAfterCopy = await listBranches(page, sourceTopicId)
    expect(sorted(sourceBranchesAfterCopy.map((branch: any) => branch.id))).toEqual(
      sorted([childBranchId, grandBranchId, unrelatedBranchId])
    )
    expect(sorted((await readSegments(page, sourceTopicId)).map((segment) => segment.id))).toEqual(
      sorted([`${sourceTopicId}-seg-root`, `${sourceTopicId}-seg-child`])
    )

    // A copy payload stays reusable: a second paste generates a second ID set.
    const historyAfterFirst = await readHistory(page)
    await pressEditShortcutWhenIdle(page, 'Meta+v')
    await waitForHistoryType(page, historyAfterFirst.undo.length + 1, 'clipboard_tree', 'second history action')
    const afterSecondPaste = await readRoute(page, targetTopicId, null)
    expect(afterSecondPaste.ids.length).toBe(8)
    const secondPasteRootIds = afterSecondPaste.ids.slice(6)
    expect(secondPasteRootIds.length).toBe(2)
    expect(secondPasteRootIds.some((id) => insertedRootIds.includes(id))).toBe(false)
    expect(secondPasteRootIds.some((id) => sourceIds.includes(id))).toBe(false)
    expect(contentOf(afterSecondPaste.contentById, secondPasteRootIds[0], 'second paste root user')).toBe('src-00002')
    expect((await listBranches(page, targetTopicId)).length, 'second paste recreates the two branches again').toBe(4)
    expect(await readRouteIds(page, sourceTopicId, null)).toEqual(sourceIds)

    // Persistence after topic revisit: the rendered projection is re-derived from Main.
    await activateTopicThroughList(page, sourceTopicId, sourceIds.length)
    await expect.poll(() => readRouteIds(page, sourceTopicId, null), { timeout: 30000 }).toEqual(sourceIds)
    await activateTopicThroughList(page, targetTopicId, 8)
    await ensureRoute(page, targetTopicId, null)
    // The projection route ids are the completeness claim; the DOM check only
    // proves the inserted root rows are really rendered (branch-owned copies are
    // rendered inside their branch holders, so a raw DOM count is not the
    // authority here).
    expect(await readRouteIds(page, targetTopicId, null)).toEqual(afterSecondPaste.ids)
    const expectedRevisitedRows = [...insertedRootIds, ...secondPasteRootIds]
    await expect
      .poll(
        async () => {
          const rendered = await readRenderedIds(page)
          return expectedRevisitedRows.filter((id) => !rendered.includes(id))
        },
        { timeout: 30000, message: 'revisited target route must render every inserted root row' }
      )
      .toEqual([])
  })

  test('tree cut stages without mutating, applies source removal atomically with the paste, and one Undo/Redo replays Main’s snapshot', async ({
    electronApp,
    mainWindow
  }) => {
    test.setTimeout(240_000)
    const page = mainWindow
    const assistantId = await prepareAssistant(page, 20)
    const sourceTopicId = uniqueTopicId('tree-cut-src')
    const sourceIds = await seedSourceTopic(page, {
      assistantId,
      topicId: sourceTopicId,
      name: `cut-src-${sourceTopicId}`,
      total: 6,
      messageIdForIndex: (index: number) => letterMessageId(sourceTopicId, index),
      contentPrefix: 'cut-'
    })
    await activateTopicThroughList(page, sourceTopicId, sourceIds.length)

    const childRows = [`${sourceTopicId}-c1-0`, `${sourceTopicId}-c1-1`]
    const grandRows = [`${sourceTopicId}-c2-0`, `${sourceTopicId}-c2-1`]
    const childBranchId = await forkAt(page, sourceTopicId, sourceIds[3])
    await waitForActiveRoute(page, sourceTopicId, childBranchId)
    await seedBranchRows(page, sourceTopicId, childBranchId, childRows, ['c1-00000', 'c1-00001'])
    // Nested branch through the disclosed setup IPC (see `createBranchViaSetup`).
    const grandBranchId = await createBranchViaSetup(page, sourceTopicId, childBranchId, childRows[1])
    await seedBranchRows(page, sourceTopicId, grandBranchId, grandRows, ['c2-00000', 'c2-00001'])
    await switchRouteViaTopSelector(page, null)
    await waitForActiveRoute(page, sourceTopicId, null)
    await expect.poll(() => readRouteIds(page, sourceTopicId, null), { timeout: 30000 }).toEqual(sourceIds)
    await switchRouteViaTopSelector(page, null)
    await waitForActiveRoute(page, sourceTopicId, null)

    // Target topic with an EXISTING branch route (real toolbar fork at t1).
    const targetTopicId = uniqueTopicId('tree-cut-dst')
    const targetIds = await seedSourceTopic(page, {
      assistantId,
      topicId: targetTopicId,
      name: `cut-dst-${targetTopicId}`,
      total: 4,
      messageIdForIndex: (index: number) => letterMessageId(targetTopicId, index),
      contentPrefix: 'tar-'
    })
    await activateTopicThroughList(page, targetTopicId, targetIds.length)
    const targetBranchId = await forkAt(page, targetTopicId, targetIds[1])
    await waitForActiveRoute(page, targetTopicId, targetBranchId)
    await expect
      .poll(() => readRouteIds(page, targetTopicId, targetBranchId), { timeout: 30000 })
      .toEqual(targetIds.slice(0, 2))

    // Back on the source: select the root group and stage the tree cut.
    await activateTopicThroughList(page, sourceTopicId, sourceIds.length)
    await ensureRoute(page, sourceTopicId, null)
    await ensureEditMode(page)
    await selectTurn(page, sourceIds[2])
    await runTreeActionFromContextMenu(page, sourceIds[2], 'cut')
    await page.waitForFunction(
      () => {
        const clipboard = (window as any).store.getState().clipboard
        return clipboard?.tree != null && clipboard?.mode === 'cut'
      },
      undefined,
      { timeout: 30000 }
    )
    const cutClipboard = await readClipboard(page)
    expect(cutClipboard.treeMeta).toMatchObject({
      completeness: 'clipboard-tree',
      returnedMessageCount: 6,
      returnedBranchCount: 2
    })
    expect(cutClipboard.tree!.messageIds).toEqual([sourceIds[2], sourceIds[3], ...childRows, ...grandRows])
    // Staging a cut is a read: the source authority is untouched until the paste.
    expect(await readRouteIds(page, sourceTopicId, null)).toEqual(sourceIds)
    expect(
      sorted((await listBranches(page, sourceTopicId)).map((branch: any) => branch.id)),
      'staged cut must not remove source branch rows'
    ).toEqual(sorted([childBranchId, grandBranchId]))

    // Paste into the EXISTING target branch route.
    await activateTopicThroughList(page, targetTopicId, 2)
    await ensureRoute(page, targetTopicId, targetBranchId)
    const historyBeforeCut = await readHistory(page)
    await pressEditShortcutWhenIdle(page, 'Meta+v')
    await waitForHistoryType(page, historyBeforeCut.undo.length + 1, 'clipboard_tree', 'one history action for the cut')

    // Source removal and target insert are ONE committed command.
    await expect
      .poll(() => readRouteIds(page, sourceTopicId, null), { timeout: 30000 })
      .toEqual([sourceIds[0], sourceIds[1], sourceIds[4], sourceIds[5]])
    expect(await listBranches(page, sourceTopicId)).toEqual([])
    const targetBranchRoute = await readRoute(page, targetTopicId, targetBranchId)
    expect(targetBranchRoute.ids.length).toBe(4)
    expect(targetBranchRoute.ids.slice(0, 2)).toEqual(targetIds.slice(0, 2))
    const insertedRootIds = targetBranchRoute.ids.slice(2)
    expect(contentOf(targetBranchRoute.contentById, insertedRootIds[0], 'cut root user')).toBe('cut-00002')
    expect(contentOf(targetBranchRoute.contentById, insertedRootIds[1], 'cut root assistant')).toBe('cut-00003')
    // The target's own main route is unchanged: only the addressed branch received rows.
    expect(await readRouteIds(page, targetTopicId, null)).toEqual(targetIds)
    const afterCutBranches = await listBranches(page, targetTopicId)
    expect(afterCutBranches.length).toBe(3)
    const targetChild = afterCutBranches.find((branch: any) => branch.anchorMessageId === insertedRootIds[1])
    expect(targetChild, 'child branch copy must anchor at the inserted assistant row').toBeTruthy()
    const targetGrand = afterCutBranches.find((branch: any) => branch.parentBranchId === targetChild.id)
    expect(targetGrand, 'grandchild branch copy must hang off the copied child branch').toBeTruthy()
    expect(targetChild.parentBranchId).toBe(targetBranchId)
    const branchIdsAfterCut = sorted(afterCutBranches.map((branch: any) => branch.id))
    const firstPasteChildRoute = await readRoute(page, targetTopicId, targetChild.id)
    // Prefix = the target route's rows through the anchor, then the copied child OWN rows.
    expect(firstPasteChildRoute.ids.length).toBe(2 + insertedRootIds.length + 2)
    const insertedChildIds = firstPasteChildRoute.ids.slice(2 + insertedRootIds.length)
    expect(insertedChildIds.map((id) => contentOf(firstPasteChildRoute.contentById, id, 'cut child row'))).toEqual([
      'c1-00000',
      'c1-00001'
    ])
    const firstPasteGrandRoute = await readRoute(page, targetTopicId, targetGrand.id)
    expect(firstPasteGrandRoute.ids.length).toBe(2 + insertedRootIds.length + 2 + 2)
    const insertedGrandIds = firstPasteGrandRoute.ids.slice(2 + insertedRootIds.length + 2)
    expect(insertedGrandIds.map((id) => contentOf(firstPasteGrandRoute.contentById, id, 'cut grandchild row'))).toEqual(
      ['c2-00000', 'c2-00001']
    )
    // A successful cut spends the staged payload (current clipboard semantics).
    const clipboardAfterCut = await readClipboard(page)
    expect(clipboardAfterCut.treePresent).toBe(false)
    expect(clipboardAfterCut.itemGroups).toBe(0)

    // ONE Undo restores the source subtree AND removes exactly the inserted target rows.
    await pressEditShortcutWhenIdle(page, 'Meta+z')
    await page.waitForFunction(() => (window as any).store.getState().undoStack?.redoStack?.length > 0, undefined, {
      timeout: 30000
    })
    await expect.poll(() => readRouteIds(page, sourceTopicId, null), { timeout: 30000 }).toEqual(sourceIds)
    const restoredBranches = await listBranches(page, sourceTopicId)
    expect(sorted(restoredBranches.map((branch: any) => branch.id))).toEqual(sorted([childBranchId, grandBranchId]))
    const restoredChild = restoredBranches.find((branch: any) => branch.id === childBranchId)
    const restoredGrand = restoredBranches.find((branch: any) => branch.id === grandBranchId)
    expect(restoredChild.anchorMessageId).toBe(sourceIds[3])
    expect(restoredChild.parentBranchId ?? null).toBeNull()
    expect(restoredGrand.anchorMessageId).toBe(childRows[1])
    expect(restoredGrand.parentBranchId).toBe(childBranchId)
    expect(await readRouteIds(page, sourceTopicId, childBranchId)).toEqual([...sourceIds.slice(0, 4), ...childRows])
    expect(await readRouteIds(page, sourceTopicId, grandBranchId)).toEqual([
      ...sourceIds.slice(0, 4),
      ...childRows,
      ...grandRows
    ])
    expect(await readRouteIds(page, targetTopicId, targetBranchId)).toEqual(targetIds.slice(0, 2))
    expect(sorted((await listBranches(page, targetTopicId)).map((branch: any) => branch.id))).toEqual(
      sorted([targetBranchId])
    )

    // ONE Redo re-applies the same structure with the SAME generated IDs.
    await pressEditShortcutWhenIdle(page, 'Meta+Shift+z')
    await page.waitForFunction(() => (window as any).store.getState().undoStack?.undoStack?.length > 0, undefined, {
      timeout: 30000
    })
    await expect
      .poll(() => readRouteIds(page, sourceTopicId, null), { timeout: 30000 })
      .toEqual([sourceIds[0], sourceIds[1], sourceIds[4], sourceIds[5]])
    expect(await listBranches(page, sourceTopicId)).toEqual([])
    const redoBranchRoute = await readRoute(page, targetTopicId, targetBranchId)
    expect(redoBranchRoute.ids).toEqual(targetBranchRoute.ids)
    const redoBranches = await listBranches(page, targetTopicId)
    expect(sorted(redoBranches.map((branch: any) => branch.id))).toEqual(branchIdsAfterCut)
    const redoChild = redoBranches.find((branch: any) => branch.id === targetChild.id)
    expect(redoChild?.anchorMessageId).toBe(insertedRootIds[1])

    // Persistence after topic revisit: each topic is activated again and must
    // render the rows Main holds now — the source's surviving rows, and the
    // target branch route's replayed rows.
    await activateTopicThroughList(page, sourceTopicId, 4)
    await expect
      .poll(async () => sorted(await readRenderedIds(page)), {
        timeout: 30000,
        message: 'the revisited source topic must render exactly its surviving rows'
      })
      .toEqual(sorted([sourceIds[0], sourceIds[1], sourceIds[4], sourceIds[5]]))
    await activateTopicThroughList(page, targetTopicId, 2)
    await ensureRoute(page, targetTopicId, targetBranchId)
    const expectedReplayedRows = redoBranchRoute.ids
    await expect
      .poll(
        async () => {
          const rendered = await readRenderedIds(page)
          return expectedReplayedRows.filter((id) => !rendered.includes(id))
        },
        { timeout: 30000, message: 'the revisited target branch route must render every replayed row' }
      )
      .toEqual([])

    // Post-exit durable state: exact SQLite rows of both topics.
    await electronApp.close()
    const dbPath = getChatDbPath()
    expect(dbPath).not.toBeNull()
    await expect.poll(() => fs.existsSync(dbPath!), { timeout: 30000, intervals: [250, 500] }).toBe(true)
    const esc = (value: string): string => value.replace(/'/g, "''")
    const sourceRows = await pollDbUntil(
      dbPath!,
      `SELECT id, branch_id FROM messages WHERE topic_id = '${esc(sourceTopicId)}' ORDER BY sort_order, id`,
      (rows) => rows.length === 4
    )
    expect(sorted(sourceRows.map((row) => String(row.id)))).toEqual(
      sorted([sourceIds[0], sourceIds[1], sourceIds[4], sourceIds[5]])
    )
    expect(sourceRows.every((row) => row.branch_id == null)).toBe(true)
    const sourceBranchRows = await pollDbUntil(
      dbPath!,
      `SELECT id FROM topic_branches WHERE topic_id = '${esc(sourceTopicId)}'`,
      (rows) => rows.length === 0
    )
    expect(sourceBranchRows).toEqual([])
    const targetRows = await pollDbUntil(
      dbPath!,
      `SELECT id, branch_id FROM messages WHERE topic_id = '${esc(targetTopicId)}' ORDER BY sort_order, id`,
      (rows) => rows.length === 10
    )
    const targetRowIds = sorted(targetRows.map((row) => String(row.id)))
    expect(targetRowIds).toEqual(
      sorted([...targetIds, ...redoBranchRoute.ids.slice(2), ...insertedChildIds, ...insertedGrandIds])
    )
    expect(sorted(targetRows.filter((row) => row.branch_id == null).map((row) => String(row.id)))).toEqual(
      sorted(targetIds)
    )
    const targetBranchRows = await pollDbUntil(
      dbPath!,
      `SELECT id, parent_branch_id, anchor_message_id FROM topic_branches WHERE topic_id = '${esc(
        targetTopicId
      )}' ORDER BY id`,
      (rows) => rows.length === 3
    )
    expect(sorted(targetBranchRows.map((row) => String(row.id)))).toEqual(branchIdsAfterCut)
    const storedTargetChild = targetBranchRows.find((row) => String(row.id) === targetChild.id)
    const storedTargetGrand = targetBranchRows.find((row) => String(row.id) === targetGrand.id)
    expect(storedTargetChild?.parent_branch_id).toBe(targetBranchId)
    expect(String(storedTargetChild?.anchor_message_id)).toBe(insertedRootIds[1])
    expect(storedTargetGrand?.parent_branch_id).toBe(targetChild.id)
  })

  test('a tree copy taken on a paged-in multi-page history survives the paste, one Undo and one Redo in place, and keeps older paging alive', async ({
    electronApp,
    mainWindow
  }) => {
    test.setTimeout(240_000)
    const page = mainWindow
    // Window groups are per ROW in this fixture (a user row and its assistant row
    // are separate groups), so `displayCount` counts rows here: the cold window is
    // the newest 12 rows, and one older page pulls in 20 more rows.
    const TOTAL_ROWS = 60
    const COLD_ROWS = 12
    const OLDER_PAGE_ROWS = 20
    const assistantId = await prepareAssistant(page, COLD_ROWS)
    const topicId = uniqueTopicId('tree-windowed')
    const rows = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `windowed-${topicId}`,
      total: TOTAL_ROWS,
      messageIdForIndex: (index: number) => letterMessageId(topicId, index),
      contentPrefix: 'p-',
      // Multi-line rows: the cold window genuinely overflows, so the paging
      // below is real scrolling instead of a no-op.
      contentForIndex: (index: number) =>
        [`p-${pad(index, 5)}`, `filler-${pad(index, 5)}-a`, `filler-${pad(index, 5)}-b`].join('\n')
    })
    expect(rows.length).toBe(TOTAL_ROWS)

    // Cold resident window = rows[48..59]. One older page (20 rows) anchored at
    // rows[48] reaches rows[28] and leaves rows[0..27] unloaded, so older paging
    // must still work after the write under proof.
    const FIRST_LOADED = TOTAL_ROWS - COLD_ROWS
    const PAGED_FIRST = FIRST_LOADED - OLDER_PAGE_ROWS
    // Selected roots = two whole turns taken from the paged-in window:
    // rows[28] (user) + rows[29] (assistant), and rows[30] + rows[31].
    const anchorRootIds = rows.slice(PAGED_FIRST, PAGED_FIRST + 4)
    const anchorAskIds = [rows[PAGED_FIRST], rows[PAGED_FIRST + 2]]
    const pagedContents = [0, 1, 2, 3].map((offset) => `p-${pad(PAGED_FIRST + offset, 5)}`)
    const childRows = [`${topicId}-child-0`, `${topicId}-child-1`]
    const segmentId = `${topicId}-seg`

    // Fixture topology BEFORE the topic is first displayed: the branch catalog is
    // fetched on activation, so a branch created through the same Main command the
    // toolbar issues is part of it (see `createBranchViaSetup`).
    const childBranchId = await createBranchViaSetup(page, topicId, null, rows[PAGED_FIRST + 1])
    await seedBranchRows(page, topicId, childBranchId, childRows, ['child-00000', 'child-00001'])
    await seedSegment(page, topicId, null, segmentId, [rows[PAGED_FIRST], rows[PAGED_FIRST + 1]])

    await activateTopicThroughList(page, topicId, COLD_ROWS)
    expect(await readRouteIds(page, topicId, null)).toEqual(rows)
    const cold = rows.slice(-COLD_ROWS)
    await expect.poll(() => readLoadedIds(page, topicId), { timeout: 30000 }).toEqual(cold)

    // Genuine wheel paging to the older edge: the selected anchor turns become
    // resident while older rows stay unloaded (paging must keep working later).
    const paged = await wheelLoadOlder(page, topicId)
    expect(paged.length).toBeLessThan(rows.length)
    expect(paged.slice(-cold.length)).toEqual(cold)
    // The loaded set is a contiguous suffix that now reaches both selected turns,
    // while older rows are still unloaded.
    expect(paged).toEqual(rows.slice(rows.length - paged.length))
    const anchorOffset = paged.indexOf(anchorRootIds[0])
    expect(anchorOffset, 'paging must bring the selected turns into the loaded window').toBeGreaterThanOrEqual(0)
    expect(paged.slice(anchorOffset, anchorOffset + anchorRootIds.length)).toEqual(anchorRootIds)

    // The turn menu only offers the opt-in action against the app's own branch
    // catalog, so wait for the catalog this activation fetched.
    await expect.poll(() => readBranchCatalogIds(page, topicId), { timeout: 30000 }).toEqual([childBranchId])

    await ensureEditMode(page)
    await clickTurnCover(page, anchorAskIds[0])
    await expect.poll(() => readSelectedGroupIds(page), { timeout: 30000 }).toEqual([anchorAskIds[0]])
    await clickTurnCover(page, anchorAskIds[1], { meta: true })
    await expect
      .poll(async () => sorted(await readSelectedGroupIds(page)), { timeout: 30000 })
      .toEqual(sorted(anchorAskIds))

    const loadedBeforeCopy = await readLoadedIds(page, topicId)
    const historyBeforePaste = await readHistory(page)
    await runTreeActionFromContextMenu(page, anchorAskIds[0], 'copy')
    await page.waitForFunction(() => (window as any).store.getState().clipboard?.tree != null, undefined, {
      timeout: 30000
    })
    const clipboard = await readClipboard(page)
    expect(clipboard.mode).toBe('copy')
    expect(clipboard.itemGroups).toBe(0)
    expect(clipboard.treePresent).toBe(true)
    expect(clipboard.treeMeta).toMatchObject({
      completeness: 'clipboard-tree',
      topicId,
      branchId: null,
      requestedCount: 2,
      returnedCount: 2,
      returnedMessageCount: 6,
      returnedBranchCount: 1,
      returnedSegmentCount: 1
    })
    expect(sorted(clipboard.treeMeta.ownedRootMessageIds as string[])).toEqual(sorted(anchorRootIds))
    expect(clipboard.treeMeta.inheritedRootMessageIds).toEqual([])
    expect(clipboard.tree!.sourceTopicId).toBe(topicId)
    expect(clipboard.tree!.sourceBranchId).toBeNull()
    expect(clipboard.tree!.rootMessageIds).toEqual(anchorRootIds)
    expect(clipboard.tree!.messageIds).toEqual([...anchorRootIds, ...childRows])
    expect(clipboard.tree!.branches).toEqual([
      { id: childBranchId, parent: null, anchor: rows[PAGED_FIRST + 1], depth: 1 }
    ])
    expect(clipboard.tree!.segments).toEqual([
      {
        id: segmentId,
        header: rows[PAGED_FIRST],
        members: [rows[PAGED_FIRST], rows[PAGED_FIRST + 1]]
      }
    ])
    // Capturing a tree is a read of Main: neither the loaded window nor authority moved.
    expect(await readLoadedIds(page, topicId)).toEqual(loadedBeforeCopy)
    expect(await readRouteIds(page, topicId, null)).toEqual(rows)

    // Paste at the topic tail (empty selection) — still the same topic, no switch.
    await clickTurnCover(page, anchorAskIds[0], { meta: true })
    await clickTurnCover(page, anchorAskIds[1], { meta: true })
    await expect.poll(async () => (await readSelectedGroupIds(page)).length, { timeout: 30000 }).toBe(0)
    await pressEditShortcutWhenIdle(page, 'Meta+v')
    await waitForHistoryType(
      page,
      historyBeforePaste.undo.length + 1,
      'clipboard_tree',
      'one history action for the topic-tail tree paste'
    )

    // Authority: the selected roots land at the topic tail under fresh IDs.
    const authorityAfterPaste = await readRoute(page, topicId, null)
    expect(authorityAfterPaste.ids.slice(0, rows.length)).toEqual(rows)
    const insertedRootIds = authorityAfterPaste.ids.slice(rows.length)
    expect(insertedRootIds.length).toBe(4)
    expect(insertedRootIds.some((id) => rows.includes(id))).toBe(false)
    expect(insertedRootIds.map((id) => firstLineOf(authorityAfterPaste.contentById, id, 'pasted root row'))).toEqual(
      pagedContents
    )
    // Every page the user had paged in keeps its resident slot and its order: the
    // tail insert appends in place instead of replacing the window with a latest page.
    expect(await readLoadedIds(page, topicId), 'paged-in pages must survive the paste').toEqual([
      ...loadedBeforeCopy,
      ...insertedRootIds
    ])
    // A copy never rewrites the rows it copied from.
    expect(firstLineOf(authorityAfterPaste.contentById, rows[PAGED_FIRST], 'source root row')).toBe(pagedContents[0])

    // The captured child branch is recreated with remapped anchor/parent/own rows.
    const pastedBranches = await listBranches(page, topicId)
    expect(pastedBranches.length).toBe(2)
    const copiedBranch = pastedBranches.find((branch: any) => branch.anchorMessageId === insertedRootIds[1])
    expect(copiedBranch, 'the copied child branch must anchor at the pasted assistant root').toBeTruthy()
    expect(copiedBranch.id).not.toBe(childBranchId)
    expect(copiedBranch.parentBranchId ?? null).toBeNull()
    const copiedChildRoute = await readRoute(page, topicId, copiedBranch.id)
    const copiedChildPrefix = [...rows, insertedRootIds[0], insertedRootIds[1]]
    expect(copiedChildRoute.ids.slice(0, copiedChildPrefix.length)).toEqual(copiedChildPrefix)
    const copiedChildIds = copiedChildRoute.ids.slice(copiedChildPrefix.length)
    expect(copiedChildIds.length).toBe(childRows.length)
    expect(copiedChildIds.some((id) => childRows.includes(id))).toBe(false)
    expect(copiedChildIds.map((id) => firstLineOf(copiedChildRoute.contentById, id, 'copied child row'))).toEqual([
      'child-00000',
      'child-00001'
    ])

    // Segment membership/header are remapped; the source segment is intact.
    const pastedSegments = await readSegments(page, topicId)
    expect(pastedSegments.length).toBe(2)
    const copiedSegment = pastedSegments.find((segment) => segment.headerMessageId === insertedRootIds[0])
    expect(copiedSegment, 'the captured segment must be recreated at the pasted root').toBeTruthy()
    expect(copiedSegment!.id).not.toBe(segmentId)
    expect(copiedSegment!.messageIds).toEqual([insertedRootIds[0], insertedRootIds[1]])
    expect(pastedSegments.find((segment) => segment.id === segmentId)).toEqual({
      id: segmentId,
      headerMessageId: rows[PAGED_FIRST],
      messageIds: [rows[PAGED_FIRST], rows[PAGED_FIRST + 1]]
    })

    // The pasted rows are really rendered at the newest edge (genuine scrolling,
    // no topic switch) and the copied segment header is a live group there.
    // First the app's own segment projection must carry the copied segment with
    // remapped header/membership — otherwise the group header could never render.
    const rendererCopiedSegmentGate = await expect
      .poll(async () => (await readRendererSegment(page, topicId, copiedSegment!.id)).present, { timeout: 20000 })
      .toBe(true)
      .then(() => readRendererSegment(page, topicId, copiedSegment!.id))
    expect(
      rendererCopiedSegmentGate.header,
      `the renderer segment projection must remap the copied header (catalog: ${JSON.stringify(
        rendererCopiedSegmentGate.ids
      )})`
    ).toBe(insertedRootIds[0])
    expect(rendererCopiedSegmentGate.members).toEqual([insertedRootIds[0], insertedRootIds[1]])
    await revealTailRows(page, insertedRootIds)
    const revealed = await readLoadedIds(page, topicId)
    expect(revealed.slice(0, loadedBeforeCopy.length)).toEqual(loadedBeforeCopy)
    expect(revealed.filter((id) => insertedRootIds.includes(id))).toEqual(insertedRootIds)
    // DOM-level: the pasted rows really exist as message rows and the first one
    // renders the catalog content it was copied from (not a stale/duplicate id).
    const renderedTail = await readRenderedIds(page)
    expect(
      renderedTail.filter((id) => insertedRootIds.includes(id)),
      'pasted rows must be rendered'
    ).toEqual(insertedRootIds)
    const firstPastedRow = page.locator(`#messages [data-message-id="${insertedRootIds[0]}"]`).first()
    await expect(firstPastedRow).toBeVisible()
    await expect(firstPastedRow).toContainText(pagedContents[0])
    // …and the segment whose header is that rendered row must be a live group in
    // the same DOM: the visible membership the user sees, not just catalog state.
    const renderedGroups = await readRenderedSegmentGroups(page)
    expect(
      renderedGroups.filter((group) => group.header === insertedRootIds[0]),
      `the copied segment must render as a group header over its rendered root rows: ${JSON.stringify(renderedGroups)}`
    ).toHaveLength(1)

    // ONE Undo: the inserted tail rows leave, and the exact loaded window the user
    // was reading is back — no theme/route reset and no latest-window replacement.
    await pressEditShortcutWhenIdle(page, 'Meta+z')
    await expect
      .poll(
        async () => {
          const history = await readHistory(page)
          return { undo: history.undo.length, redo: history.redo.length }
        },
        { timeout: 30000 }
      )
      .toEqual({ undo: historyBeforePaste.undo.length, redo: historyBeforePaste.redo.length + 1 })
    await expect.poll(() => readLoadedIds(page, topicId), { timeout: 30000 }).toEqual(loadedBeforeCopy)
    await expect.poll(() => readRouteIds(page, topicId, null), { timeout: 30000 }).toEqual(rows)
    expect((await listBranches(page, topicId)).map((branch: any) => branch.id)).toEqual([childBranchId])
    expect((await readSegments(page, topicId)).map((segment) => segment.id)).toEqual([segmentId])

    // Older paging keeps working after the Undo: the whole history stays reachable
    // through real older pages (an older page is 20 rows, not the whole topic).
    let pagedAfterUndo = await wheelLoadOlder(page, topicId)
    expect(pagedAfterUndo.length, 'older paging must grow the loaded window again').toBeGreaterThan(
      loadedBeforeCopy.length
    )
    expect(pagedAfterUndo.slice(-loadedBeforeCopy.length), 'older pages prepend to the kept window').toEqual(
      loadedBeforeCopy
    )
    while (pagedAfterUndo.length < rows.length) {
      const grew = await wheelLoadOlder(page, topicId)
      expect(grew.length, 'each older page must add rows').toBeGreaterThan(pagedAfterUndo.length)
      pagedAfterUndo = grew
    }
    expect(pagedAfterUndo).toEqual(rows)
    // DOM-level: after the Undo no pasted row is rendered, and the newly paged-in
    // older rows are real rendered rows of this topic (paging stayed alive).
    const renderedAfterUndoPaging = await readRenderedIds(page)
    expect(
      renderedAfterUndoPaging.every((id) => rows.includes(id)),
      'undo must leave no pasted row rendered'
    ).toBe(true)
    expect(
      renderedAfterUndoPaging.some((id) => !loadedBeforeCopy.includes(id)),
      'older paging after undo must render newly loaded older rows'
    ).toBe(true)

    // ONE Redo re-applies the same structure with the same generated IDs.
    await pressEditShortcutWhenIdle(page, 'Meta+Shift+z')
    await expect
      .poll(async () => (await readHistory(page)).undo.length, { timeout: 30000 })
      .toBe(historyBeforePaste.undo.length + 1)
    const afterRedo = await readRouteIds(page, topicId, null)
    expect(afterRedo.slice(0, rows.length)).toEqual(rows)
    expect(afterRedo.slice(rows.length)).toEqual(insertedRootIds)
    expect(sorted((await listBranches(page, topicId)).map((branch: any) => branch.id))).toEqual(
      sorted([childBranchId, copiedBranch.id])
    )

    // Post-exit durable state: exact SQLite rows of the one topic.
    await electronApp.close()
    const dbPath = getChatDbPath()
    expect(dbPath).not.toBeNull()
    await expect.poll(() => fs.existsSync(dbPath!), { timeout: 30000, intervals: [250, 500] }).toBe(true)
    const esc = (value: string): string => value.replace(/'/g, "''")
    const mainRows = await pollDbUntil(
      dbPath!,
      `SELECT id, branch_id FROM messages WHERE topic_id = '${esc(topicId)}' AND branch_id IS NULL`,
      (rowsRead) => rowsRead.length === rows.length + insertedRootIds.length
    )
    expect(sorted(mainRows.map((row) => String(row.id)))).toEqual(sorted([...rows, ...insertedRootIds]))
    const branchRows = await pollDbUntil(
      dbPath!,
      `SELECT id, branch_id FROM messages WHERE topic_id = '${esc(topicId)}' AND branch_id IS NOT NULL`,
      (rowsRead) => rowsRead.length === childRows.length + copiedChildIds.length
    )
    expect(sorted(branchRows.map((row) => String(row.id)))).toEqual(sorted([...childRows, ...copiedChildIds]))
    const storedBranches = await pollDbUntil(
      dbPath!,
      `SELECT id, parent_branch_id, anchor_message_id FROM topic_branches WHERE topic_id = '${esc(topicId)}'`,
      (rowsRead) => rowsRead.length === 2
    )
    expect(sorted(storedBranches.map((row) => String(row.id)))).toEqual(sorted([childBranchId, copiedBranch.id]))
    const storedCopied = storedBranches.find((row) => String(row.id) === copiedBranch.id)
    expect(storedCopied?.parent_branch_id).toBeNull()
    expect(String(storedCopied?.anchor_message_id)).toBe(insertedRootIds[1])
    const storedSegments = await pollDbUntil(
      dbPath!,
      `SELECT id, header_message_id FROM topic_segments WHERE topic_id = '${esc(topicId)}'`,
      (rowsRead) => rowsRead.length === 2
    )
    expect(sorted(storedSegments.map((row) => String(row.id)))).toEqual(sorted([segmentId, copiedSegment!.id]))
    const copiedMembership = await pollDbUntil(
      dbPath!,
      `SELECT message_id FROM topic_segment_messages WHERE segment_id = '${esc(copiedSegment!.id)}' ORDER BY sort_order`,
      (rowsRead) => rowsRead.length === 2
    )
    expect(copiedMembership.map((row) => String(row.message_id))).toEqual([insertedRootIds[0], insertedRootIds[1]])
  })
  test('a branch-row copy captures that branch’s OWN subtree without the inherited prefix, never switches route, and pastes a remapped topology into another route', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)
    const page = mainWindow
    const assistantId = await prepareAssistant(page, 20)
    const sourceTopicId = uniqueTopicId('branch-copy-src')
    const sourceIds = await seedSourceTopic(page, {
      assistantId,
      topicId: sourceTopicId,
      name: `brc-src-${sourceTopicId}`,
      total: 4,
      messageIdForIndex: (index: number) => letterMessageId(sourceTopicId, index),
      contentPrefix: 'brc-'
    })
    await activateTopicThroughList(page, sourceTopicId, sourceIds.length)

    const ownRows = [`${sourceTopicId}-own-0`, `${sourceTopicId}-own-1`]
    const grandRows = [`${sourceTopicId}-g-0`, `${sourceTopicId}-g-1`]

    // Real toolbar fork at a main assistant row: the branch route carries the
    // shared prefix (`sourceIds[0..1]`) and then its own rows.
    const branchId = await forkAt(page, sourceTopicId, sourceIds[1])
    await waitForActiveRoute(page, sourceTopicId, branchId)
    await seedBranchRows(page, sourceTopicId, branchId, ownRows, ['own-00000', 'own-00001'])
    // Nested branch through the disclosed setup IPC (see `createBranchViaSetup`).
    const grandBranchId = await createBranchViaSetup(page, sourceTopicId, branchId, ownRows[1])
    await seedBranchRows(page, sourceTopicId, grandBranchId, grandRows, ['grand-00000', 'grand-00001'])
    const sourceBranchRoute = [sourceIds[0], sourceIds[1], ...ownRows]
    await expect.poll(() => readRouteIds(page, sourceTopicId, branchId), { timeout: 30000 }).toEqual(sourceBranchRoute)

    // Back on the main route: the copy is taken from an INACTIVE branch row, with
    // no edit-mode selection and no loaded-projection requirement.
    await switchRouteViaTopSelector(page, null)
    await waitForActiveRoute(page, sourceTopicId, null)

    // Real gesture: open the topic-header branch selector, hover the branch row
    // (its actions are hover-revealed), prove the copy control owns its hit
    // target, then press it.
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(
      page.locator('[data-testid="branch-selector-popover"]').first(),
      'branch selector must open'
    ).toBeVisible({
      timeout: 15000
    })
    const branchRow = page.locator(`[data-testid="branch-cascader-item-${branchId}"]`).first()
    await expect(branchRow, 'the inactive branch row must be offered').toBeVisible({ timeout: 15000 })
    await expect(async () => {
      await branchRow.hover({ timeout: 5000 })
      const hit: any = await page.evaluate((id: string) => {
        const button = document.querySelector(`[data-testid="branch-copy-btn-${id}"]`) as HTMLElement | null
        if (!button) return { found: false }
        const rect = button.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return { found: true, laidOut: false }
        const atPoint = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return {
          found: true,
          laidOut: true,
          self: !!atPoint && (button === atPoint || button.contains(atPoint)),
          opacity: getComputedStyle(button).opacity
        }
      }, branchId)
      expect(hit?.self === true, `branch copy control must own its hit target: ${JSON.stringify(hit)}`).toBe(true)
      expect(hit?.opacity, 'hovering the row must reveal the copy action').toBe('1')
    }).toPass({ timeout: 20000, intervals: [250, 500] })
    await page.locator(`[data-testid="branch-copy-btn-${branchId}"]`).first().click({ timeout: 15000 })
    await page.waitForFunction(() => (window as any).store.getState().clipboard?.tree != null, undefined, {
      timeout: 30000
    })
    // The press is a copy, never a route switch: the user stays where they were.
    expect(await readActiveRoute(page, sourceTopicId), 'a branch-row copy must not switch route').toBeNull()
    await page.keyboard.press('Escape')
    await waitForToastsCleared(page)

    const clipboard = await readClipboard(page)
    expect(clipboard.mode).toBe('copy')
    expect(clipboard.itemGroups, 'a tree capture is never flattened into ordinary groups').toBe(0)
    expect(clipboard.treePresent).toBe(true)
    expect(clipboard.treeMeta).toMatchObject({
      completeness: 'clipboard-tree',
      topicId: sourceTopicId,
      branchId,
      requestedCount: 1,
      returnedCount: 1,
      returnedMessageCount: 4,
      returnedBranchCount: 1,
      returnedSegmentCount: 0
    })
    expect(clipboard.treeMeta.ownedRootMessageIds).toEqual(ownRows)
    expect(clipboard.treeMeta.inheritedRootMessageIds, 'a branch capture inherits no prefix rows').toEqual([])
    expect(clipboard.tree!.sourceTopicId).toBe(sourceTopicId)
    expect(clipboard.tree!.sourceBranchId, 'the CLICKED branch is the source, not the active route').toBe(branchId)
    // Trunk = that branch's OWN rows only; the shared prefix is not captured.
    expect(clipboard.tree!.rootMessageIds).toEqual(ownRows)
    expect(clipboard.tree!.messageIds).toEqual([...ownRows, ...grandRows])
    expect(clipboard.tree!.messageIds).not.toContain(sourceIds[0])
    expect(clipboard.tree!.messageIds).not.toContain(sourceIds[1])
    // The captured branch's own node is not part of the payload; its descendant
    // keeps its anchor and its (source) parent, which the paste re-parents onto
    // the target route.
    expect(clipboard.tree!.branches).toEqual([{ id: grandBranchId, parent: branchId, anchor: ownRows[1], depth: 1 }])

    // Target topic with an EXISTING branch route (real toolbar fork at t1).
    const targetTopicId = uniqueTopicId('branch-copy-dst')
    const targetIds = await seedSourceTopic(page, {
      assistantId,
      topicId: targetTopicId,
      name: `brc-dst-${targetTopicId}`,
      total: 4,
      messageIdForIndex: (index: number) => letterMessageId(targetTopicId, index),
      contentPrefix: 'tar-'
    })
    await activateTopicThroughList(page, targetTopicId, targetIds.length)
    const targetBranchId = await forkAt(page, targetTopicId, targetIds[1])
    await waitForActiveRoute(page, targetTopicId, targetBranchId)
    const targetPrefix = targetIds.slice(0, 2)
    await expect.poll(() => readRouteIds(page, targetTopicId, targetBranchId), { timeout: 30000 }).toEqual(targetPrefix)
    await ensureEditMode(page)

    // ONE history action for the whole tree paste.
    const historyBefore = await readHistory(page)
    await pressEditShortcutWhenIdle(page, 'Meta+v')
    await waitForHistoryType(page, historyBefore.undo.length + 1, 'clipboard_tree', 'one history action')

    const targetRoute = await readRoute(page, targetTopicId, targetBranchId)
    expect(targetRoute.ids.length).toBe(4)
    expect(targetRoute.ids.slice(0, 2)).toEqual(targetPrefix)
    const insertedRootIds = targetRoute.ids.slice(2)
    expect(insertedRootIds.length).toBe(2)
    expect(insertedRootIds.some((id) => sourceBranchRoute.includes(id))).toBe(false)
    // The addressed route owns the pasted trunk, verbatim and in order.
    expect(insertedRootIds.map((id) => contentOf(targetRoute.contentById, id, 'pasted branch trunk row'))).toEqual([
      'own-00000',
      'own-00001'
    ])
    // The target's own main route is untouched: only the addressed branch received rows.
    expect(await readRouteIds(page, targetTopicId, null)).toEqual(targetIds)
    const targetBranches = await listBranches(page, targetTopicId)
    expect(targetBranches.length, 'the captured descendant is recreated once').toBe(2)
    const pastedChild = targetBranches.find((branch: any) => branch.id !== targetBranchId)
    expect(pastedChild, 'the copied descendant branch must be recreated').toBeTruthy()
    expect(pastedChild.id).not.toBe(grandBranchId)
    // Fresh IDs, remapped anchor and parent: the descendant now hangs off the
    // ADDRESSED target route, because the source branch node is never re-created.
    expect(pastedChild.parentBranchId).toBe(targetBranchId)
    expect(pastedChild.anchorMessageId).toBe(insertedRootIds[1])
    const pastedChildRoute = await readRoute(page, targetTopicId, pastedChild.id)
    expect(pastedChildRoute.ids.length).toBe(6)
    expect(pastedChildRoute.ids.slice(0, 4)).toEqual([...targetPrefix, ...insertedRootIds])
    const pastedGrandIds = pastedChildRoute.ids.slice(4)
    expect(pastedGrandIds.some((id) => grandRows.includes(id))).toBe(false)
    expect(pastedGrandIds.map((id) => contentOf(pastedChildRoute.contentById, id, 'pasted descendant row'))).toEqual([
      'grand-00000',
      'grand-00001'
    ])
    // No inherited prefix row travelled with the payload.
    const pastedSurface = [...targetRoute.ids, ...pastedChildRoute.ids]
    expect(pastedSurface).not.toContain(sourceIds[0])
    expect(pastedSurface).not.toContain(sourceIds[1])
    for (const id of pastedSurface) {
      expect(
        ['brc-00000', 'brc-00001'].includes(contentOf(pastedChildRoute.contentById, id, 'pasted row')),
        'the shared prefix must never be re-materialized'
      ).toBe(false)
    }

    // The copy left the source topic exactly as it was.
    expect(await readRouteIds(page, sourceTopicId, null)).toEqual(sourceIds)
    expect(await readRouteIds(page, sourceTopicId, branchId)).toEqual(sourceBranchRoute)
    expect(sorted((await listBranches(page, sourceTopicId)).map((branch: any) => branch.id))).toEqual(
      sorted([branchId, grandBranchId])
    )
  })
  test('the delete submenu sits flush with its parent on the observed side and the grouping title only expands', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)
    const page = mainWindow
    const assistantId = await prepareAssistant(page, 12)
    const sourceTopicId = uniqueTopicId('tree-delete-geom')
    const sourceIds = await seedSourceTopic(page, {
      assistantId,
      topicId: sourceTopicId,
      name: `geom-${sourceTopicId}`,
      total: 6,
      messageIdForIndex: (index: number) => letterMessageId(sourceTopicId, index),
      contentPrefix: 'g-'
    })
    await activateTopicThroughList(page, sourceTopicId, sourceIds.length)
    const childBranchId = await forkAt(page, sourceTopicId, sourceIds[3])
    await waitForActiveRoute(page, sourceTopicId, childBranchId)
    await seedBranchRows(
      page,
      sourceTopicId,
      childBranchId,
      [`${sourceTopicId}-k-0`, `${sourceTopicId}-k-1`],
      ['k-00000', 'k-00001']
    )
    await switchRouteViaTopSelector(page, null)
    await waitForActiveRoute(page, sourceTopicId, null)
    await expect.poll(() => readBranchCatalogIds(page, sourceTopicId), { timeout: 30000 }).toEqual([childBranchId])
    // Narrow the window ONLY for the geometry proof: the toolbar topology above
    // was built at the standard size (its menubar hit-testing is not valid in a
    // squeezed layout). Whichever side the engine chooses, the same constant
    // must keep the seam flush. Each test owns its app instance, so no size is
    // restored.
    await page.setViewportSize({ width: 680, height: 900 })
    await frameSettle(page)

    await ensureEditMode(page)
    await selectTurn(page, sourceIds[2])
    const historyBeforeGeom = await readHistory(page)
    const geometry = await runTreeDeleteFromContextMenu(page, sourceIds[2])
    // Flush seam on the observed side: 0..2px, never an overlap, never a gap.
    // (The engine negates the single x offset when it flips — see
    // @rc-component/trigger `useAlign` right-to-left branch — so the unit tier
    // pins one shared constant across copy/cut/delete and this test pins the
    // rendered seam where it actually opened.)
    expect(
      geometry.gap,
      `delete submenu must sit flush with its parent (direction=${geometry.direction}): ${JSON.stringify(geometry)}`
    ).toBeGreaterThanOrEqual(0)
    expect(
      geometry.gap,
      `delete submenu must sit flush with its parent (direction=${geometry.direction}): ${JSON.stringify(geometry)}`
    ).toBeLessThanOrEqual(2)
    // Row alignment is natural: the popup top sits on the hovered
    // grouping-title row top (±1px rounding), never on the panel top.
    expect(
      geometry.titleTopDelta,
      `delete submenu must open on its grouping-title row (direction=${geometry.direction}): ${JSON.stringify(geometry)}`
    ).toBeGreaterThanOrEqual(-1)
    expect(
      geometry.titleTopDelta,
      `delete submenu must open on its grouping-title row (direction=${geometry.direction}): ${JSON.stringify(geometry)}`
    ).toBeLessThanOrEqual(1)

    // The grouping click inside the helper performed no delete; the child click
    // at its end did exactly one clipboard_tree command.
    await waitForHistoryType(
      page,
      historyBeforeGeom.undo.length + 1,
      'clipboard_tree',
      'one history action for the tree delete'
    )
    await expect
      .poll(() => readRouteIds(page, sourceTopicId, null), { timeout: 30000 })
      .toEqual([sourceIds[0], sourceIds[1], sourceIds[4], sourceIds[5]])
    expect(await listBranches(page, sourceTopicId)).toEqual([])
  })

  test('tree delete removes the selected roots with their whole anchored subtrees, keeps an unrelated sibling branch, leaves the clipboard untouched, and one Undo/Redo restores/re-applies exactly while the paged-in window survives', async ({
    electronApp,
    mainWindow
  }) => {
    test.setTimeout(300_000)
    const page = mainWindow
    // Window groups are per ROW here (see the paged copy test): the cold window
    // is the newest 20 rows, and one older page pulls in 20 more rows.
    const TOTAL_ROWS = 60
    const COLD_ROWS = 20
    const assistantId = await prepareAssistant(page, COLD_ROWS)
    const sourceTopicId = uniqueTopicId('tree-delete-src')
    const rows = await seedSourceTopic(page, {
      assistantId,
      topicId: sourceTopicId,
      name: `del-src-${sourceTopicId}`,
      total: TOTAL_ROWS,
      messageIdForIndex: (index: number) => letterMessageId(sourceTopicId, index),
      contentPrefix: 'd-',
      contentForIndex: (index: number) =>
        [`d-${pad(index, 5)}`, `filler-${pad(index, 5)}-a`, `filler-${pad(index, 5)}-b`].join('\n')
    })
    expect(rows.length).toBe(TOTAL_ROWS)

    // Doomed subtree: child anchored at the selected assistant row rows[41],
    // grandchild anchored inside the child. Unrelated sibling anchored far
    // outside the selection (rows[5]) with its own rows — it must survive.
    const childRows = [`${sourceTopicId}-c1-0`, `${sourceTopicId}-c1-1`]
    const grandRows = [`${sourceTopicId}-c2-0`, `${sourceTopicId}-c2-1`]
    const siblingRows = [`${sourceTopicId}-s-0`, `${sourceTopicId}-s-1`]
    // Setup-only branches through the disclosed Main `createBranch` command —
    // the same fixture pattern the paged copy test uses. Real toolbar forks
    // need mounted rows (rows[5] is outside the cold window, and nothing is
    // mounted before first activation); the behavior under proof — the delete
    // submenu, the delete itself, Undo/Redo — stays real UI throughout.
    const childBranchId = await createBranchViaSetup(page, sourceTopicId, null, rows[41])
    await seedBranchRows(page, sourceTopicId, childBranchId, childRows, ['c1-00000', 'c1-00001'])
    const grandBranchId = await createBranchViaSetup(page, sourceTopicId, childBranchId, childRows[1])
    await seedBranchRows(page, sourceTopicId, grandBranchId, grandRows, ['c2-00000', 'c2-00001'])
    const siblingBranchId = await createBranchViaSetup(page, sourceTopicId, null, rows[5])
    await seedBranchRows(page, sourceTopicId, siblingBranchId, siblingRows, ['s-00000', 's-00001'])
    await waitForActiveRoute(page, sourceTopicId, null)

    // One segment fully inside the doomed span (removed with it), one far
    // outside (retained): the delete is one transaction over rows, branches
    // AND segments.
    const doomedSegmentId = `${sourceTopicId}-seg-doomed`
    const keptSegmentId = `${sourceTopicId}-seg-kept`
    await seedSegment(page, sourceTopicId, null, doomedSegmentId, [rows[40], rows[41]])
    await seedSegment(page, sourceTopicId, null, keptSegmentId, [rows[10], rows[11]])

    await activateTopicThroughList(page, sourceTopicId, COLD_ROWS)
    expect(await readRouteIds(page, sourceTopicId, null)).toEqual(rows)
    // Genuine wheel paging to the older edge: rows[20..59] resident, rows[0..19]
    // still unloadable (older paging must keep working after the delete).
    const paged = await wheelLoadOlder(page, sourceTopicId)
    expect(paged.length).toBe(2 * COLD_ROWS)
    expect(paged).toEqual(rows.slice(TOTAL_ROWS - 2 * COLD_ROWS))
    await expect
      .poll(async () => sorted((await readBranchCatalogIds(page, sourceTopicId)) ?? []), { timeout: 30000 })
      .toEqual(sorted([childBranchId, grandBranchId, siblingBranchId]))

    // The doomed selection: exactly one turn group (rows[40] user + rows[41]
    // assistant), whose assistant row anchors the child branch.
    await ensureEditMode(page)
    await selectTurn(page, rows[40])
    const clipboardBefore = await readClipboard(page)
    expect(clipboardBefore.treePresent).toBe(false)
    expect(clipboardBefore.itemGroups).toBe(0)
    const historyBefore = await readHistory(page)

    const geometry = await runTreeDeleteFromContextMenu(page, rows[40])
    expect(
      geometry.gap,
      `delete submenu must sit flush with its parent (direction=${geometry.direction}): ${JSON.stringify(geometry)}`
    ).toBeGreaterThanOrEqual(0)
    expect(
      geometry.gap,
      `delete submenu must sit flush with its parent (direction=${geometry.direction}): ${JSON.stringify(geometry)}`
    ).toBeLessThanOrEqual(2)
    // Row alignment is natural: the popup top sits on the hovered
    // grouping-title row top (±1px rounding), never on the panel top.
    expect(
      geometry.titleTopDelta,
      `delete submenu must open on its grouping-title row (direction=${geometry.direction}): ${JSON.stringify(geometry)}`
    ).toBeGreaterThanOrEqual(-1)
    expect(
      geometry.titleTopDelta,
      `delete submenu must open on its grouping-title row (direction=${geometry.direction}): ${JSON.stringify(geometry)}`
    ).toBeLessThanOrEqual(1)
    await waitForHistoryType(
      page,
      historyBefore.undo.length + 1,
      'clipboard_tree',
      'one history action for the tree delete'
    )

    const doomedIds = [rows[40], rows[41], ...childRows, ...grandRows]
    const survivingMain = rows.filter((id) => id !== rows[40] && id !== rows[41])
    // Authority: the selected roots are gone with their whole anchored subtrees;
    // the unrelated sibling branch and every other main row survive.
    await expect.poll(() => readRouteIds(page, sourceTopicId, null), { timeout: 30000 }).toEqual(survivingMain)
    expect(sorted((await listBranches(page, sourceTopicId)).map((branch: any) => branch.id))).toEqual([siblingBranchId])
    const siblingRoute = await readRoute(page, sourceTopicId, siblingBranchId)
    expect(siblingRoute.ids).toEqual([...rows.slice(0, 6), ...siblingRows])
    // Segments follow the same transaction: the spanned one is gone, the
    // outside one is intact with its membership.
    expect((await readSegments(page, sourceTopicId)).map((segment) => segment.id)).toEqual([keptSegmentId])
    const kept = (await readSegments(page, sourceTopicId))[0]
    expect(kept.messageIds).toEqual([rows[10], rows[11]])
    // A delete never stages anything: the clipboard is exactly as before.
    const clipboardAfter = await readClipboard(page)
    expect(clipboardAfter.mode).toBe(clipboardBefore.mode)
    expect(clipboardAfter.treePresent).toBe(false)
    expect(clipboardAfter.itemGroups).toBe(0)
    // The loaded window drops exactly the deleted main rows and keeps the rest;
    // nothing deleted is rendered anymore.
    const loadedAfterDelete = await readLoadedIds(page, sourceTopicId)
    for (const id of [rows[40], rows[41]]) {
      expect(loadedAfterDelete, `deleted row ${id} must leave the loaded window`).not.toContain(id)
    }
    expect(await readRenderedIds(page), 'no deleted row may stay rendered').toEqual(
      expect.not.arrayContaining(doomedIds)
    )

    // Older paging still works after the delete and pulls the remaining older
    // page in behind the surviving window.
    const repaged = await wheelLoadOlder(page, sourceTopicId)
    expect(repaged.length).toBe(survivingMain.length)
    expect(repaged.slice(0, COLD_ROWS)).toEqual(rows.slice(0, COLD_ROWS))
    for (const id of doomedIds) {
      expect(repaged, `deleted row ${id} must never page back in`).not.toContain(id)
    }

    // ONE Undo restores the exact rows, branches, anchors, parents and segment.
    await pressEditShortcutWhenIdle(page, 'Meta+z')
    await page.waitForFunction(() => (window as any).store.getState().undoStack?.redoStack?.length > 0, undefined, {
      timeout: 30000
    })
    await expect.poll(() => readRouteIds(page, sourceTopicId, null), { timeout: 30000 }).toEqual(rows)
    const restoredBranches = await listBranches(page, sourceTopicId)
    expect(sorted(restoredBranches.map((branch: any) => branch.id))).toEqual(
      sorted([childBranchId, grandBranchId, siblingBranchId])
    )
    const restoredChild = restoredBranches.find((branch: any) => branch.id === childBranchId)
    expect(restoredChild.anchorMessageId).toBe(rows[41])
    expect(restoredChild.parentBranchId ?? null).toBeNull()
    const restoredGrand = restoredBranches.find((branch: any) => branch.id === grandBranchId)
    expect(restoredGrand.anchorMessageId).toBe(childRows[1])
    expect(restoredGrand.parentBranchId).toBe(childBranchId)
    const restoredSibling = restoredBranches.find((branch: any) => branch.id === siblingBranchId)
    expect(restoredSibling.anchorMessageId).toBe(rows[5])
    expect(await readRouteIds(page, sourceTopicId, childBranchId)).toEqual([...rows.slice(0, 42), ...childRows])
    expect(await readRouteIds(page, sourceTopicId, grandBranchId)).toEqual([
      ...rows.slice(0, 42),
      ...childRows,
      ...grandRows
    ])
    expect(await readRouteIds(page, sourceTopicId, siblingBranchId)).toEqual([...rows.slice(0, 6), ...siblingRows])
    const restoredSegments = await readSegments(page, sourceTopicId)
    expect(sorted(restoredSegments.map((segment) => segment.id))).toEqual(sorted([doomedSegmentId, keptSegmentId]))
    expect(restoredSegments.find((segment) => segment.id === doomedSegmentId)?.messageIds).toEqual([rows[40], rows[41]])

    // ONE Redo re-applies the delete with the same stable structure.
    await pressEditShortcutWhenIdle(page, 'Meta+Shift+z')
    await page.waitForFunction(() => (window as any).store.getState().undoStack?.undoStack?.length > 0, undefined, {
      timeout: 30000
    })
    await expect.poll(() => readRouteIds(page, sourceTopicId, null), { timeout: 30000 }).toEqual(survivingMain)
    expect(sorted((await listBranches(page, sourceTopicId)).map((branch: any) => branch.id))).toEqual([siblingBranchId])

    // Persistence after topic revisit: the surviving rows render, the doomed
    // rows never reappear.
    await activateTopicThroughList(page, sourceTopicId, survivingMain.length - COLD_ROWS)
    await expect
      .poll(async () => (await readRenderedIds(page)).filter((id) => doomedIds.includes(id)), {
        timeout: 30000,
        message: 'the revisited topic must never render a deleted row'
      })
      .toEqual([])

    // Post-exit durable state: exact SQLite rows of the topic.
    await electronApp.close()
    const dbPath = getChatDbPath()
    expect(dbPath).not.toBeNull()
    await expect.poll(() => fs.existsSync(dbPath!), { timeout: 30000, intervals: [250, 500] }).toBe(true)
    const esc = (value: string): string => value.replace(/'/g, "''")
    const messageRows = await pollDbUntil(
      dbPath!,
      `SELECT id, branch_id FROM messages WHERE topic_id = '${esc(sourceTopicId)}' ORDER BY sort_order, id`,
      (resultRows) => resultRows.length === survivingMain.length + siblingRows.length
    )
    expect(sorted(messageRows.map((row) => String(row.id)))).toEqual(sorted([...survivingMain, ...siblingRows]))
    expect(sorted(messageRows.filter((row) => row.branch_id == null).map((row) => String(row.id)))).toEqual(
      sorted(survivingMain)
    )
    const branchRows = await pollDbUntil(
      dbPath!,
      `SELECT id, parent_branch_id, anchor_message_id FROM topic_branches WHERE topic_id = '${esc(sourceTopicId)}'`,
      (resultRows) => resultRows.length === 1
    )
    expect(String(branchRows[0].id)).toBe(siblingBranchId)
    expect(String(branchRows[0].anchor_message_id)).toBe(rows[5])
  })
})
