/**
 * Branch/reference inheritance-boundary durability under REAL edit-mode Undo — INTEGRATED E2E.
 *
 * Durable asset guarding the coherent workflow where a real user edit (delete or
 * cut→paste) removes inherited-prefix messages and Main must move the inheritance
 * boundary (branch `anchorMessageId` / reference endpoint) to the nearest surviving
 * PREDECESSOR, the rendered divider must migrate with it, and real Undo/Redo must
 * restore / re-apply the pre-operation boundary exactly.
 *
 * Covered promises (approved behavior; see docs/adr/topic-branches.md §4.5/§5.1/§6):
 * - Real edit mode: turn cover click → `Meta+Backspace` delete and `Meta+x` / `Meta+v`
 *   cut→paste. No Redux action dispatch, no Main "gesture" simulation.
 * - Delete/cut that removes the boundary message advances the branch anchor and the
 *   reference endpoint to the nearest surviving predecessor (single op and staged
 *   cut→paste alike), and the fork/reference divider migrates with the boundary.
 * - `Meta+z` restores the original message stable IDs/positions AND the pre-operation
 *   branch/reference boundary, so the divider returns to its original slot;
 *   `Meta+Shift+z` repeats the effect; consecutive undo/redo stay consistent.
 * - Deleting the whole inherited prefix: branch objects stay listed and openable, the
 *   owned suffix keeps rendering, the branch/reference boundary entry renders at the
 *   history HEAD with visual bounding-box comparison (never column-reverse DOM order),
 *   including a child route with 0 messages; a reference with no surviving predecessor
 *   degrades to `status: 'missing'` without cascading into the target.
 * - Persistence: route switch + page reload re-derive the same boundary from Main.
 * - An ordinary same-id insert is NOT an Undo and never restores the boundary.
 * - A window that excludes the inherited prefix never fabricates a head divider; the
 *   divider appears only when the boundary group is genuinely loaded (the narrow window is
 *   established by real route switches and older rows are loaded by real wheel input only).
 * - A real single-assistant menubar delete of the message that IS the fork boundary also
 *   advances the branch anchor and the clone endpoint to the surviving user turn above it,
 *   and real Undo/Redo restore/re-apply the assistant boundary with the divider below the
 *   restored assistant (never between that user turn and the assistant).
 *
 * Pre-existing contracts this asset deliberately does NOT re-matrix (already covered
 * elsewhere): branch-object delete subtree cascade and "source route/topic delete never
 * cascades a clone" — see src/main/services/chatDb/__tests__/anchorInheritance.test.ts
 * and specs/conversation/cross-topic-reference.spec.ts.
 *
 * Evidence classes: real UI gestures (edit mode, keyboard delete/cut/paste/undo/redo,
 * divider popover route switch, wheel pagination), Redux route projection, read-only
 * Main authority probes (`listBranches`, `fetchMessagesWindow`), and rendered geometry
 * (bounding boxes). Authority probes are polled for eventual consistency — no sleeps,
 * no hard-coded IDs (every ID is derived from the seeded topology).
 *
 * Selector contract consumed from production (existing semantics, no production change):
 * - fork divider row: `#messages [data-divider-anchor][data-divider-parent][data-divider-key]`
 *   with popover opener `branch-fork-selected-<anchor>` / `branch-fork-toggle-<anchor>`
 *   and peer rows `branch-fork-item-<branchId>` / `branch-fork-item-parent-<anchor>`.
 * - history-reference divider: `history-reference-divider` + `data-reference-status`.
 * The rendered `data-divider-anchor` is asserted to equal the authoritative branch
 * anchor, i.e. the boundary identity is Main's, never a fabricated one.
 * - owner message menubar delete: `[data-testid="message-delete-button"]` inside the rendered
 *   `[id="message-<id>"][data-message-id="<id>"]` container (the real `deleteMessageWithUndo`
 *   entry; the product's optional delete confirmation is confirmed when the setting shows it).
 * - topic-header branch selector: `branch-selector-entry` → `branch-cascader-col-0` →
 *   `branch-cascader-item-<branchId>` (a real route switch, used to establish a narrow window).
 */
import { expect, test } from '../../fixtures/electron.fixture'
import {
  activateTopic,
  letterMessageId,
  listBranches,
  prepareAssistant,
  seedSourceTopic
} from '../../utils/branch-route-setup'
import { waitForAppReady } from '../../utils/wait-helpers'

const EPOCH = '2026-01-01T00:00:00.000Z'

function uniqueTopicId(prefix: string): string {
  return `e2e-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

interface MessageBlockEntry {
  message: Record<string, unknown>
  blocks: Record<string, unknown>[]
}

/** Deterministic alternating user/assistant entries (assistant askId = previous id). */
function entriesFor(topicId: string, ids: string[], contentPrefix: string): MessageBlockEntry[] {
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
          content: `${contentPrefix}${index}`,
          status: 'success',
          createdAt: EPOCH,
          updatedAt: EPOCH
        }
      ]
    }
  })
}

/** Seed main-route turns: index 2k = user, 2k+1 = assistant answering it. */
async function seedMainTurns(page: any, assistantId: string, topicId: string, turns: number): Promise<string[]> {
  return seedSourceTopic(page, {
    assistantId,
    topicId,
    name: `boundary-${topicId}`,
    total: turns * 2,
    messageIdForIndex: (index: number) => letterMessageId(topicId, index),
    contentPrefix: 'main-'
  })
}

async function seedOwnedSuffix(
  page: any,
  topicId: string,
  branchId: string,
  ids: string[],
  contentPrefix: string
): Promise<void> {
  const entries = entriesFor(topicId, ids, contentPrefix)
  const result: any = await page.evaluate(
    async ({ topicId, branchId, entries }: { topicId: string; branchId: string; entries: MessageBlockEntry[] }) => {
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
  expect(result.ok, `owned suffix seed failed: ${JSON.stringify(result.raw)}`).toBe(true)
}

async function seedReference(
  page: any,
  options: {
    sourceTopicId: string
    sourceBranchId: string | null
    targetTopicId: string
    anchorMessageId: string
    name: string
  }
): Promise<void> {
  const result: any = await page.evaluate(
    async (opts: {
      sourceTopicId: string
      sourceBranchId: string | null
      targetTopicId: string
      anchorMessageId: string
      name: string
    }) => {
      try {
        const api: any = (window as any).api.chatDb
        const created = await api.createReferencedTopic({
          sourceTopicId: opts.sourceTopicId,
          branchId: opts.sourceBranchId,
          targetTopicId: opts.targetTopicId,
          anchorMessageId: opts.anchorMessageId,
          name: opts.name
        })
        return { ok: created?.ok === true, raw: created }
      } catch (e) {
        return { ok: false, raw: e instanceof Error ? e.message : String(e) }
      }
    },
    options
  )
  expect(result.ok, `reference seed failed: ${JSON.stringify(result.raw)}`).toBe(true)
}

async function readBranchAnchor(page: any, topicId: string, branchId: string): Promise<string> {
  const branches = await listBranches(page, topicId)
  const branch = branches.find((b: any) => b.id === branchId)
  expect(branch, `branch ${branchId} must stay listed (message deletes never delete branch rows)`).toBeTruthy()
  return branch.anchorMessageId as string
}

/** Poll Main authority until the branch anchor is the expected stable ID. */
async function expectBranchAnchor(
  page: any,
  topicId: string,
  branchId: string,
  expectedAnchor: string,
  label: string
): Promise<void> {
  await expect
    .poll(() => readBranchAnchor(page, topicId, branchId), { timeout: 30000, message: label })
    .toBe(expectedAnchor)
}

/** Main's derived inheritance boundary: the captured anchor id plus the derived head/message kind. */
async function readBranchBoundary(
  page: any,
  topicId: string,
  branchId: string
): Promise<{ anchorMessageId: string; kind: string; messageId: string | null }> {
  const branches = await listBranches(page, topicId)
  const branch = branches.find((b: any) => b.id === branchId)
  expect(branch, `branch ${branchId} must stay listed (message deletes never delete branch rows)`).toBeTruthy()
  const boundary = branch.inheritedBoundary ?? { kind: 'missing', messageId: null }
  return {
    anchorMessageId: branch.anchorMessageId as string,
    kind: boundary.kind as string,
    messageId: (boundary.messageId ?? null) as string | null
  }
}

/** Poll Main's derived boundary (captured anchor id + kind) for one branch. */
async function expectBranchBoundary(
  page: any,
  topicId: string,
  branchId: string,
  expected: { anchorMessageId: string; kind: string; messageId: string | null },
  label: string
): Promise<void> {
  await expect
    .poll(() => readBranchBoundary(page, topicId, branchId), { timeout: 30000, message: label })
    .toEqual(expected)
}

/** Effective-route message IDs from Main authority (read-only probe). */
async function readRouteIds(page: any, topicId: string, branchId: string | null, limit = 100): Promise<string[]> {
  const result: any = await page.evaluate(
    async ({ topicId, branchId, limit }: { topicId: string; branchId: string | null; limit: number }) => {
      const api: any = (window as any).api.chatDb
      const res = await api.fetchMessagesWindow({ kind: 'latest', topicId, branchId, limit })
      if (res?.ok !== true) return { ok: false, raw: res }
      return {
        ok: true,
        ids: ((res.value.messages ?? []) as any[]).map((m) => m.id as string),
        reference: res.value.reference ?? null
      }
    },
    { topicId, branchId, limit }
  )
  expect(result.ok, `fetchMessagesWindow failed: ${JSON.stringify(result.raw)}`).toBe(true)
  return result.ids as string[]
}

async function readReferenceMeta(
  page: any,
  topicId: string,
  limit = 100
): Promise<{ status: string; boundaryMessageId: string | null; anchorMessageId: string | null }> {
  const result: any = await page.evaluate(
    async ({ topicId, limit }: { topicId: string; limit: number }) => {
      const api: any = (window as any).api.chatDb
      const res = await api.fetchMessagesWindow({ kind: 'latest', topicId, limit })
      if (res?.ok !== true) return { ok: false, raw: res }
      return { ok: true, reference: res.value.reference ?? null }
    },
    { topicId, limit }
  )
  expect(result.ok, `reference window probe failed: ${JSON.stringify(result.raw)}`).toBe(true)
  const reference = result.reference ?? {}
  return {
    status: reference.status ?? 'absent',
    boundaryMessageId: reference.boundaryMessageId ?? null,
    anchorMessageId: reference.anchorMessageId ?? null
  }
}

/**
 * An endpoint with no surviving predecessor degrades to `missing` without inventing a prefix.
 * Which endpoint id is retained after the collapse (the captured one or the last advanced
 * predecessor) is not part of the contract, so only "a real source id" is asserted here.
 */
async function expectReferenceMissing(
  page: any,
  referenceTopicId: string,
  candidateAnchors: string[],
  label: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const meta = await readReferenceMeta(page, referenceTopicId)
        return { status: meta.status, boundaryMessageId: meta.boundaryMessageId }
      },
      { timeout: 30000, message: label }
    )
    .toEqual({ status: 'missing', boundaryMessageId: null })
  const meta = await readReferenceMeta(page, referenceTopicId)
  expect(candidateAnchors, `${label}: the retained endpoint must be a real source id`).toContain(meta.anchorMessageId)
  expect(await readRouteIds(page, referenceTopicId, null), `${label}: a missing reference invents no prefix`).toEqual(
    []
  )
}

interface DividerRow {
  anchor: string
  parent: string
  key: string
  top: number
  bottom: number
}

async function readDividerRows(page: any): Promise<DividerRow[]> {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('#messages [data-divider-anchor]')) as HTMLElement[]
    return nodes.map((el) => {
      const rect = el.getBoundingClientRect()
      return {
        anchor: el.getAttribute('data-divider-anchor') ?? '',
        parent: el.getAttribute('data-divider-parent') ?? 'main',
        key: el.getAttribute('data-divider-key') ?? '',
        top: rect.top,
        bottom: rect.bottom
      }
    })
  })
}

interface MessageRect {
  id: string
  top: number
  bottom: number
}

async function readMessageRects(page: any): Promise<MessageRect[]> {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
    const seen = new Set<string>()
    const rows: Array<{ id: string; top: number; bottom: number }> = []
    for (const el of nodes) {
      const id = el.getAttribute('data-message-id') ?? ''
      if (!id || seen.has(id)) continue
      if (!el.id.startsWith('message-')) continue
      const rect = el.getBoundingClientRect()
      seen.add(id)
      rows.push({ id, top: rect.top, bottom: rect.bottom })
    }
    return rows
  })
}

const GEOMETRY_TOLERANCE = 2

/**
 * The boundary divider must sit visually BETWEEN the last inherited message and the
 * first message after the boundary — judged only by bounding boxes, never by DOM
 * (column-reverse) order.
 */
async function expectDividerBetween(
  page: any,
  boundaryAnchor: string,
  segment: { predecessorId?: string | null; successorId?: string | null },
  label: string
): Promise<void> {
  await expect
    .poll(async () => (await readDividerRows(page)).some((row) => row.anchor === boundaryAnchor), {
      timeout: 30000,
      message: `${label}: boundary divider for ${boundaryAnchor} must render`
    })
    .toBe(true)
  const divider = (await readDividerRows(page)).find((row) => row.anchor === boundaryAnchor)
  expect(divider, `${label}: divider row must exist`).toBeTruthy()
  if (!divider) return
  const rects = await readMessageRects(page)
  const byId = new Map(rects.map((row) => [row.id, row]))
  if (segment.predecessorId) {
    const predecessor = byId.get(segment.predecessorId)
    expect(predecessor, `${label}: inherited predecessor ${segment.predecessorId} must be rendered`).toBeTruthy()
    expect(
      divider.top,
      `${label}: divider must render below the inherited predecessor ${segment.predecessorId}`
    ).toBeGreaterThanOrEqual((predecessor?.bottom ?? Number.NaN) - GEOMETRY_TOLERANCE)
  }
  if (segment.successorId) {
    const successor = byId.get(segment.successorId)
    expect(successor, `${label}: boundary successor ${segment.successorId} must be rendered`).toBeTruthy()
    expect(
      divider.bottom,
      `${label}: divider must render above the boundary successor ${segment.successorId}`
    ).toBeLessThanOrEqual((successor?.top ?? Number.NaN) + GEOMETRY_TOLERANCE)
  }
}

/**
 * Boundary entry at the history HEAD: the divider renders above every rendered message
 * row (visual comparison only). Returns the rendered anchor so callers can compare it
 * against Main authority — the boundary identity must never be fabricated.
 */
async function readHeadDividerAnchor(page: any, label: string): Promise<string> {
  const rows = await readDividerRows(page)
  expect(rows.length, `${label}: exactly one boundary divider entry must render at the history head`).toBe(1)
  const rects = await readMessageRects(page)
  if (rects.length > 0) {
    const topMost = Math.min(...rects.map((row) => row.top))
    expect(
      rows[0].top,
      `${label}: head boundary divider must sit above every rendered message row`
    ).toBeLessThanOrEqual(topMost + GEOMETRY_TOLERANCE)
  }
  return rows[0].anchor
}

async function enableEditMode(page: any): Promise<void> {
  const toggle = page.locator('[data-testid="edit-mode-toggle"]').first()
  await expect(toggle, 'edit-mode toggle must be available').toBeVisible({ timeout: 30000 })
  await toggle.click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="edit-turn"]').length > 0, undefined, {
    timeout: 30000
  })
}

async function selectTurn(page: any, askId: string): Promise<void> {
  const turn = page.locator(`[data-testid="edit-turn"][data-turn-ask="${askId}"]`).first()
  await expect(turn, `edit turn for ask ${askId} must exist`).toBeVisible({ timeout: 30000 })
  await turn.scrollIntoViewIfNeeded()
  await turn.locator('[data-testid="edit-turn-cover"]').first().click()
}

/** Real gesture: select the turn, then delete it with the production keyboard path. */
async function deleteTurnViaEditMode(page: any, askId: string): Promise<void> {
  await selectTurn(page, askId)
  await page.keyboard.press('Meta+Backspace')
}

/** Real gesture: select the turn, stage it with Meta+x, then deselect. */
async function stageCutViaEditMode(page: any, askId: string): Promise<void> {
  await selectTurn(page, askId)
  await page.keyboard.press('Meta+x')
  // Real deselect click on the same cover (selection toggle), as a user would.
  const turn = page.locator(`[data-testid="edit-turn"][data-turn-ask="${askId}"]`).first()
  await turn.locator('[data-testid="edit-turn-cover"]').first().click()
}

/**
 * Real shortcut gestures are gated by edit-mode processing (`isProcessing`) in the production
 * keyboard handlers, so a press issued while the previous operation is still settling is dropped.
 * Wait for the app to become idle, then send the real keys.
 */
async function pressEditShortcutWhenIdle(page: any, keys: string): Promise<void> {
  await page.waitForFunction(
    () => {
      const state = (window as any).store?.getState?.()
      return state?.editMode?.isProcessing !== true
    },
    undefined,
    { timeout: 30000 }
  )
  await page.keyboard.press(keys)
}

/**
 * Activate a freshly seeded topic through the real topic list.
 *
 * The topic list is a virtualized drag-reorder list, so a pointer gesture issued while the
 * just-seeded row is still settling can be consumed as a drag (the row drops back onto itself and
 * no activation click reaches the item), which leaves the previously active topic in place and the
 * seeded messages never load. Wait until the row is attached, visible and geometrically stable
 * across consecutive animation frames, then issue exactly ONE real click and prove the app really
 * entered the topic: its seeded IDs are projected AND the rendered rows are interactive. On failure
 * the observed projection/authority state is attached instead of guessing; no readiness assertion
 * is relaxed and no click is retried.
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
  expect(settled, `topic row ${topicId} must be geometrically settled before a real activation click`).toBe(true)
  await topicItem.click()
  try {
    await page.waitForFunction(
      ({ topicId, atLeast }: { topicId: string; atLeast: number }) => {
        const state = (window as any).store.getState()
        const ids = state.messages?.messageIdsByTopic?.[topicId]
        const loading = state.messages?.loadingByTopic?.[topicId]
        return Array.isArray(ids) && ids.length >= atLeast && loading !== true
      },
      { topicId, atLeast },
      { timeout: 30000 }
    )
    await page.waitForFunction(
      (minimum: number) => document.querySelectorAll('#messages [data-message-id]').length >= minimum,
      atLeast,
      { timeout: 30000 }
    )
  } catch (error) {
    const diagnostic = await page.evaluate((tid: string) => {
      const state = (window as any).store?.getState?.() ?? {}
      const idsByTopic = state.messages?.messageIdsByTopic ?? {}
      return {
        topicId: tid,
        renderedRows: document.querySelectorAll('#messages [data-message-id]').length,
        messageIdCounts: Object.fromEntries(
          Object.entries(idsByTopic).map(([key, value]) => [key, Array.isArray(value) ? value.length : -1])
        ),
        loadingByTopic: state.messages?.loadingByTopic ?? null,
        topicRows: Array.from(document.querySelectorAll('[data-testid="topic-item"]')).map((element) => ({
          topicId: element.getAttribute('data-topic-id'),
          active: (element as HTMLElement).className.includes('active')
        })),
        liveRegionText: Array.from(document.querySelectorAll('[aria-live]'))
          .map((element) => element.textContent ?? '')
          .join(' | ')
      }
    }, topicId)
    await test.info().attach(`topic-activation-${topicId}.json`, {
      body: JSON.stringify({ topicId, atLeast, diagnostic }, null, 2),
      contentType: 'application/json'
    })
    throw error
  }
}

/** Real gesture: bring the viewport to the newest edge with genuine wheel input. */
async function scrollToNewestEdge(page: any): Promise<void> {
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  let previous = Number.NaN
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = await page.evaluate(
      () => (document.querySelector('#messages') as HTMLElement | null)?.scrollTop ?? Number.NaN
    )
    if (before === previous) break
    previous = before
    await page.mouse.wheel(0, 1200)
    await page.waitForTimeout(180)
  }
}
/**
 * Real wheel input down to the NEWEST edge, waiting until the newest row is actually rendered and
 * the container genuinely sits at its bottom edge. This establishes a route-local saved position on
 * the tail: the topic-header route switch loads the target route AROUND its own saved row anchor
 * (`chooseRouteWindowRequest`), so only a tail anchor makes the re-entered window a real tail
 * window while Main still owns the whole authoritative route.
 */
async function scrollDownToNewestRow(page: any, newestMessageId: string, attempts = 80): Promise<void> {
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  let observed = { renderedRows: 0, newestRendered: false, newestInsideViewport: false, scrollTop: 0 }
  let reached = false
  for (let attempt = 0; attempt < attempts; attempt++) {
    observed = await page.evaluate((id: string) => {
      const container = document.querySelector('#messages') as HTMLElement | null
      const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
      const newest = rows.find((node) => node.getAttribute('data-message-id') === id) ?? null
      const containerRect = container?.getBoundingClientRect() ?? null
      const newestRect = newest?.getBoundingClientRect() ?? null
      return {
        renderedRows: rows.length,
        newestRendered: newest !== null,
        newestInsideViewport: Boolean(
          containerRect &&
            newestRect &&
            newestRect.bottom <= containerRect.bottom + 6 &&
            newestRect.top >= containerRect.top - 6
        ),
        scrollTop: container?.scrollTop ?? 0
      }
    }, newestMessageId)
    if (observed.newestRendered && observed.newestInsideViewport) {
      reached = true
      break
    }
    await page.mouse.wheel(0, 700)
    await page.waitForTimeout(200)
  }
  expect(
    reached,
    `the newest row ${newestMessageId} must be rendered inside the list viewport (observed ${JSON.stringify(observed)})`
  ).toBe(true)
  // One more genuine user scroll event on the newest edge so the route-local saved position is
  // written by real user input, never by a programmatic placement.
  await page.mouse.wheel(0, 160)
  await page.waitForTimeout(300)
}
/** Real wheel pagination back up the list until the given message row is rendered. */
async function scrollBackUntilRendered(page: any, messageId: string, attempts = 40): Promise<void> {
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let attempt = 0; attempt < attempts; attempt++) {
    if ((await readMessageRects(page)).some((row) => row.id === messageId)) return
    await page.mouse.wheel(0, -560)
    await page.waitForTimeout(200)
  }
  expect(
    (await readMessageRects(page)).some((row) => row.id === messageId),
    `message ${messageId} must become rendered after real wheel pagination`
  ).toBe(true)
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

/** Real UI: switch route through the fork-divider popover peer rows. */
async function switchRouteViaDivider(page: any, boundaryAnchor: string, toBranchId: string | null): Promise<void> {
  const selected = page.locator(`[data-testid="branch-fork-selected-${boundaryAnchor}"]`).first()
  const toggle = page.locator(`[data-testid="branch-fork-toggle-${boundaryAnchor}"]`).first()
  const opener = (await selected.count()) > 0 ? selected : toggle
  await expect(opener, `fork divider opener for ${boundaryAnchor} must be visible`).toBeVisible({ timeout: 30000 })
  await opener.scrollIntoViewIfNeeded()
  await opener.click()
  const list = page.locator(`[data-testid="branch-fork-list-${boundaryAnchor}"]`).first()
  await expect(list, 'fork divider popover must open').toBeVisible({ timeout: 15000 })
  const itemTestId =
    toBranchId === null ? `branch-fork-item-parent-${boundaryAnchor}` : `branch-fork-item-${toBranchId}`
  const item = list.locator(`[data-testid="${itemTestId}"]`).first()
  await expect(item, `route peer ${itemTestId} must be offered`).toBeVisible({ timeout: 15000 })
  try {
    await item.click({ timeout: 8000 })
  } catch {
    await item.click({ force: true })
  }
}

/**
 * Real UI: reveal the owner message menubar, prove the true-branch control is genuinely
 * interactive, then deliver exactly ONE real click.
 * A hidden/covered control is never force-clicked: a forced click lands on the message body
 * underneath (selection/edit-mode layer) and silently produces no branch at all.
 */
async function clickTrueBranchControl(page: any, messageId: string): Promise<void> {
  const container = messageContainer(page, messageId)
  const btn = container.locator('[data-testid="msg-true-branch-btn"]').first()
  await expect(container, `message container ${messageId} must be visible`).toBeVisible({ timeout: 30000 })
  await container.scrollIntoViewIfNeeded()
  // Readiness (bounded): the hover must reveal the control and the control must own the hit
  // target at its own centre. Diagnostics name the blocker when it does not.
  await expect(async () => {
    await container.hover({ timeout: 5000 })
    const hit: any = await page.evaluate((id: string) => {
      const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const owner = document.querySelector(`[id="message-${esc}"][data-message-id="${esc}"]`)
      const control = owner?.querySelector('[data-testid="msg-true-branch-btn"]') as HTMLElement | null
      if (!control) return { found: false }
      const rect = control.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return { found: true, laidOut: false }
      const style = getComputedStyle(control)
      const atPoint = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      const testId = atPoint?.getAttribute('data-testid')
      return {
        found: true,
        laidOut: true,
        self: !!atPoint && (control === atPoint || control.contains(atPoint)),
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        covering: atPoint ? atPoint.tagName.toLowerCase() + (testId ? '[' + testId + ']' : '') : null,
        editMode: (window as any).store?.getState?.().editMode?.enabled === true
      }
    }, messageId)
    expect(
      hit?.self === true,
      `true-branch control for ${messageId} must be hover-revealed and own its hit target: ${JSON.stringify(hit)}`
    ).toBe(true)
  }).toPass({ timeout: 30000, intervals: [250, 500, 1000] })
  await btn.click({ timeout: 15000 })
}

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
  const created = branches.filter((b: any) => !before.some((prev: any) => prev.id === b.id))
  expect(created.length, 'exactly one new branch must appear').toBe(1)
  expect(created[0].anchorMessageId, 'fork must capture the clicked anchor').toBe(anchorMessageId)
  return created[0].id as string
}

/** Locator for the rendered message container of one stable message ID. */
function messageContainer(page: any, messageId: string): any {
  const escaped = messageId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return page.locator(`[id="message-${escaped}"][data-message-id="${escaped}"]`).first()
}

/**
 * Real UI: delete one message through the owner message menubar (`message-delete-button`), i.e. the
 * production `useMessageOperations.deleteMessageWithUndo` → `ClipboardService.deleteSingleMessage`
 * entry. The product's optional delete confirmation is part of that real path and is confirmed
 * when the setting shows it.
 */
async function deleteMessageViaMenubar(page: any, messageId: string): Promise<void> {
  const container = messageContainer(page, messageId)
  await expect(container, `message container ${messageId} must be visible`).toBeVisible({ timeout: 30000 })
  await container.scrollIntoViewIfNeeded()
  try {
    await container.hover({ timeout: 8000 })
  } catch {
    // Hover flakiness near edges: the positive assertion below requires the menubar to be revealed.
  }
  const deleteButton = container.locator('[data-testid="message-delete-button"]')
  await expect(deleteButton, `owner menubar delete control for ${messageId} must be shown`).toHaveCount(1, {
    timeout: 15000
  })
  await deleteButton.first().click({ timeout: 10000 })
  const confirmOk = page.locator('.ant-popconfirm-buttons .ant-btn-primary').first()
  const confirmationShown = await confirmOk
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  if (confirmationShown) await confirmOk.click()
}

/**
 * Real UI: switch route through the topic-header branch selector. The target window is chosen from
 * the target route's OWN saved position (`null` = the main route of the topic).
 */
async function switchRouteViaTopSelector(page: any, branchId: string | null): Promise<void> {
  await page.locator('[data-testid="branch-selector-entry"]').first().click()
  await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-testid="branch-cascader-col-0"]').first()).toBeVisible({ timeout: 15000 })
  const item = page.locator(`[data-testid="branch-cascader-item-${branchId ?? 'main'}"]`).first()
  await expect(item, `the topic-header selector must offer route ${branchId ?? 'main'}`).toBeVisible({
    timeout: 15000
  })
  await item.click()
}

test.describe('branch/reference inheritance boundary under real edit-mode Undo', () => {
  test('real edit-mode delete advances the branch anchor and migrates the fork divider; undo/redo restore the pre-operation boundary', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)
    const page = mainWindow
    const topicId = uniqueTopicId('boundary-del')
    const assistantId = await prepareAssistant(page, 20)
    const ids = await seedMainTurns(page, assistantId, topicId, 3)
    await activateTopic(page, topicId, ids.length)

    const forkAnchor = ids[3]
    const branchId = await forkAt(page, topicId, forkAnchor)
    const suffixIds = [`${topicId}-own-000`, `${topicId}-own-001`]
    await seedOwnedSuffix(page, topicId, branchId, suffixIds, 'own-')

    await expect
      .poll(() => readRouteIds(page, topicId, branchId), {
        timeout: 30000,
        message: 'branch route must compose prefix + owned suffix'
      })
      .toEqual([ids[0], ids[1], ids[2], ids[3], ...suffixIds])
    // Forking switches the active route to the new child route; the inherited-prefix turn is
    // owned by the parent route, so the real edit-mode delete happens there.
    await switchRouteViaDivider(page, forkAnchor, null)
    await waitForActiveRoute(page, topicId, null)

    // The divider identity is Main's anchor and it renders in the boundary slot.
    await expectDividerBetween(
      page,
      forkAnchor,
      { predecessorId: forkAnchor, successorId: ids[4] },
      'pre-delete: divider right after the fork anchor'
    )

    // Real edit-mode delete of the turn that owns the fork anchor (user ids[2] + assistant ids[3]).
    await enableEditMode(page)
    await deleteTurnViaEditMode(page, ids[2])

    await expectBranchAnchor(
      page,
      topicId,
      branchId,
      ids[1],
      'delete must advance the anchor to the nearest surviving predecessor'
    )
    await expect
      .poll(() => readRouteIds(page, topicId, null), {
        timeout: 30000,
        message: 'main route must lose exactly the deleted turn'
      })
      .toEqual([ids[0], ids[1], ids[4], ids[5]])
    await expect
      .poll(() => readRouteIds(page, topicId, branchId), {
        timeout: 30000,
        message: 'branch route must shorten to the advanced boundary'
      })
      .toEqual([ids[0], ids[1], ...suffixIds])
    await expectDividerBetween(
      page,
      ids[1],
      { predecessorId: ids[1], successorId: ids[4] },
      'post-delete: divider must migrate with the advanced boundary'
    )
    expect(
      (await readDividerRows(page)).filter((row) => row.anchor === forkAnchor).length,
      'the stale fork-anchor divider must be gone after the anchor advanced'
    ).toBe(0)

    // Real Undo restores the stable IDs, positions and the pre-operation boundary.
    await pressEditShortcutWhenIdle(page, 'Meta+z')
    await expectBranchAnchor(page, topicId, branchId, forkAnchor, 'undo must restore the pre-operation anchor')
    await expect
      .poll(() => readRouteIds(page, topicId, null), {
        timeout: 30000,
        message: 'undo must restore the deleted turn at its original position'
      })
      .toEqual(ids)
    await expect
      .poll(() => readRouteIds(page, topicId, branchId), {
        timeout: 30000,
        message: 'undo must restore the full inherited prefix'
      })
      .toEqual([ids[0], ids[1], ids[2], ids[3], ...suffixIds])
    await expectDividerBetween(
      page,
      forkAnchor,
      { predecessorId: forkAnchor, successorId: ids[4] },
      'post-undo: divider must return to the original slot'
    )

    // Real Redo repeats the effect exactly.
    await pressEditShortcutWhenIdle(page, 'Meta+Shift+z')
    await expectBranchAnchor(page, topicId, branchId, ids[1], 'redo must re-apply the anchor advance')
    await expect
      .poll(() => readRouteIds(page, topicId, branchId), {
        timeout: 30000,
        message: 'redo must re-shorten the branch route'
      })
      .toEqual([ids[0], ids[1], ...suffixIds])
    await expectDividerBetween(
      page,
      ids[1],
      { predecessorId: ids[1], successorId: ids[4] },
      'post-redo: divider must migrate again'
    )

    // Consecutive undo/redo keeps the boundary consistent with the last applied state.
    await pressEditShortcutWhenIdle(page, 'Meta+z')
    await expectBranchAnchor(page, topicId, branchId, forkAnchor, 'second undo must restore the original anchor again')
    // Objective history evidence: the undo must have re-armed a redo entry before the second redo
    // so a dropped keyboard press and an empty redo stack stay distinguishable on failure.
    const redoDepth = await page.evaluate(() => (window as any).store.getState().undoStack?.redoStack?.length ?? -1)
    expect(redoDepth, 'undo must leave a redo entry armed for the second redo').toBeGreaterThan(0)
    await pressEditShortcutWhenIdle(page, 'Meta+Shift+z')
    await expectBranchAnchor(page, topicId, branchId, ids[1], 'second redo must re-apply the advance again')

    // Persistence: route switch + page reload re-derive the boundary from Main.
    await switchRouteViaDivider(page, ids[1], branchId)
    await waitForActiveRoute(page, topicId, branchId)
    await expect
      .poll(() => readRouteIds(page, topicId, branchId), {
        timeout: 30000,
        message: 'branch route after divider switch'
      })
      .toEqual([ids[0], ids[1], ...suffixIds])
    await expectDividerBetween(
      page,
      ids[1],
      { predecessorId: ids[1], successorId: suffixIds[0] },
      'branch route: divider sits between the advanced boundary and the owned suffix'
    )

    await page.reload()
    await waitForAppReady(page)
    await activateTopic(page, topicId, 1)
    await expectBranchAnchor(page, topicId, branchId, ids[1], 'reload must persist the advanced anchor')
    await switchRouteViaDivider(page, ids[1], branchId)
    await waitForActiveRoute(page, topicId, branchId)
    await expect
      .poll(() => readRouteIds(page, topicId, branchId), { timeout: 30000, message: 'reloaded branch route' })
      .toEqual([ids[0], ids[1], ...suffixIds])
    await expectDividerBetween(
      page,
      ids[1],
      { predecessorId: ids[1], successorId: suffixIds[0] },
      'after reload: divider keeps the migrated slot'
    )
  })

  test('real cut→paste that removes the boundary advances the branch anchor and the reference endpoint; consecutive undo/redo stay consistent', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)
    const page = mainWindow
    const topicId = uniqueTopicId('boundary-cut')
    const referenceTopicId = uniqueTopicId('boundary-ref')
    const assistantId = await prepareAssistant(page, 20)
    const ids = await seedMainTurns(page, assistantId, topicId, 3)
    await activateTopicThroughList(page, topicId, ids.length)

    const forkAnchor = ids[3]
    const branchId = await forkAt(page, topicId, forkAnchor)
    const suffixIds = [`${topicId}-own-000`, `${topicId}-own-001`]
    await seedOwnedSuffix(page, topicId, branchId, suffixIds, 'own-')
    await seedReference(page, {
      sourceTopicId: topicId,
      sourceBranchId: null,
      targetTopicId: referenceTopicId,
      anchorMessageId: forkAnchor,
      name: `ref-${referenceTopicId}`
    })
    // Captured endpoint and live prefix boundary agree before any edit.
    await expect
      .poll(() => readReferenceMeta(page, referenceTopicId), {
        timeout: 30000,
        message: 'reference must start available at the captured endpoint'
      })
      .toEqual({ status: 'available', boundaryMessageId: forkAnchor, anchorMessageId: forkAnchor })
    const referencePrefix = await readRouteIds(page, referenceTopicId, null)
    expect(referencePrefix, 'reference prefix must be the source prefix through the captured endpoint').toEqual(
      ids.slice(0, 4)
    )
    // Forking switches the active route to the child, but the inherited-prefix turn is owned
    // by the parent route; the real cut happens there.
    await switchRouteViaDivider(page, forkAnchor, null)
    await waitForActiveRoute(page, topicId, null)

    // Real cut (Meta+x) of the turn owning the fork anchor, then real paste at the topic tail.
    await enableEditMode(page)
    await stageCutViaEditMode(page, ids[2])
    await scrollToNewestEdge(page)
    await page.keyboard.press('Meta+v')

    await expectBranchAnchor(page, topicId, branchId, ids[1], 'cut→paste delete must advance the branch anchor')
    await expect
      .poll(() => readReferenceMeta(page, referenceTopicId), {
        timeout: 30000,
        message: 'reference endpoint must advance with the source boundary'
      })
      .toEqual({ status: 'available', boundaryMessageId: ids[1], anchorMessageId: ids[1] })
    const referenceAfterCut = await readRouteIds(page, referenceTopicId, null)
    expect(referenceAfterCut.slice(0, 2), 'reference prefix must shorten to the advanced endpoint').toEqual([
      ids[0],
      ids[1]
    ])
    await expectDividerBetween(
      page,
      ids[1],
      { predecessorId: ids[1], successorId: ids[4] },
      'post-cut: reference/branch boundary divider must migrate'
    )

    // Real Undo restores source IDs/positions and both boundaries.
    await page.keyboard.press('Meta+z')
    await expectBranchAnchor(page, topicId, branchId, forkAnchor, 'undo must restore the branch anchor after cut→paste')
    await expect
      .poll(() => readReferenceMeta(page, referenceTopicId), {
        timeout: 30000,
        message: 'undo must restore the reference endpoint'
      })
      .toEqual({ status: 'available', boundaryMessageId: forkAnchor, anchorMessageId: forkAnchor })
    await expect
      .poll(() => readRouteIds(page, referenceTopicId, null), {
        timeout: 30000,
        message: 'undo must restore the reference prefix length'
      })
      .toEqual(referencePrefix)

    // Real Redo repeats the cut→paste effect on both boundaries.
    await page.keyboard.press('Meta+Shift+z')
    await expectBranchAnchor(page, topicId, branchId, ids[1], 'redo must re-advance the branch anchor')
    await expect
      .poll(() => readReferenceMeta(page, referenceTopicId), {
        timeout: 30000,
        message: 'redo must re-advance the reference endpoint'
      })
      .toEqual({ status: 'available', boundaryMessageId: ids[1], anchorMessageId: ids[1] })

    await page.keyboard.press('Meta+z')
    await expectBranchAnchor(page, topicId, branchId, forkAnchor, 'second undo must restore the anchor again')
    await expect
      .poll(() => readReferenceMeta(page, referenceTopicId), {
        timeout: 30000,
        message: 'second undo must restore the endpoint again'
      })
      .toEqual({ status: 'available', boundaryMessageId: forkAnchor, anchorMessageId: forkAnchor })
  })

  test('deleting the whole inherited prefix keeps branch and clone openable, renders the boundary entry at the history head (even for a 0-message child route), and persists across route switch + reload', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)
    const page = mainWindow
    const topicId = uniqueTopicId('boundary-empty')
    const referenceTopicId = uniqueTopicId('boundary-empty-ref')
    const assistantId = await prepareAssistant(page, 20)
    const ids = await seedMainTurns(page, assistantId, topicId, 2)
    await activateTopic(page, topicId, ids.length)

    const owningBranchId = await forkAt(page, topicId, ids[3])
    const suffixIds = [`${topicId}-own-000`, `${topicId}-own-001`]
    await seedOwnedSuffix(page, topicId, owningBranchId, suffixIds, 'own-')
    // Forking switches the active route to the child; return to the parent route through the
    // real divider before forking again (a parent-route row is what the toolbar fork needs).
    await switchRouteViaDivider(page, ids[3], null)
    await waitForActiveRoute(page, topicId, null)
    // A second child route with ZERO own messages: its boundary entry is all it has.
    const emptyBranchId = await forkAt(page, topicId, ids[1])
    await switchRouteViaDivider(page, ids[1], null)
    await waitForActiveRoute(page, topicId, null)
    await seedReference(page, {
      sourceTopicId: topicId,
      sourceBranchId: null,
      targetTopicId: referenceTopicId,
      anchorMessageId: ids[3],
      name: `ref-${referenceTopicId}`
    })
    await expect
      .poll(() => readReferenceMeta(page, referenceTopicId), {
        timeout: 30000,
        message: 'reference must start available'
      })
      .toEqual({ status: 'available', boundaryMessageId: ids[3], anchorMessageId: ids[3] })

    // Real edit mode: delete both main turns, emptying the inherited prefix.
    await enableEditMode(page)
    await deleteTurnViaEditMode(page, ids[2])
    await deleteTurnViaEditMode(page, ids[0])

    await expect
      .poll(() => readRouteIds(page, topicId, null), {
        timeout: 30000,
        message: 'main route must be emptied by the two real deletes'
      })
      .toEqual([])
    const branchesAfterEmpty = await listBranches(page, topicId)
    expect(
      branchesAfterEmpty.map((b: any) => b.id).sort(),
      'message deletes must never delete branch objects (no cascade, both children survive)'
    ).toEqual([owningBranchId, emptyBranchId].sort())
    await expect
      .poll(() => readRouteIds(page, topicId, owningBranchId), {
        timeout: 30000,
        message: 'owned suffix must survive an emptied prefix'
      })
      .toEqual(suffixIds)
    await expect
      .poll(() => readRouteIds(page, topicId, emptyBranchId), {
        timeout: 30000,
        message: 'the 0-message child route resolves to an empty route'
      })
      .toEqual([])
    // No surviving predecessor for the reference endpoint: no fabricated prefix.
    await expectReferenceMissing(
      page,
      referenceTopicId,
      [ids[1], ids[3]],
      'reference must degrade to missing instead of inventing history'
    )

    // Both sibling branches collapse onto the SAME surviving boundary id: Main only advances a
    // boundary when a surviving predecessor exists (advanceInheritanceBoundariesInTx keeps the
    // captured id otherwise), so deleting the whole prefix leaves both anchors at ids[1].
    // Renderer divider groups are keyed by (anchor, parent) and list every child at that anchor,
    // so this is ONE head divider entry offering both child routes — not one row per branch.
    const anchorsAfterEmpty = [
      await readBranchAnchor(page, topicId, owningBranchId),
      await readBranchAnchor(page, topicId, emptyBranchId)
    ]
    expect(anchorsAfterEmpty, 'both sibling branches must keep the same surviving boundary id').toEqual([
      ids[1],
      ids[1]
    ])
    await expect
      .poll(async () => (await readDividerRows(page)).length, {
        timeout: 30000,
        message: 'the shared head boundary group must stay available as one divider entry'
      })
      .toBe(1)
    expect(
      (await readDividerRows(page)).map((row) => row.anchor),
      'the head boundary entry must carry the authoritative anchor'
    ).toEqual([ids[1]])

    // Same-snapshot empty derivation: with the inherited prefix deleted, Main keeps the captured
    // anchor id on both branches but derives the boundary kind as `head` (no surviving row).
    const emptyBoundary = { anchorMessageId: ids[1], kind: 'head', messageId: null }
    await expectBranchBoundary(
      page,
      topicId,
      owningBranchId,
      emptyBoundary,
      'emptied prefix: the suffix-owning branch derives the head boundary'
    )
    await expectBranchBoundary(
      page,
      topicId,
      emptyBranchId,
      emptyBoundary,
      'emptied prefix: the 0-message branch derives the head boundary'
    )

    // Real edit-mode Undo restores the deleted turn groups. The captured anchor ids stay the same,
    // but Main must re-derive a real `message` boundary from the restored route, and the restored
    // rows must render ABOVE the boundary divider (visual geometry, never DOM order).
    await pressEditShortcutWhenIdle(page, 'Meta+z')
    await expect
      .poll(() => readRouteIds(page, topicId, null), {
        timeout: 30000,
        message: 'the first real undo must restore the first deleted turn group into the emptied main route'
      })
      .toEqual([ids[0], ids[1]])
    const firstTurnBoundary = { anchorMessageId: ids[1], kind: 'message', messageId: ids[1] }
    await expectBranchBoundary(
      page,
      topicId,
      owningBranchId,
      firstTurnBoundary,
      'undo must re-derive a message boundary for the suffix-owning branch'
    )
    await expectBranchBoundary(
      page,
      topicId,
      emptyBranchId,
      firstTurnBoundary,
      'undo must re-derive a message boundary for the 0-message branch'
    )
    await expectDividerBetween(
      page,
      ids[1],
      { predecessorId: ids[1], successorId: null },
      'post-undo: the restored assistant/user turn renders above the boundary divider'
    )

    await pressEditShortcutWhenIdle(page, 'Meta+z')
    await expect
      .poll(() => readRouteIds(page, topicId, null), {
        timeout: 30000,
        message: 'the second real undo must restore the whole deleted inherited prefix'
      })
      .toEqual(ids)
    await expectBranchBoundary(
      page,
      topicId,
      owningBranchId,
      { anchorMessageId: ids[3], kind: 'message', messageId: ids[3] },
      'restored prefix: the suffix-owning branch boundary is its fork anchor row again'
    )
    await expectBranchBoundary(
      page,
      topicId,
      emptyBranchId,
      { anchorMessageId: ids[1], kind: 'message', messageId: ids[1] },
      'restored prefix: the 0-message branch boundary is its fork anchor row again'
    )
    await expectDividerBetween(
      page,
      ids[1],
      { predecessorId: ids[1], successorId: ids[2] },
      'restored prefix: the boundary divider sits below the restored inherited turn'
    )
    await expect
      .poll(() => readRouteIds(page, topicId, owningBranchId), {
        timeout: 30000,
        message: 'restored prefix: the owned suffix child route regains its inherited history'
      })
      .toEqual([...ids, ...suffixIds])
    await expect
      .poll(() => readRouteIds(page, topicId, emptyBranchId), {
        timeout: 30000,
        message: 'restored prefix: the 0-message child route inherits the restored prefix again'
      })
      .toEqual([ids[0], ids[1]])
    await expect
      .poll(() => readReferenceMeta(page, referenceTopicId), {
        timeout: 30000,
        message: 'restored prefix: the reference endpoint is available again'
      })
      .toEqual({ status: 'available', boundaryMessageId: ids[3], anchorMessageId: ids[3] })

    // Real Redo re-applies both deletes: the same captured anchor ids must fall back to `head`
    // derivation, and the owned suffix / 0-message child routes must stay usable.
    await pressEditShortcutWhenIdle(page, 'Meta+Shift+z')
    await expect
      .poll(() => readRouteIds(page, topicId, null), {
        timeout: 30000,
        message: 'the first real redo must re-delete the first turn group'
      })
      .toEqual([ids[0], ids[1]])
    await expectBranchBoundary(
      page,
      topicId,
      owningBranchId,
      firstTurnBoundary,
      'first redo: the suffix-owning branch derives the advanced message boundary again'
    )
    await expectBranchBoundary(
      page,
      topicId,
      emptyBranchId,
      firstTurnBoundary,
      'first redo: the 0-message branch derives its anchor row boundary again'
    )

    await pressEditShortcutWhenIdle(page, 'Meta+Shift+z')
    await expect
      .poll(() => readRouteIds(page, topicId, null), {
        timeout: 30000,
        message: 'the second real redo must re-empty the inherited prefix'
      })
      .toEqual([])
    await expectBranchBoundary(
      page,
      topicId,
      owningBranchId,
      emptyBoundary,
      'second redo: the suffix-owning branch is a derived head boundary again'
    )
    await expectBranchBoundary(
      page,
      topicId,
      emptyBranchId,
      emptyBoundary,
      'second redo: the 0-message branch is a derived head boundary again'
    )
    await expectDividerBetween(
      page,
      ids[1],
      { predecessorId: null, successorId: null },
      'second redo: the shared boundary entry renders at the history head again'
    )
    await expect
      .poll(() => readRouteIds(page, topicId, owningBranchId), {
        timeout: 30000,
        message: 'second redo: the owned suffix stays usable'
      })
      .toEqual(suffixIds)
    await expect
      .poll(() => readRouteIds(page, topicId, emptyBranchId), {
        timeout: 30000,
        message: 'second redo: the 0-message child route stays usable'
      })
      .toEqual([])
    await expectReferenceMissing(
      page,
      referenceTopicId,
      [ids[1], ids[3]],
      'second redo: the reference is missing again'
    )

    // The shared entry keeps every child route reachable.
    const sharedSelected = page.locator(`[data-testid="branch-fork-selected-${ids[1]}"]`).first()
    const sharedToggle = page.locator(`[data-testid="branch-fork-toggle-${ids[1]}"]`).first()
    const sharedOpener = (await sharedSelected.count()) > 0 ? sharedSelected : sharedToggle
    await expect(sharedOpener, 'the shared head-group opener must be visible').toBeVisible({ timeout: 30000 })
    await sharedOpener.click()
    const sharedList = page.locator(`[data-testid="branch-fork-list-${ids[1]}"]`).first()
    await expect(sharedList, 'the shared head-group popover must open').toBeVisible({ timeout: 15000 })
    const owningOption = sharedList.locator(`[data-testid="branch-fork-item-${owningBranchId}"]`).first()
    await expect(owningOption, 'the suffix-owning child route must be offered').toBeVisible({ timeout: 15000 })
    await expect(
      sharedList.locator(`[data-testid="branch-fork-item-${emptyBranchId}"]`),
      'the 0-message child route must be offered from the same entry'
    ).toHaveCount(1)

    // Open the suffix-owning child from that shared entry: it renders its owned suffix under a head
    // boundary entry.
    await owningOption.click()
    await waitForActiveRoute(page, topicId, owningBranchId)
    await expect
      .poll(() => readRouteIds(page, topicId, owningBranchId), {
        timeout: 30000,
        message: 'owner child route after switch'
      })
      .toEqual(suffixIds)
    expect(await readHeadDividerAnchor(page, 'owner child route with an emptied prefix')).toBe(ids[1])
    await expectDividerBetween(
      page,
      ids[1],
      { predecessorId: null, successorId: suffixIds[0] },
      'owner child route: head boundary entry sits above the owned suffix'
    )

    // Back to the emptied parent, then open the 0-message child route: boundary entry still there.
    await switchRouteViaDivider(page, ids[1], null)
    await waitForActiveRoute(page, topicId, null)
    await switchRouteViaDivider(page, ids[1], emptyBranchId)
    await waitForActiveRoute(page, topicId, emptyBranchId)
    expect(await readRouteIds(page, topicId, emptyBranchId), 'the 0-message child route has no own rows').toEqual([])
    expect(
      await readHeadDividerAnchor(page, '0-message child route keeps its boundary entry'),
      'even a 0-message child route exposes the boundary entry with the authoritative anchor'
    ).toBe(ids[1])

    // Persistence: reload, then re-open the clone (survives, still missing) and the child route.
    await page.reload()
    await waitForAppReady(page)
    // An emptied main route has no messages: activation only needs the topic row itself.
    const reloadedTopicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
    await expect(reloadedTopicItem).toBeVisible({ timeout: 30000 })
    await reloadedTopicItem.click()
    // The active route is persisted and restored on reload; the emptied parent is the MAIN route,
    // so re-enter it explicitly through the real topic-header selector (never assume null).
    await switchRouteViaTopSelector(page, 'main')
    await waitForActiveRoute(page, topicId, null)
    await expect
      .poll(() => readRouteIds(page, topicId, emptyBranchId), {
        timeout: 30000,
        message: 'reloaded 0-message child route'
      })
      .toEqual([])
    await expect
      .poll(() => readRouteIds(page, topicId, owningBranchId), { timeout: 30000, message: 'reloaded owned suffix' })
      .toEqual(suffixIds)
    await expectReferenceMissing(
      page,
      referenceTopicId,
      [ids[1], ids[3]],
      'reloaded reference stays missing (no invention, no cascade)'
    )
    const reloadedBranches = await listBranches(page, topicId)
    expect(reloadedBranches.map((b: any) => b.id).sort()).toEqual([owningBranchId, emptyBranchId].sort())
    const reloadedAnchors = [
      await readBranchAnchor(page, topicId, owningBranchId),
      await readBranchAnchor(page, topicId, emptyBranchId)
    ]
    expect(reloadedAnchors, 'the reloaded shared boundary id must persist for both branches').toEqual([ids[1], ids[1]])
    expect(
      (await readDividerRows(page)).length,
      'the reloaded emptied parent route still exposes the shared boundary entry at the head'
    ).toBe(1)
  })

  test('an ordinary same-id insert is not an undo and never restores the boundary', async ({ mainWindow }) => {
    test.setTimeout(240_000)
    const page = mainWindow
    const topicId = uniqueTopicId('boundary-sameid')
    const assistantId = await prepareAssistant(page, 20)
    const ids = await seedMainTurns(page, assistantId, topicId, 3)
    await activateTopic(page, topicId, ids.length)

    const forkAnchor = ids[3]
    const branchId = await forkAt(page, topicId, forkAnchor)
    const suffixIds = [`${topicId}-own-000`, `${topicId}-own-001`]
    await seedOwnedSuffix(page, topicId, branchId, suffixIds, 'own-')
    // Forking switches the active route to the child; the inherited-prefix turn is owned by
    // the parent route, so the real edit-mode delete must happen there.
    await switchRouteViaDivider(page, forkAnchor, null)
    await waitForActiveRoute(page, topicId, null)

    await enableEditMode(page)
    await deleteTurnViaEditMode(page, ids[2])
    await expectBranchAnchor(
      page,
      topicId,
      branchId,
      ids[1],
      'delete must advance the anchor before the same-id insert'
    )

    // Ordinary insert (Main append, not an undo) reusing the deleted stable ID.
    const inserted: any = await page.evaluate(
      async ({ topicId, ids }: { topicId: string; ids: string[] }) => {
        const api: any = (window as any).api.chatDb
        const epoch = '2026-01-01T00:00:00.000Z'
        const res = await api.appendMessage({
          topicId,
          message: {
            id: ids[3],
            topicId,
            role: 'assistant',
            createdAt: epoch,
            updatedAt: epoch,
            status: 'success',
            blocks: [`${ids[3]}-block-readded`],
            model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' },
            modelId: 'mock-model',
            askId: ids[2]
          },
          blocks: [
            {
              id: `${ids[3]}-block-readded`,
              messageId: ids[3],
              type: 'main_text',
              content: 'same-id-readded',
              status: 'success',
              createdAt: epoch,
              updatedAt: epoch
            }
          ]
        })
        return { ok: res?.ok === true, raw: res }
      },
      { topicId, ids }
    )
    expect(inserted.ok, `ordinary same-id insert must succeed: ${JSON.stringify(inserted.raw)}`).toBe(true)

    // The insert is a normal write: the boundary must NOT be rewound to the reused id.
    await expectBranchAnchor(
      page,
      topicId,
      branchId,
      ids[1],
      'an ordinary same-id insert must never restore the pre-delete boundary'
    )
    const routeAfterInsert = await readRouteIds(page, topicId, branchId)
    expect(routeAfterInsert, 'branch route must remain the advanced prefix plus the owned suffix').toEqual([
      ids[0],
      ids[1],
      ...suffixIds
    ])
    await expectDividerBetween(
      page,
      ids[1],
      { predecessorId: ids[1], successorId: ids[4] },
      'same-id insert must not move the divider'
    )
    expect(
      (await readDividerRows(page)).filter((row) => row.anchor === ids[3]).length,
      'the reused id must not create a second boundary entry'
    ).toBe(0)
  })

  test('real single-assistant menubar delete advances the fork boundary to the user turn above it, and real undo/redo restore the assistant boundary', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)
    const page = mainWindow
    const topicId = uniqueTopicId('boundary-menu')
    const referenceTopicId = uniqueTopicId('boundary-menu-ref')
    const assistantId = await prepareAssistant(page, 50)
    const ids = await seedMainTurns(page, assistantId, topicId, 3)
    await activateTopic(page, topicId, ids.length)

    // The owner fork boundary IS the assistant turn's own message (user ids[2] → assistant ids[3]).
    const forkAnchor = ids[3]
    const branchId = await forkAt(page, topicId, forkAnchor)
    const suffixIds = [`${topicId}-own-000`, `${topicId}-own-001`]
    await seedOwnedSuffix(page, topicId, branchId, suffixIds, 'own-')
    await seedReference(page, {
      sourceTopicId: topicId,
      sourceBranchId: null,
      targetTopicId: referenceTopicId,
      anchorMessageId: forkAnchor,
      name: `ref-${referenceTopicId}`
    })
    // Forking switches the active route to the child; the assistant row is owned by main.
    await switchRouteViaDivider(page, forkAnchor, null)
    await waitForActiveRoute(page, topicId, null)
    expect(await readBranchAnchor(page, topicId, branchId), 'the branch endpoint must be the assistant stable ID').toBe(
      forkAnchor
    )
    await expect
      .poll(() => readReferenceMeta(page, referenceTopicId), {
        timeout: 30000,
        message: 'the clone endpoint must start at the assistant'
      })
      .toEqual({ status: 'available', boundaryMessageId: forkAnchor, anchorMessageId: forkAnchor })
    await expectDividerBetween(
      page,
      forkAnchor,
      { predecessorId: forkAnchor, successorId: ids[4] },
      'pre-delete: the divider sits below the assistant boundary'
    )

    // Real menubar delete of the single assistant message; the user turn above it stays.
    await deleteMessageViaMenubar(page, forkAnchor)
    await expect
      .poll(() => readRouteIds(page, topicId, null), {
        timeout: 30000,
        message: 'the menubar delete must remove only the assistant row, never its user turn'
      })
      .toEqual([ids[0], ids[1], ids[2], ids[4], ids[5]])
    await expectBranchAnchor(
      page,
      topicId,
      branchId,
      ids[2],
      'the boundary must move to the surviving user turn above the assistant'
    )
    await expect
      .poll(() => readReferenceMeta(page, referenceTopicId), {
        timeout: 30000,
        message: 'the clone endpoint must move to the user turn'
      })
      .toEqual({ status: 'available', boundaryMessageId: ids[2], anchorMessageId: ids[2] })
    await expect
      .poll(() => readRouteIds(page, topicId, branchId), {
        timeout: 30000,
        message: 'the branch route must shorten to the user-turn boundary'
      })
      .toEqual([ids[0], ids[1], ids[2], ...suffixIds])
    await expectDividerBetween(
      page,
      ids[2],
      { predecessorId: ids[2], successorId: ids[4] },
      'post-delete: the divider migrates below the user turn'
    )
    expect(
      (await readDividerRows(page)).filter((row) => row.anchor === forkAnchor).length,
      'the assistant-anchored divider must be gone after the boundary moved'
    ).toBe(0)

    // Real product Undo restores the same assistant stable ID and the pre-operation boundary.
    await enableEditMode(page)
    await page.keyboard.press('Meta+z')
    await expect
      .poll(() => readRouteIds(page, topicId, null), {
        timeout: 30000,
        message: 'undo must restore the assistant at its original position'
      })
      .toEqual(ids)
    await expectBranchAnchor(page, topicId, branchId, forkAnchor, 'undo must restore the assistant anchor')
    await expect
      .poll(() => readReferenceMeta(page, referenceTopicId), {
        timeout: 30000,
        message: 'undo must restore the clone endpoint'
      })
      .toEqual({ status: 'available', boundaryMessageId: forkAnchor, anchorMessageId: forkAnchor })
    const restoredAssistant = (await readMessageRects(page)).find((row) => row.id === forkAnchor)
    expect(restoredAssistant, 'the restored assistant row must render with the same stable ID').toBeTruthy()
    const restoredDivider = (await readDividerRows(page)).find((row) => row.anchor === forkAnchor)
    expect(restoredDivider, 'the divider must return to the assistant boundary').toBeTruthy()
    expect(
      restoredDivider?.top ?? Number.NaN,
      'the divider must render BELOW the restored assistant, never between the user turn and the assistant'
    ).toBeGreaterThanOrEqual((restoredAssistant?.bottom ?? Number.NaN) - GEOMETRY_TOLERANCE)
    expect(
      restoredDivider?.bottom ?? Number.NaN,
      'the divider must render above the message that follows the restored assistant'
    ).toBeLessThanOrEqual(((await readMessageRects(page)).find((row) => row.id === ids[4])?.top ?? Number.NaN) + 2)

    // Real Redo re-applies, and a further real Undo restores the assistant boundary again.
    await page.keyboard.press('Meta+Shift+z')
    await expectBranchAnchor(page, topicId, branchId, ids[2], 'redo must re-apply the user-turn boundary')
    expect(await readRouteIds(page, topicId, null), 'redo must remove the assistant again').toEqual([
      ids[0],
      ids[1],
      ids[2],
      ids[4],
      ids[5]
    ])
    await page.keyboard.press('Meta+z')
    await expectBranchAnchor(page, topicId, branchId, forkAnchor, 'the second undo must restore the assistant boundary')
    expect(await readRouteIds(page, topicId, null), 'the redo loop must end with the assistant restored').toEqual(ids)
    // Leave edit mode through the product's own exit gesture before touching route UI again.
    await page.keyboard.press('Escape')

    // Real divider switch into the child route: the restored assistant is inherited there.
    await switchRouteViaDivider(page, forkAnchor, branchId)
    await waitForActiveRoute(page, topicId, branchId)
    await expect
      .poll(() => readRouteIds(page, topicId, branchId), {
        timeout: 30000,
        message: 'the child route must inherit through the assistant boundary'
      })
      .toEqual([ids[0], ids[1], ids[2], ids[3], ...suffixIds])
    const inheritedAssistant = messageContainer(page, forkAnchor)
    await expect(
      inheritedAssistant,
      'the restored assistant must render on the child route inside the inherited region'
    ).toBeVisible({ timeout: 30000 })
    await expect(
      inheritedAssistant.locator('[data-testid="message-delete-button"]'),
      'an inherited assistant row carries no owner delete control, so this row is genuinely inherited'
    ).toHaveCount(0)
    await expectDividerBetween(
      page,
      forkAnchor,
      { predecessorId: forkAnchor, successorId: suffixIds[0] },
      'child route: the divider sits below the inherited assistant boundary'
    )
  })

  test('a window that excludes the inherited prefix never fabricates a head divider', async ({ mainWindow }) => {
    test.setTimeout(240_000)
    const page = mainWindow
    const topicId = uniqueTopicId('boundary-window')
    // Window setup happens BEFORE the first activation, so every routed load in this test is
    // already bounded by displayCount (no enlarged test window is ever applied afterwards).
    const assistantId = await prepareAssistant(page, 3)
    const ids = await seedMainTurns(page, assistantId, topicId, 3)
    await activateTopic(page, topicId, 1)
    // The fork is a real toolbar gesture, so its anchor row must be genuinely rendered:
    // page back with real wheel input until it appears.
    await scrollBackUntilRendered(page, ids[1])

    const forkAnchor = ids[1]
    const branchId = await forkAt(page, topicId, forkAnchor)
    const suffixIds: string[] = []
    for (let index = 0; index < 30; index++) {
      suffixIds.push(`${topicId}-own-${String(index).padStart(3, '0')}`)
    }
    await seedOwnedSuffix(page, topicId, branchId, suffixIds, 'own-')

    // The child route is the ACTIVE route here (a real fork lands on the new route), but its rendered
    // window still holds only the inherited prefix: an IPC-seeded suffix is not part of that resident
    // projection. Leave and re-enter through the topic-header selector so the route loads its own
    // real windowed read around ITS saved row anchor (the boundary row) — head of the route, with
    // newer rows genuinely authoritative behind it.
    await switchRouteViaTopSelector(page, null)
    await waitForActiveRoute(page, topicId, null)
    await switchRouteViaTopSelector(page, branchId)
    await waitForActiveRoute(page, topicId, branchId)
    // Real wheel input down to the newest edge: the child route's own route-local saved position
    // becomes the tail row.
    await scrollDownToNewestRow(page, suffixIds[suffixIds.length - 1])
    // Leave and re-enter again: the target window is now chosen from the child's TAIL anchor, so the
    // loaded window is a genuine newest tail and the inherited prefix stays outside it, while Main
    // still owns the whole authoritative route.
    await switchRouteViaTopSelector(page, null)
    await waitForActiveRoute(page, topicId, null)
    await switchRouteViaTopSelector(page, branchId)
    await waitForActiveRoute(page, topicId, branchId)

    // Read-only Main authority (the full route) vs. what the route window actually loaded.
    const authorityIds = await readRouteIds(page, topicId, branchId, 100)
    expect(authorityIds, 'the child route must be the inherited prefix plus the owned suffix').toEqual([
      ...ids.slice(0, 2),
      ...suffixIds
    ])
    await expect
      .poll(async () => (await readMessageRects(page)).length, {
        timeout: 30000,
        message: 'the switched route must load a bounded window of rendered rows'
      })
      .toBeGreaterThan(0)
    const renderedChronological = (await readMessageRects(page)).sort((a, b) => a.top - b.top).map((row) => row.id)
    expect(
      renderedChronological.length,
      'the routed window must be a strict subset of the full authoritative route'
    ).toBeLessThan(authorityIds.length)
    expect(
      renderedChronological,
      'the routed window must be the genuine newest tail of the full authoritative route'
    ).toEqual(authorityIds.slice(authorityIds.length - renderedChronological.length))
    expect(
      authorityIds.findIndex((id) => id === renderedChronological[0]),
      'the loaded window must start AFTER the inherited prefix, so Main genuinely still has older rows'
    ).toBeGreaterThan(authorityIds.findIndex((id) => id === forkAnchor))
    expect(renderedChronological, 'the windowed route must not contain the boundary message').not.toContain(forkAnchor)
    expect(renderedChronological, 'the windowed route must not contain the inherited prefix').not.toContain(ids[0])

    expect(
      (await readDividerRows(page)).length,
      'no boundary divider may be fabricated while the boundary group is outside the window'
    ).toBe(0)
    const firstRowTop = Math.min(...(await readMessageRects(page)).map((row) => row.top))
    const fabricatedAtHead = await page.evaluate((topLimit: number) => {
      const nodes = Array.from(document.querySelectorAll('#messages [data-divider-anchor]')) as HTMLElement[]
      return nodes.some((el) => el.getBoundingClientRect().top <= topLimit)
    }, firstRowTop)
    expect(fabricatedAtHead, 'no divider may be pinned above the first loaded row').toBe(false)

    // Real wheel pagination brings the true boundary group into the window: only then does the
    // divider appear, and it appears in its real slot.
    await scrollBackUntilRendered(page, ids[0], 80)
    await expectDividerBetween(
      page,
      forkAnchor,
      { predecessorId: forkAnchor, successorId: suffixIds[0] },
      'after real pagination the true boundary divider appears in its real slot'
    )
    expect(
      (await readDividerRows(page)).length,
      'exactly one boundary divider renders once the boundary is loaded'
    ).toBe(1)
  })
})
