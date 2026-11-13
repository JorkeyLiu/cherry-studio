/**
 * Topic segment fold (collapsed message group) — context participation E2E
 *
 * Durable asset for the folded-group semantics: a folded group's members leave
 * the real model request, the token/context counts and the boundary divider by
 * one shared "participating member" definition, the window origin never moves,
 * expanding restores participation at the original position, and the folded
 * state survives a same-profile relaunch with the collapsed header rendered.
 *
 * Evidence tier: INTEGRATED —
 * - deterministic setup only for content (approved `ensureTopic` +
 *   `pasteMessagesToTopic` + `upsertSegment`, the same seeds the segment
 *   authority catalog spec uses); no test-only fold dispatch;
 * - the fold/expand gestures are REAL UI clicks on the rendered group chrome;
 * - requests are proven from the mock provider request log (§6) by comparing
 *   user prompts / assistant contents, never by Redux alone;
 * - counts/token block come from the rendered `token-count-context`;
 * - persistence is proven post-exit through `topic_segments.extra` (the folded
 *   flag's durable home) and across a relaunch with the same disposable profile.
 *
 * Locators (stable, presentation-only — no decorative classes):
 *   [data-testid="topic-segment-line"][data-segment-id][data-segment-folded]
 *   topic-segment-label / topic-segment-rule / topic-segment-fold
 *   topic-segment-expand / topic-segment-count / topic-segment-actions
 * The collapsed header is absolutely positioned chrome (zero flow height), so
 * these tests never assert a row band; they assert that content above the
 * group keeps its position and the fold's height delta lands below it.
 */

import {
  expect,
  findProductRequestAfter,
  getChatDbPath,
  getRequestSequence,
  getUserDataDir,
  queryChatDbViaElectron,
  test
} from '../../fixtures/electron.fixture'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { relaunchSameProfile } from '../../utils/restart-electron-profile'
import { waitForAppReady } from '../../utils/wait-helpers'

const SEED_TURNS = 5
const FOLD_TURN = 3 // 1-indexed seeded turn whose user+assistant rows are folded
const DISPLAY_LIMIT = 20
const CONTEXT_COUNT = 10

/**
 * Turn accounting behind `[data-testid="token-count-context"]`, which renders
 * `current/max` in CONTEXT TURNS (`src/renderer/src/services/contextInfoService.ts:232-248`)
 * with turns built by `src/renderer/src/services/contextTurnService.ts:61-97`.
 *
 * The seed deliberately carries NO `askId` on assistant rows: an assistant joins
 * the current turn only when `askId === userId`, so every seeded message opens
 * its own turn. That grouping semantics is what the counts below must respect —
 * adding `askId` to "simplify" the numbers would quietly change the fixture.
 *   - seed: SEED_TURNS × 2 messages = SEED_TURNS × 2 turns
 *   - folding seeded turn 3 (its user + assistant) removes 2 turns
 *   - a REAL product exchange DOES link assistant → user (askId = userId),
 *     so one sent exchange is ONE extra turn, not two.
 */
const SEED_MESSAGES = SEED_TURNS * 2
/** Context turns removed by the fold (see the turn accounting above). */
const FOLDED_TURNS = 2
/**
 * Mounted message ROWS the group owns: the user + assistant row of `FOLD_TURN`.
 * A folded group leaves the flow entirely, so the viewport can never mount these
 * rows — `FOLDED_TURNS` counts context turns, this counts DOM rows.
 */
const FOLDED_MESSAGE_COUNT = 2
/**
 * Rows the viewport can ever mount while the group is folded: every seeded row
 * except the folded ones. Anything that waits for loaded rows on a folded topic
 * has to wait for THIS count, never for `SEED_MESSAGES`.
 */
const MOUNTED_ROWS_WHILE_FOLDED = SEED_MESSAGES - FOLDED_MESSAGE_COUNT
const TURNS_WHILE_FOLDED = SEED_MESSAGES - FOLDED_TURNS
const TURNS_AFTER_FOLDED_SEND = TURNS_WHILE_FOLDED + 1
const TURNS_AFTER_EXPAND_SEND = TURNS_AFTER_FOLDED_SEND + FOLDED_TURNS + 1

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

function msgId(topicId: string, index: number): string {
  return `${topicId}-msg-${pad(index, 5)}`
}

/** 1-indexed turn → message indices (user = 2n-2, assistant = 2n-1). */
function turnIndices(turn: number): { user: number; assistant: number } {
  return { user: (turn - 1) * 2, assistant: (turn - 1) * 2 + 1 }
}

function userText(turn: number): string {
  return `fold-seed-turn-${turn}-user`
}

function assistantText(turn: number): string {
  return `fold-seed-turn-${turn}-assistant`
}

// ---------------------------------------------------------------------------
// Deterministic setup (content only — the fold itself is a real UI gesture)
// ---------------------------------------------------------------------------

async function prepareDisplayCountAndAssistant(page: any): Promise<string> {
  await page.evaluate((limit: number) => {
    ;(window as any).store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
  }, DISPLAY_LIMIT)
  const liveAssistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

/** contextCount is renderer assistant-settings persistence (read by the resolver). */
async function seedContextCount(page: any, contextCount: number, assistantId: string): Promise<void> {
  await page.evaluate(
    ({ assistantId, contextCount }: { assistantId: string; contextCount: number }) => {
      const store = (window as any).store
      store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: { assistantId, settings: { contextCount } }
      })
    },
    { assistantId, contextCount }
  )
  const seeded = await page.evaluate(
    (assistantId: string) =>
      (window as any).store.getState().assistants.assistants.find((a: any) => a.id === assistantId)?.settings
        ?.contextCount,
    assistantId
  )
  expect(seeded).toBe(contextCount)
}

function buildSeedEntries(topicId: string, assistantId: string) {
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  const createdAt = '2026-01-01T00:00:00.000Z'
  for (let turn = 1; turn <= SEED_TURNS; turn++) {
    for (const role of ['user', 'assistant'] as const) {
      const index = role === 'user' ? turnIndices(turn).user : turnIndices(turn).assistant
      const id = msgId(topicId, index)
      entries.push({
        message: {
          id,
          topicId,
          role,
          // Only assistant rows carry the producing assistant; user rows must
          // not carry the key at all (not even with an `undefined` value).
          ...(role === 'assistant' ? { assistantId } : {}),
          createdAt,
          updatedAt: createdAt,
          status: 'success',
          blocks: [`${id}-block`],
          sortOrder: index
        },
        blocks: [
          {
            id: `${id}-block`,
            messageId: id,
            type: 'main_text',
            content: role === 'user' ? userText(turn) : assistantText(turn),
            status: 'success',
            createdAt,
            updatedAt: createdAt
          }
        ]
      })
    }
  }
  return entries
}

/**
 * Seeds the topic rows through the defined authority path, then writes the
 * segment through the same Main upsert the drawer/catalog spec uses. The
 * segment is created BEFORE cold activation so its catalog reaches Redux only
 * through the production joint publication (loadTopicMessagesThunk).
 * Returns the folded group's member ids.
 */
async function seedFoldedCandidateTopic(
  page: any,
  assistantId: string,
  topicId: string,
  segmentId: string,
  segmentName: string,
  foldTurn: number = FOLD_TURN
): Promise<string[]> {
  const name = `Segment Fold Test ${topicId}`
  const addOk = await page.evaluate(
    ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
      try {
        ;(window as any).store.dispatch({
          type: 'assistants/addTopic',
          payload: {
            assistantId,
            topic: {
              id: topicId,
              assistantId,
              name,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            }
          }
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId, name }
  )
  expect(addOk.ok, `addTopic failed: ${(addOk as any).err}`).toBe(true)

  const entries = buildSeedEntries(topicId, assistantId)
  const memberIds = [msgId(topicId, turnIndices(foldTurn).user), msgId(topicId, turnIndices(foldTurn).assistant)]

  const persisted = await page.evaluate(
    async ({ topicId, assistantId, name, entries, segmentId, segmentName, memberIds }: Record<string, any>) => {
      try {
        const api: any = (window as any).api.chatDb
        const ensured = await api.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
        const pasted = await api.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste ${JSON.stringify(pasted)}` }
        const upserted = await api.upsertSegment({ segmentId, topicId, name: segmentName, messageIds: memberIds })
        if (!upserted || upserted.ok !== true) return { ok: false, err: `upsertSegment ${JSON.stringify(upserted)}` }
        return { ok: true, wire: upserted.value }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId, name, entries, segmentId, segmentName, memberIds }
  )
  expect(persisted.ok, `seed failed: ${(persisted as any).err}`).toBe(true)
  // Unfolded by default: the wire carries no folded property at all.
  expect((persisted as any).wire?.folded).toBeUndefined()
  expect((persisted as any).wire?.messageCount).toBe(memberIds.length)
  return memberIds
}

/**
 * Activates the topic and waits for its bootstrap to land.
 *
 * Two independent expectations, because loaded authority rows and MOUNTED DOM
 * rows are not the same number once a group is folded:
 *  - `expectedMessageIds` — the route's message-id list in the store (authority
 *    rows loaded, so `SEED_MESSAGES` even while folded);
 *  - `mountedRows` — `#messages [data-message-id]` nodes actually in the flow.
 *    It defaults to `expectedMessageIds`, which is right for an unfolded topic.
 *    A topic whose group is folded must pass `MOUNTED_ROWS_WHILE_FOLDED`:
 *    the folded rows never enter the mounted flow, so waiting for the full row
 *    count can never be satisfied and would only burn the timeout.
 */
async function activateTopicAndWaitForBootstrap(
  page: any,
  topicId: string,
  expectedMessageIds: number,
  mountedRows: number = expectedMessageIds
): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()
  await page.waitForFunction(
    ({ topicId, expected }: { topicId: string; expected: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      return Array.isArray(ids) && ids.length >= expected && s.messages?.loadingByTopic?.[topicId] !== true
    },
    { topicId, expected: expectedMessageIds },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (expected: number) => document.querySelectorAll('#messages [data-message-id]').length >= expected,
    mountedRows,
    { timeout: 30000 }
  )
}

// ---------------------------------------------------------------------------
// Chrome / request / count readers
// ---------------------------------------------------------------------------

interface SegmentChrome {
  folded: boolean
  hasRule: boolean
  hasFoldTarget: boolean
  hasExpandTarget: boolean
  expandTitle: string | null
  labelText: string
  countText: string | null
  hasActions: boolean
  ruleVisible: boolean
}

async function readSegmentChrome(page: any, segmentId: string): Promise<SegmentChrome> {
  return page.evaluate((segmentId: string) => {
    const host = document.querySelector(
      `#messages [data-testid="topic-segment-line"][data-segment-id="${segmentId}"]`
    ) as HTMLElement | null
    const label = host?.querySelector('[data-testid="topic-segment-label"]') as HTMLElement | null
    const expand = host?.querySelector('[data-testid="topic-segment-expand"]') as HTMLElement | null
    const rule = host?.querySelector('[data-testid="topic-segment-rule"]') as HTMLElement | null
    return {
      folded: host?.getAttribute('data-segment-folded') === 'true',
      hasRule: !!rule,
      hasFoldTarget: !!host?.querySelector('[data-testid="topic-segment-fold"]'),
      hasExpandTarget: !!expand,
      expandTitle: expand?.getAttribute('title') ?? null,
      labelText: label?.textContent ?? '',
      countText:
        (host?.querySelector('[data-testid="topic-segment-count"]') as HTMLElement | null)?.textContent ?? null,
      hasActions: !!host?.querySelector('[data-testid="topic-segment-actions"]'),
      ruleVisible: !!rule && (rule as HTMLElement).getBoundingClientRect().height > 0
    }
  }, segmentId)
}

async function settleTwoFrames(page: any): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
}

/**
 * Fold/expand motion is presentation-only: the authority flag flips immediately
 * and the body clip animation settles ~200ms later. Geometry/flow assertions
 * describe the settled DOM, so wait for the motion phase to disappear (never a
 * timer) before measuring. Two checks make a motion that starts on the same
 * frame as the first read impossible to miss, and the no-motion case
 * (reduced motion / no animation API) passes straight through.
 */
async function settleFoldMotion(page: any, timeoutMs = 15000): Promise<void> {
  const noPhase = () => !document.querySelector('#messages [data-segment-fold-phase]')
  await page.waitForFunction(noPhase, undefined, { timeout: timeoutMs })
  await settleTwoFrames(page)
  await page.waitForFunction(noPhase, undefined, { timeout: timeoutMs })
  await settleTwoFrames(page)
}

async function readRect(page: any, selector: string) {
  return page.evaluate((selector: string) => {
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, height: r.height }
  }, selector)
}

/**
 * Tail-cycle probe: is this group's label AND its left-rule fold target inside
 * the `#messages` box, i.e. really clickable without Playwright auto-scrolling the
 * target into view (which would silently move the viewport and invalidate the tail
 * claim)? `deltaY` is the next bounded, proportional wheel step toward that state
 * (column-reverse: raising `scrollTop` moves content up, so a chrome sitting below
 * the box needs a positive delta). Geometry is returned either way so a failure can
 * report why.
 */
async function readTailChrome(
  page: any,
  segmentId: string
): Promise<{
  ready: boolean
  deltaY: number
  labelTop: number | null
  labelBottom: number | null
  foldTop: number | null
  foldBottom: number | null
}> {
  return page.evaluate((segmentId: string) => {
    const empty = { ready: false, deltaY: -120, labelTop: null, labelBottom: null, foldTop: null, foldBottom: null }
    const container = document.getElementById('messages') as HTMLElement | null
    if (!container) return empty
    const host = document.querySelector(
      `#messages [data-testid="topic-segment-line"][data-segment-id="${segmentId}"]`
    ) as HTMLElement | null
    const label = host?.querySelector('[data-testid="topic-segment-label"]') as HTMLElement | null
    const fold = host?.querySelector('[data-testid="topic-segment-fold"]') as HTMLElement | null
    if (!label || !fold) return empty
    const c = container.getBoundingClientRect()
    const l = label.getBoundingClientRect()
    const f = fold.getBoundingClientRect()
    const ready = l.top >= c.top + 4 && l.bottom <= c.bottom - 2 && f.top >= c.top && f.bottom <= c.bottom
    let deltaY = 0
    if (!ready) {
      const targetTop = Math.min(l.top, f.top)
      const targetBottom = Math.max(l.bottom, f.bottom)
      const below = targetTop > c.bottom - 8
      const distance = below ? targetTop - (c.bottom - 8) : c.top + 8 - targetBottom
      const magnitude = Math.min(240, Math.max(48, Math.round(Math.abs(distance) * 0.6)))
      deltaY = below ? magnitude : -magnitude
    }
    return { ready, deltaY, labelTop: l.top, labelBottom: l.bottom, foldTop: f.top, foldBottom: f.bottom }
  }, segmentId)
}
async function mountedMessageIds(page: any): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#messages [data-message-id]')).map((el) => el.getAttribute('data-message-id'))
  )
}

/**
 * The authority message count carried by the rendered count label.
 *
 * The label text is the production i18n string (`topicSegment.messages.count`:
 * en-US renders `{{count}} message(s)`), so a bare `toBe('2')` assertion would
 * pin the wording and break on locale/format changes. The contract under test is
 * the AUTHORITY number, not the sentence: extract the digits and compare
 * numerically (`null` when the label or number is missing, which fails the
 * numeric assertion instead of passing silently).
 */
function parseAuthorityCount(text: string | null): number | null {
  const match = (text ?? '').match(/[0-9]+/)
  return match ? Number(match[0]) : null
}
interface ScrollReading {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

type RowRect = { top: number; bottom: number; height: number } | null

/**
 * Raw `#messages` scroll coordinates. This viewport renders `column-reverse`
 * (newest at `scrollTop ≈ 0`, older content toward negative `scrollTop`), the
 * production convention documented in
 * `src/renderer/src/pages/home/Messages/columnReverseGeometry.ts:4-16`. This
 * spec only RECORDS these numbers: it never asserts a
 * `scrollHeight - scrollTop - clientHeight` "bottom / max scroll" boolean,
 * which is simply wrong under column-reverse.
 */
async function readScroll(page: any): Promise<ScrollReading> {
  return page.evaluate(() => {
    const el = document.getElementById('messages') as HTMLElement | null
    if (!el) throw new Error('#messages not found')
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  })
}

/** Production `distanceFromBottom` (column-reverse): `abs(scrollTop)`. */
function distanceFromBottom(scroll: ScrollReading): number {
  return Math.abs(scroll.scrollTop)
}

/** Production `distanceFromOldest` (column-reverse). */
function distanceFromOldest(scroll: ScrollReading): number {
  return Math.max(0, scroll.scrollHeight - scroll.clientHeight - Math.abs(scroll.scrollTop))
}

async function readRects(page: any, selectors: string[]): Promise<RowRect[]> {
  return page.evaluate((selectors: string[]) => {
    return selectors.map((selector) => {
      const el = document.querySelector(selector) as HTMLElement | null
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, height: r.height }
    })
  }, selectors)
}

/** Wait until every observed rect stops moving (rAF + short settle, ≤3s). */
async function settleRects(page: any, selectors: string[], tolerance = 1, timeoutMs = 3000): Promise<RowRect[]> {
  let previous = await readRects(page, selectors)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await settleTwoFrames(page)
    await page.waitForTimeout(120)
    const current = await readRects(page, selectors)
    const stable = current.every((cur, i) => {
      const prev = previous[i]
      if (!cur || !prev) return cur === prev
      return Math.abs(cur.top - prev.top) <= tolerance && Math.abs(cur.bottom - prev.bottom) <= tolerance
    })
    previous = current
    if (stable) return current
  }
  return previous
}

/**
 * Focus the messages viewport so wheel events land on the scroll container.
 *
 * A wheel event is dispatched at the current pointer position, so without this
 * move it can land on the sidebar and the `#messages` viewport never scrolls.
 * This mirrors the established helpers in
 * `conversation/chat-scroll-intent.spec.ts:458-462` and
 * `conversation/top-visible-incremental-rebase.spec.ts:1018-1030`.
 */
async function focusMessagesViewport(page: any): Promise<void> {
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

/** One real wheel gesture on the focused viewport, then settle. Never a scrollTop write. */
async function wheelMessagesViewport(page: any, deltaY: number): Promise<void> {
  await focusMessagesViewport(page)
  await page.mouse.wheel(0, deltaY)
  await settleTwoFrames(page)
  await page.waitForTimeout(180)
}

/**
 * Bring one chrome node fully inside the `#messages` scrollport with REAL wheel
 * gestures, and report where it ended up.
 *
 * Playwright's own `hover()`/`scrollIntoViewIfNeeded` and JS `scrollIntoView`
 * mis-scroll this column-reverse viewport, so a pointer hover on an unrevealed
 * chrome node lands outside the window (on the toolbar) and proves nothing. A
 * wheel gesture over the container is the only movement this test may cause,
 * and it is bounded per step so it converges instead of bouncing.
 *
 * Direction follows the column-reverse convention used everywhere in this spec:
 * a NEGATIVE `deltaY` walks toward older content and pushes content DOWN, a
 * positive one pushes it UP. Returns the last observed state on honest failure.
 */
async function revealChromeInViewport(
  page: any,
  selector: string,
  timeoutMs = 12000
): Promise<{ inside: boolean; rect: { top: number; bottom: number }; box: { top: number; bottom: number } } | null> {
  const EDGE = 6
  const start = Date.now()
  let last: { inside: boolean; rect: { top: number; bottom: number }; box: { top: number; bottom: number } } | null =
    null
  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate(
      ({ selector, edge }: { selector: string; edge: number }) => {
        const container = document.getElementById('messages') as HTMLElement | null
        const el = document.querySelector(selector) as HTMLElement | null
        if (!container || !el) return null
        const c = container.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        const rect = { top: r.top, bottom: r.bottom }
        const box = { top: c.top, bottom: c.bottom }
        const inside = r.top >= c.top + edge && r.bottom <= c.bottom - edge
        const need = r.top < c.top + edge ? -(c.top + edge - r.top) : r.bottom - (c.bottom - edge)
        const deltaY = inside ? 0 : Math.sign(need) * Math.max(48, Math.min(220, Math.round(Math.abs(need))))
        return { inside, rect, box, deltaY }
      },
      { selector, edge: EDGE }
    )
    if (!state) return null
    last = state
    if (state.inside) return last
    await wheelMessagesViewport(page, state.deltaY)
  }
  return last
}

/**
 * Place the target group in an unambiguous NON-tail viewport position: the
 * group header sits near the top of the viewport with a wide band of content
 * below it inside the scroll container, so the fold's height delta lands on that
 * content instead of being absorbed by a natural scroll clamp.
 *
 * Two conditions must hold TOGETHER, and only both of them make the anchoring
 * law testable:
 *  - the header is fully inside the container with at least 150px of content
 *    below it (the row above the group stays mounted and visible);
 *  - the container has at least the folded group's own flow height of room
 *    toward the newest edge (`|scrollTop| >= groupExtent`). The compensation
 *    holds the header by moving `scrollTop` toward `0` by exactly the removed
 *    group height, so a placement with less room than that height leaves a
 *    residual of `groupExtent - |scrollTop|` — an honest clamp, not a
 *    compensation failure. "More than 100px of room" is therefore NOT a
 *    non-tail placement for a group taller than 100px: the requirement has to
 *    be measured from the group's own rows below.
 *
 * Movement is a REAL wheel gesture over `#messages` (no `scrollTop` write, no
 * `scrollToBottom` dispatch, no `scrollIntoView`). Under this column-reverse
 * viewport (`src/renderer/src/pages/home/Messages/columnReverseGeometry.ts:4-11`)
 * a NEGATIVE `deltaY` moves toward older content, which pushes content DOWN
 * (raising `scrollTop` moves content up).
 *
 * Two properties of the seek matter:
 *  - every wheel is preceded by `focusMessagesViewport`, so the gesture targets
 *    the scroll container rather than whatever sits under a stale pointer;
 *  - the step is proportional to the remaining distance AND bounded by a third
 *    of a narrow governor band (top ~22% of the container): a fixed ±420px kick
 *    overshoots and bounces instead of converging.
 *
 * Honest failure: the prompt ends with the last observed state (geometry + both
 * scroll distances), never from a silently wrong position. Two consecutive
 * wheels that move `scrollTop` by less than 2px mean the container simply cannot
 * travel far enough for a non-tail placement (too little content) — that is a
 * fixture-shape problem whose remedy is seed content, never a forced offset. The
 * same holds for a fixture whose content below the newest edge cannot reach the
 * group's own height: the band cannot host the fold delta, so the placement
 * fails loudly with the measured numbers instead of quietly producing a clamp.
 */
async function placeGroupAtNonTailViewport(
  page: any,
  segmentId: string,
  groupMembers: string[]
): Promise<{
  headerTop: number
  headerBottom: number
  belowBandPx: number
  groupExtentPx: number
  requiredRoomPx: number
  scroll: ScrollReading
}> {
  type PlacementState = {
    ok: boolean
    deltaY: number
    headerTop: number | null
    headerBottom: number | null
    belowBandPx: number
    groupExtentPx: number
    requiredRoomPx: number
    maxRoomPx: number
    memberRowsMounted: number
    memberRowsExpected: number
    scroll: ScrollReading
    band: { top: number; bottom: number; height: number }
  }
  const ROOM_MARGIN = 8
  const probe = () =>
    page.evaluate(
      ({ segmentId, groupMembers, roomMargin }: { segmentId: string; groupMembers: string[]; roomMargin: number }) => {
        const container = document.getElementById('messages') as HTMLElement | null
        if (!container) return null
        const host = document.querySelector(
          `#messages [data-testid="topic-segment-line"][data-segment-id="${segmentId}"]`
        ) as HTMLElement | null
        const label = host?.querySelector('[data-testid="topic-segment-label"]') as HTMLElement | null
        const c = container.getBoundingClientRect()
        const scroll = {
          scrollTop: container.scrollTop,
          scrollHeight: container.scrollHeight,
          clientHeight: container.clientHeight
        }
        const band = {
          top: c.top + 8,
          bottom: c.top + c.height * 0.22,
          height: Math.max(1, c.height * 0.22 - 8)
        }
        const backwardStep = -Math.max(48, Math.round(band.height / 3))
        // The folded body height IS the removal: measure the group's own mounted
        // rows (topmost top → bottommost bottom) so the required room is the real
        // height that will leave the flow, never a guessed constant.
        let extentTop = Number.POSITIVE_INFINITY
        let extentBottom = Number.NEGATIVE_INFINITY
        let memberRowsMounted = 0
        for (const id of groupMembers) {
          const row = document.querySelector(`#messages [data-message-id="${id}"]`) as HTMLElement | null
          if (!row) continue
          const r = row.getBoundingClientRect()
          memberRowsMounted += 1
          if (r.top < extentTop) extentTop = r.top
          if (r.bottom > extentBottom) extentBottom = r.bottom
        }
        const groupExtentPx = memberRowsMounted > 0 ? Math.max(0, extentBottom - extentTop) : 0
        const requiredRoomPx = memberRowsMounted === groupMembers.length ? groupExtentPx + roomMargin : 0
        if (!label) {
          // Chrome not painted yet — seek toward older content by one bounded step.
          return {
            ok: false,
            deltaY: backwardStep,
            headerTop: null,
            headerBottom: null,
            belowBandPx: 0,
            groupExtentPx,
            requiredRoomPx,
            maxRoomPx: 0,
            memberRowsMounted,
            memberRowsExpected: groupMembers.length,
            scroll,
            band
          }
        }
        const l = label.getBoundingClientRect()
        const belowBandPx = c.bottom - l.bottom
        // Acceptance is the SAME contract the assertions below enforce, plus the
        // room the compensation write needs: the header is fully inside the
        // container with at least 150px of content below it, and the container has
        // at least the folded group's own height of room toward the newest edge.
        const topMin = c.top + 8
        const belowFloor = 150
        const headerInside = l.top >= topMin && l.bottom <= c.bottom - belowFloor
        const awayFromNewestEdge = Math.abs(scroll.scrollTop) > 100
        const roomPx = Math.abs(scroll.scrollTop)
        const roomOk = requiredRoomPx > 0 && roomPx >= requiredRoomPx
        const membersOk = memberRowsMounted === groupMembers.length && groupMembers.length > 0
        const ok = headerInside && awayFromNewestEdge && roomOk && membersOk && belowBandPx >= belowFloor
        // Room is bought by moving the header DOWN: each pixel down adds a pixel of
        // room toward the newest edge. Buy exactly the missing amount, bounded by
        // the lowest position that still keeps 150px of content below the header —
        // past that the fixture cannot host the fold delta and the seek says so.
        const maxHeaderTop = c.bottom - belowFloor - l.height
        const maxRoomPx = roomPx + Math.max(0, maxHeaderTop - l.top)
        const neededDrop = Math.max(0, requiredRoomPx - roomPx)
        const targetTop = Math.min(maxHeaderTop, Math.max(topMin, l.top + neededDrop))
        // Converging step: move a fraction of the remaining distance, never more
        // than a third of the seek governor (so one wheel cannot jump across the
        // accepted range).
        const remaining = targetTop - l.top // > 0 → header must move DOWN → wheel toward older
        const stepPx = Math.min(
          Math.max(48, Math.round(band.height / 3)),
          Math.max(24, Math.round(Math.abs(remaining) * 0.6))
        )
        const deltaY = remaining >= 0 ? -stepPx : stepPx
        return {
          ok,
          deltaY,
          headerTop: l.top,
          headerBottom: l.bottom,
          belowBandPx,
          groupExtentPx,
          requiredRoomPx,
          maxRoomPx,
          memberRowsMounted,
          memberRowsExpected: groupMembers.length,
          scroll,
          band
        }
      },
      { segmentId, groupMembers, roomMargin: ROOM_MARGIN }
    )
  let lastState: PlacementState | null = null
  let lastScrollTop: number | null = null
  let stalled = 0
  for (let step = 0; step < 40; step++) {
    const state = (await probe()) as PlacementState | null
    if (!state) throw new Error('#messages container unavailable')
    lastState = state
    if (state.ok && state.headerTop !== null && state.headerBottom !== null) {
      return {
        headerTop: state.headerTop,
        headerBottom: state.headerBottom,
        belowBandPx: state.belowBandPx,
        groupExtentPx: state.groupExtentPx,
        requiredRoomPx: state.requiredRoomPx,
        scroll: state.scroll
      }
    }
    // Once the header has reached the lowest position that still keeps 150px of
    // content below it and the room still falls short of the group's own height,
    // no wheel can fix it — the fixture cannot host the fold delta, so the seek
    // says so with the measured numbers instead of drifting or faking a hold.
    if (
      state.requiredRoomPx > 0 &&
      state.memberRowsMounted === state.memberRowsExpected &&
      state.maxRoomPx + 1 < state.requiredRoomPx
    ) {
      throw new Error(
        `group ${segmentId} cannot be placed with enough room below the newest edge for its own height (${JSON.stringify(
          {
            requiredRoomPx: Math.round(state.requiredRoomPx),
            maxRoomPx: Math.round(state.maxRoomPx),
            scrollTop: state.scroll.scrollTop,
            headerTop: state.headerTop
          }
        )})`
      )
    }
    stalled = lastScrollTop !== null && Math.abs(state.scroll.scrollTop - lastScrollTop) < 2 ? stalled + 1 : 0
    if (stalled >= 2) {
      throw new Error(
        `group ${segmentId} cannot be placed at a non-tail viewport position: the viewport stopped traveling (last=${JSON.stringify(state)})`
      )
    }
    lastScrollTop = state.scroll.scrollTop
    await wheelMessagesViewport(page, state.deltaY)
  }
  throw new Error(
    `failed to place group ${segmentId} at a non-tail viewport position (last=${JSON.stringify(lastState)})`
  )
}

async function getPersistedAnchorGroupKey(page: any, topicId: string): Promise<string | null> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const anchor = s.assistants.assistants[0]?.settings?.contextWindowAnchor?.[topicId]
    return anchor?.kind === 'active' ? anchor.groupKey : null
  }, topicId)
}

/** Ordered user text contents of a real product request (§6 request log). */
function getRequestUserPrompts(productReq: { parsed: Record<string, unknown> | null } | null): string[] {
  const messages = productReq?.parsed?.messages
  if (!Array.isArray(messages)) return []
  return messages
    .filter((m) => (m as { role?: string })?.role === 'user')
    .map((m) => {
      const content = (m as { content?: unknown })?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content
          .filter((part) => typeof (part as { text?: unknown })?.text === 'string')
          .map((part) => (part as { text: string }).text)
          .join('')
      }
      return ''
    })
    .filter((text) => text.length > 0)
}

/** Assistant-role text contents of a real product request. */
function getRequestAssistantTexts(productReq: { parsed: Record<string, unknown> | null } | null): string[] {
  const messages = productReq?.parsed?.messages
  if (!Array.isArray(messages)) return []
  return messages
    .filter((m) => (m as { role?: string })?.role === 'assistant')
    .map((m) => {
      const content = (m as { content?: unknown })?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content
          .filter((part) => typeof (part as { text?: unknown })?.text === 'string')
          .map((part) => (part as { text: string }).text)
          .join('')
      }
      return ''
    })
}

async function uiSendMessage(page: any, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.fill(text)
  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
}

async function waitForAssistantResponseComplete(
  page: any,
  topicId: string,
  previousAssistantCount: number,
  timeout = 60000
): Promise<number> {
  await page.waitForFunction(
    ({ topicId, prevCount }: { topicId: string; prevCount: number }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
      let count = 0
      for (const id of msgIds) if (s.messages.entities?.[id]?.role === 'assistant') count++
      return count > prevCount
    },
    { topicId, prevCount: previousAssistantCount },
    { timeout }
  )
  await page.waitForFunction(
    ({ topicId }: { topicId: string }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      if (s.messages?.loadingByTopic?.[topicId]) return false
      const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
      let latestAssistantId: string | null = null
      for (let i = msgIds.length - 1; i >= 0; i--) {
        if (s.messages.entities?.[msgIds[i]]?.role === 'assistant') {
          latestAssistantId = msgIds[i]
          break
        }
      }
      if (!latestAssistantId) return false
      const assistantMsg = s.messages.entities[latestAssistantId]
      if (!['success', 'error'].includes(assistantMsg.status)) return false
      const blocks = assistantMsg.blocks || []
      if (blocks.length === 0) return false
      for (const blockId of blocks) {
        const block = s.messageBlocks?.entities?.[blockId]
        if (!block || !['success', 'error'].includes(block.status)) return false
      }
      return true
    },
    { topicId },
    { timeout }
  )
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages.messageIdsByTopic[topicId] || []
    let count = 0
    for (const id of msgIds) if (s.messages.entities[id]?.role === 'assistant') count++
    return count
  }, topicId)
}

async function countAssistants(page: any, topicId: string): Promise<number> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages.messageIdsByTopic[topicId] || []
    return msgIds.filter((id: string) => s.messages.entities[id]?.role === 'assistant').length
  }, topicId)
}

/** The TokenCount context block shows exactly `current/max`. */
async function expectTokenCount(page: any, current: number, max: number, timeout = 15000): Promise<void> {
  await expect(page.locator('[data-testid="token-count-context"]')).toHaveText(
    new RegExp(`^\\s*${current}\\s*\\/\\s*${max}\\s*$`),
    { timeout }
  )
}

function segmentHostSelector(segmentId: string): string {
  return `#messages [data-testid="topic-segment-line"][data-segment-id="${segmentId}"]`
}

test.describe('Topic segment fold — participating context', () => {
  test('fold removes the group from the real request, counts and token estimation, and expand restores it in place', async ({
    mainWindow
  }) => {
    test.setTimeout(300000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED fold participation: seeded content (ensureTopic/pasteMessagesToTopic/upsertSegment) + real left-rule fold click → real send → mock request log shows the folded user+assistant rows absent while the rest keep chronological order; token-count-context reports participating turns; no boundary divider; anchor group key unchanged; real expand click → next real request carries the restored rows at their original position with counts back to full. Counts/token come from the rendered block; requests from the provider log.'
    })

    const page = mainWindow
    const assistantId = await prepareDisplayCountAndAssistant(page)
    await seedContextCount(page, CONTEXT_COUNT, assistantId)
    const topicId = `segfold-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const segmentId = `${topicId}-seg`
    const segmentName = 'Fold Participation Group'
    console.log(`[E2E][SegmentFold] seeding topic ${topicId}`)

    const foldedMembers = await seedFoldedCandidateTopic(page, assistantId, topicId, segmentId, segmentName)
    const foldedUser = userText(FOLD_TURN)
    const foldedAssistant = assistantText(FOLD_TURN)

    await activateTopicAndWaitForBootstrap(page, topicId, SEED_TURNS * 2)

    // Production joint publication: the authority catalog (not a loaded guess)
    // carries the group and its authoritative membership size.
    await page.waitForFunction(
      ({ topicId, segmentId }: { topicId: string; segmentId: string }) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.topicSegments?.segmentsByTopic?.[topicId] ?? []
        const entity = s.topicSegments?.segments?.entities?.[segmentId]
        return ids.includes(segmentId) && entity?.messageCount === 2 && entity?.folded === undefined
      },
      { topicId, segmentId },
      { timeout: 30000 }
    )

    const host = page.locator(segmentHostSelector(segmentId))
    await expect(host, 'segment chrome must render for the seeded group').toBeVisible({ timeout: 15000 })
    // Exactly one chrome host per group: a group split across runs (a divider,
    // a differing turn id, or windowed membership) must not paint a second
    // `topic-segment-line` host, a second label or a second fold write target.
    // A duplicate host breaks the strict-mode gesture locators below.
    await expect(host).toHaveCount(1)
    // One label per group (a divider-split or multi-run group must not duplicate
    // the header). Only one group exists in this topic.
    await expect(page.locator('#messages [data-testid="topic-segment-label"]')).toHaveCount(1)

    const expanded: SegmentChrome = await readSegmentChrome(page, segmentId)
    expect(expanded.folded).toBe(false)
    expect(expanded.hasRule, 'expanded state paints the left rule').toBe(true)
    expect(expanded.hasFoldTarget, 'expanded state exposes the left-rule fold hit target').toBe(true)
    expect(expanded.hasExpandTarget, 'expanded state is not an expand target').toBe(false)
    expect(expanded.hasActions, 'expanded state keeps hover rename/dissolve actions').toBe(true)
    expect(expanded.labelText).toContain(segmentName)

    // ── Left-rule hover affordance: brightness only, no color surface ───────
    // The 8px transparent click target over the rule may only BRIGHTEN the rule
    // on hover. The previous feedback (an 8px color-mix band + glow around the
    // target) is what this asserts against: no background, no shadow, no glow,
    // no saturation shift, the target keeps its transparent 8px size, and
    // hovering moves no message control.
    const foldTargetSelector = `${segmentHostSelector(segmentId)} [data-testid="topic-segment-fold"]`
    const foldTarget = page.locator(foldTargetSelector)
    const ruleLocator = page.locator(`${segmentHostSelector(segmentId)} [data-testid="topic-segment-rule"]`)
    const turnAboveMenubarSelector = `#messages [data-message-id="${msgId(topicId, turnIndices(FOLD_TURN - 1).assistant)}"] .message-action-button`
    const idleRuleFilter = await ruleLocator.evaluate((el) => window.getComputedStyle(el as HTMLElement).filter)
    // Bring the rule inside the scrollport before sampling a real pointer hover:
    // the fold chrome sits at the group seam, which start off-screen in this
    // tall seeded topic. Playwright's own scroll-into-view mis-scrolls the
    // column-reverse host, so the reveal is a real bounded wheel gesture and the
    // pointer is only moved once the target is inside the container box.
    const reveal = await revealChromeInViewport(page, foldTargetSelector)
    expect(reveal?.inside, 'the fold chrome could be revealed inside the messages scrollport').toBe(true)
    await page.waitForTimeout(60)
    const menubarBeforeHover = await page.evaluate((selector: string) => {
      const node = document.querySelector(selector) as HTMLElement | null
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { top: rect.top, left: rect.left, height: rect.height, width: rect.width }
    }, turnAboveMenubarSelector)
    // The rule's hover feedback must reach the rule itself. Both the hover state
    // and its short brightness transition are asynchronous relative to the
    // pointer move (and the click boundary may still be settling the scroll),
    // so drive the pointer onto the target's live center and poll for the
    // observed end state instead of sampling one frame.
    let hoverState: { targetHover: boolean; ruleFilter: string } | null = null
    for (let attempt = 0; attempt < 8; attempt++) {
      const point = await foldTarget.evaluate((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 40) }
      })
      await page.mouse.move(point.x, point.y)
      await page.waitForTimeout(40)
      hoverState = await page.evaluate((id: string) => {
        const host = document.querySelector(
          `#messages [data-testid="topic-segment-line"][data-segment-id="${id}"]`
        ) as HTMLElement | null
        const target = host?.querySelector('[data-testid="topic-segment-fold"]') as HTMLElement | null
        const rule = host?.querySelector('[data-testid="topic-segment-rule"]') as HTMLElement | null
        return {
          targetHover: target ? target.matches(':hover') : false,
          ruleFilter: rule ? window.getComputedStyle(rule).filter : ''
        }
      }, segmentId)
      if (hoverState.targetHover && hoverState.ruleFilter.includes('brightness')) break
    }
    expect(hoverState?.targetHover, 'the 8px gutter target must own the hover').toBe(true)
    expect(hoverState?.ruleFilter, 'hover brightens the rule itself').toContain('brightness')
    await settleTwoFrames(page)
    const hoverChrome = await page.evaluate(
      ({ segmentId, menubarSelector }: { segmentId: string; menubarSelector: string }) => {
        const host = document.querySelector(
          `#messages [data-testid="topic-segment-line"][data-segment-id="${segmentId}"]`
        ) as HTMLElement | null
        const target = host?.querySelector('[data-testid="topic-segment-fold"]') as HTMLElement | null
        const rule = host?.querySelector('[data-testid="topic-segment-rule"]') as HTMLElement | null
        const menubar = document.querySelector(menubarSelector) as HTMLElement | null
        if (!target || !rule) return null
        const targetStyle = window.getComputedStyle(target)
        const ruleStyle = window.getComputedStyle(rule)
        const targetRect = target.getBoundingClientRect()
        const ruleRect = rule.getBoundingClientRect()
        const menubarRect = menubar?.getBoundingClientRect() ?? null
        return {
          targetBackground: targetStyle.backgroundColor,
          targetBackgroundImage: targetStyle.backgroundImage,
          targetBoxShadow: targetStyle.boxShadow,
          targetWidth: targetRect.width,
          targetHeight: targetRect.height,
          ruleFilter: ruleStyle.filter,
          ruleSaturationFree: !ruleStyle.filter.includes('saturate'),
          ruleRect: { top: ruleRect.top, left: ruleRect.left, width: ruleRect.width },
          menubar: menubarRect ? { top: menubarRect.top, left: menubarRect.left } : null
        }
      },
      { segmentId, menubarSelector: turnAboveMenubarSelector }
    )
    expect(hoverChrome, 'hovered rule chrome must be readable').not.toBeNull()
    expect(hoverChrome!.targetBackground, 'the hover target paints no background band').toBe('rgba(0, 0, 0, 0)')
    expect(hoverChrome!.targetBackgroundImage, 'no gradient/glow layer on the hover target').toBe('none')
    expect(hoverChrome!.targetBoxShadow, 'no shadow on the hover target').toBe('none')
    expect(hoverChrome!.targetWidth, 'the transparent click target keeps its 8px width').toBeGreaterThanOrEqual(8)
    expect(hoverChrome!.targetWidth, 'the transparent click target stays a gutter target').toBeLessThanOrEqual(8.5)
    expect(hoverChrome!.targetHeight, 'the click target keeps a real height').toBeGreaterThan(20)
    expect(hoverChrome!.ruleFilter, 'hover brightens the rule itself').toContain('brightness')
    expect(hoverChrome!.ruleSaturationFree, 'hover never shifts the color system (no saturation change)').toBe(true)
    expect(hoverChrome!.ruleRect.width, 'the rule keeps its 4px width').toBeLessThanOrEqual(4.5)
    if (menubarBeforeHover && hoverChrome!.menubar) {
      expect(
        Math.abs(hoverChrome!.menubar.top - menubarBeforeHover.top),
        'hover moves no message control'
      ).toBeLessThanOrEqual(1)
      expect(Math.abs(hoverChrome!.menubar.left - menubarBeforeHover.left)).toBeLessThanOrEqual(1)
    }
    console.log(`[E2E][SegmentFold] rule hover affordance ${JSON.stringify({ idleRuleFilter, ...hoverChrome })}`)
    // Move the pointer away again so the gesture below starts from the idle chrome.
    await page.locator('#messages').hover({ position: { x: 40, y: 40 } })

    // Baseline of the turn model before folding: every seeded message is its own
    // turn (no seeded `askId`), and with `contextCount` 10 the default anchor
    // starts at the oldest turn, so all of them are selected.
    await expectTokenCount(page, SEED_MESSAGES, SEED_MESSAGES)
    // ── Step 1: real fold gesture on the left rule ──────────────────────────
    await page.locator(`${segmentHostSelector(segmentId)} [data-testid="topic-segment-fold"]`).click()
    await expect(host).toHaveAttribute('data-segment-folded', 'true', { timeout: 15000 })
    // The fold gesture applies the authority flag immediately and plays a
    // presentation-only clip animation; the settled DOM is the assertion target.
    await settleFoldMotion(page)

    const collapsed: SegmentChrome = await readSegmentChrome(page, segmentId)
    expect(collapsed.folded).toBe(true)
    expect(collapsed.hasRule, 'collapsed state has no left rule').toBe(false)
    expect(collapsed.ruleVisible).toBe(false)
    expect(collapsed.hasFoldTarget, 'collapsed state has no fold hit target').toBe(false)
    expect(collapsed.hasActions, 'collapsed state hides hover rename/dissolve actions').toBe(false)
    expect(collapsed.hasExpandTarget, 'collapsed state exposes exactly one expand target').toBe(true)
    // The group name stays persisted but hidden; only the hover hint carries it.
    expect(collapsed.labelText).not.toContain(segmentName)
    expect(collapsed.expandTitle, 'hover hint names the group and explains expanding').toContain(segmentName)
    // The authority message count stays visible next to the collapsed word.
    // Authority count, compared numerically (locale/format-agnostic; see
    // parseAuthorityCount).
    expect(parseAuthorityCount(collapsed.countText), 'collapsed label keeps the authority count').toBe(
      foldedMembers.length
    )

    // Folded rows leave the rendered flow without touching membership/window.
    const mountedAfterFold = await mountedMessageIds(page)
    for (const id of foldedMembers) expect(mountedAfterFold, `folded row ${id} must leave the flow`).not.toContain(id)
    expect(mountedAfterFold).toContain(msgId(topicId, turnIndices(FOLD_TURN - 1).assistant))
    expect(mountedAfterFold).toContain(msgId(topicId, turnIndices(FOLD_TURN + 1).user))

    // Counts and token estimation share the participating-turn definition.
    await expectTokenCount(page, TURNS_WHILE_FOLDED, TURNS_WHILE_FOLDED)
    await expect(page.locator('[data-testid="context-boundary"]')).toHaveCount(0)

    // ── Step 2: real request while folded ───────────────────────────────────
    const seqFolded = getRequestSequence()
    let assistantCount = await countAssistants(page, topicId)
    await uiSendMessage(page, 'fold request turn')
    assistantCount = await waitForAssistantResponseComplete(page, topicId, assistantCount)

    const foldedReq = findProductRequestAfter(seqFolded)
    expect(foldedReq, 'a real product request must reach the mock provider while folded').not.toBeNull()
    const foldedPrompts = getRequestUserPrompts(foldedReq)
    const expectedFoldedPrompts = [userText(1), userText(2), userText(4), userText(5), 'fold request turn']
    expect(foldedPrompts, 'request must exclude the folded group and keep chronological order').toEqual(
      expectedFoldedPrompts
    )
    expect(foldedPrompts).not.toContain(foldedUser)
    const foldedAssistantTexts = getRequestAssistantTexts(foldedReq)
    expect(foldedAssistantTexts, 'folded assistant body must not leak into the request').not.toContain(foldedAssistant)
    // Guards against the divergence class: no prompt was silently re-injected,
    // and the sent prompt is not the folded one.
    expect(foldedPrompts.filter((p) => p === foldedUser)).toHaveLength(0)

    // Counts/token and the window origin stay consistent after the folded send.
    // One real exchange = one turn (assistant links back with askId), so the
    // total is TURNS_WHILE_FOLDED + 1, not + 2.
    await expectTokenCount(page, TURNS_AFTER_FOLDED_SEND, TURNS_AFTER_FOLDED_SEND)
    await expect(page.locator('[data-testid="context-boundary"]')).toHaveCount(0)
    const firstUserId = msgId(topicId, turnIndices(1).user)
    expect(await getPersistedAnchorGroupKey(page, topicId), 'folded send must not move the anchor').toBe(firstUserId)

    // ── Step 3: real expand gesture restores participation ───────────────────
    await page.locator(`${segmentHostSelector(segmentId)} [data-testid="topic-segment-expand"]`).click()
    await expect(host).toHaveAttribute('data-segment-folded', 'false', { timeout: 15000 })
    await settleTwoFrames(page)
    const reExpanded: SegmentChrome = await readSegmentChrome(page, segmentId)
    expect(reExpanded.hasRule, 'expanded again paints the left rule').toBe(true)
    expect(reExpanded.hasFoldTarget, 'expanded again exposes the fold target').toBe(true)
    expect(reExpanded.hasExpandTarget).toBe(false)
    expect(reExpanded.labelText, 'the group name returns as the rename object').toContain(segmentName)
    expect(await mountedMessageIds(page)).toContain(foldedMembers[0])

    const seqExpanded = getRequestSequence()
    assistantCount = await countAssistants(page, topicId)
    await uiSendMessage(page, 'expand request turn')
    assistantCount = await waitForAssistantResponseComplete(page, topicId, assistantCount)

    const expandedReq = findProductRequestAfter(seqExpanded)
    expect(expandedReq, 'a real product request must reach the mock provider after expanding').not.toBeNull()
    const expandedPrompts = getRequestUserPrompts(expandedReq)
    expect(expandedPrompts, 'expanded group participates at its original position').toEqual([
      userText(1),
      userText(2),
      userText(3),
      userText(4),
      userText(5),
      'fold request turn',
      'expand request turn'
    ])
    expect(getRequestAssistantTexts(expandedReq)).toContain(foldedAssistant)
    // Expanded again: the folded turn's two seeded turns come back (+2) and the
    // expand send's single real exchange adds one more turn.
    await expectTokenCount(page, TURNS_AFTER_EXPAND_SEND, TURNS_AFTER_EXPAND_SEND)
    await expect(page.locator('[data-testid="context-boundary"]')).toHaveCount(0)
    expect(await getPersistedAnchorGroupKey(page, topicId), 'expanding must not move the anchor').toBe(firstUserId)
    expect(assistantCount).toBeGreaterThan(SEED_TURNS)
    console.log('[E2E][SegmentFold] fold exclusion + expand restore verified against the request log')
  })

  test('collapsed header keeps content above stationary in the flow, and the tail clamp stays honest', async ({
    mainWindow,
    electronApp,
    mockPort,
    ownedTmpRoot
  }) => {
    test.setTimeout(420000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED fold durability + geometry: seeded content + real wheel placement into a NON-TAIL viewport (group header in the upper band, newest row inside the container, ≥120px of content below the header) + real left-rule click folds the group; rAF-settled rects show the row above the group and the collapsed label keep their vertical position (≤1px) while the row below moves up by the folded height (the delta lands below, no artificial band); a second real tail cycle (expand → wheel to the newest edge → fold again with too little content below) asserts only the honest clamp: scrollHeight shrinks by the removed rows, no placeholder band, no forced scroll lock, header allowed to leave the viewport. Then a same-profile close/relaunch restores the folded flag from the authority catalog (data-segment-folded=true, expand target present, folded bodies absent) and the durable truth is read post-exit from topic_segments.extra.'
    })

    const page = mainWindow
    await waitForAppReady(page)
    const assistantId = await prepareDisplayCountAndAssistant(page)
    await seedContextCount(page, CONTEXT_COUNT, assistantId)
    const topicId = `segfoldgeo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const segmentId = `${topicId}-seg`
    const segmentName = 'Fold Geometry Group'

    const foldedMembers = await seedFoldedCandidateTopic(page, assistantId, topicId, segmentId, segmentName)
    await activateTopicAndWaitForBootstrap(page, topicId, SEED_TURNS * 2)
    await page.waitForFunction(
      ({ topicId, segmentId }: { topicId: string; segmentId: string }) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.topicSegments?.segmentsByTopic?.[topicId] ?? []
        return ids.includes(segmentId)
      },
      { topicId, segmentId },
      { timeout: 30000 }
    )

    const host = page.locator(segmentHostSelector(segmentId))
    await expect(host).toBeVisible({ timeout: 15000 })
    await settleTwoFrames(page)

    // ── Placement: a definite NON-TAIL viewport ──────────────────────────────
    // The anchoring law is only meaningful away from the tail: with content
    // below the group still inside the scroll container, the fold's height delta
    // lands on that content (header + everything above stay put). At the tail the
    // honest outcome is a natural clamp, asserted separately at the end.
    const placement = await placeGroupAtNonTailViewport(page, segmentId, foldedMembers)
    console.log(`[E2E][SegmentFold] non-tail placement ${JSON.stringify(placement)}`)

    const aboveId = msgId(topicId, turnIndices(FOLD_TURN - 1).assistant)
    const belowId = msgId(topicId, turnIndices(FOLD_TURN + 1).user)
    const labelSelector = `${segmentHostSelector(segmentId)} [data-testid="topic-segment-label"]`
    const geometrySelectors = [
      `#messages [data-message-id="${aboveId}"]`,
      `#messages [data-message-id="${belowId}"]`,
      labelSelector
    ]
    const [aboveBefore, belowBefore, labelBefore] = await settleRects(page, geometrySelectors)
    expect(aboveBefore, 'row above the group must be mounted').not.toBeNull()
    expect(belowBefore, 'row below the group must be mounted').not.toBeNull()
    // Precondition evidence: the placement really is non-tail (a wide band of
    // content below the header inside the container) and away from the newest
    // scroll edge, so the fold delta has room to land below instead of clamping.
    expect(placement.belowBandPx, 'non-tail placement keeps content below the header').toBeGreaterThanOrEqual(150)
    expect(distanceFromBottom(placement.scroll), 'non-tail placement is away from the newest edge').toBeGreaterThan(100)
    const scrollBeforeFold = await readScroll(page)

    // Collapsed chrome is out of flow: it contributes no row height of its own.
    const hostFlow = await host.evaluate((el) => {
      const cs = window.getComputedStyle(el as HTMLElement)
      return {
        position: cs.position,
        paddingTop: cs.paddingTop,
        paddingBottom: cs.paddingBottom,
        marginTop: cs.marginTop,
        marginBottom: cs.marginBottom,
        minHeight: cs.minHeight,
        height: (el as HTMLElement).getBoundingClientRect().height
      }
    })
    expect(hostFlow.position, 'chrome host is out of the message flow (absolute)').toBe('absolute')
    for (const value of [
      hostFlow.paddingTop,
      hostFlow.paddingBottom,
      hostFlow.marginTop,
      hostFlow.marginBottom,
      hostFlow.minHeight
    ]) {
      expect(['', '0px', 'auto', 'normal']).toContain(value)
    }
    // Expanded paints the rule inside the same host, so the flow height is the
    // group's own extent here; the zero contribution is asserted after folding.

    // ── Real fold gesture, non-tail geometry law ─────────────────────────────
    await page.locator(`${segmentHostSelector(segmentId)} [data-testid="topic-segment-fold"]`).click()
    await expect(host).toHaveAttribute('data-segment-folded', 'true', { timeout: 15000 })
    await settleFoldMotion(page)
    const hostFolded = await host.evaluate((el) => {
      const rect = (el as HTMLElement).getBoundingClientRect()
      return { height: rect.height, minHeight: window.getComputedStyle(el as HTMLElement).minHeight }
    })
    // Zero-height flow contribution at the seam: any painted pixels belong to
    // the absolutely positioned label, never to a placeholder band between
    // neighbouring messages.
    expect(hostFolded.height, 'collapsed chrome takes no flow height').toBe(0)
    expect(['', 'auto', 'normal', '0px']).toContain(hostFolded.minHeight)

    const [aboveAfter, belowAfter, labelAfter] = await settleRects(page, geometrySelectors)
    const scrollAfterFold = await readScroll(page)
    expect(aboveAfter, 'row above stays mounted').not.toBeNull()
    expect(belowAfter, 'row below stays mounted').not.toBeNull()
    expect(labelAfter, 'collapsed header must stay rendered at the seam').not.toBeNull()

    // The header (and everything above it) is the natural layout anchor: only
    // content below moves, by the folded body height.
    expect(
      Math.abs((aboveAfter as any).top - (aboveBefore as any).top),
      'content above the group stays put'
    ).toBeLessThanOrEqual(1)
    expect(Math.abs((labelAfter as any).top - (labelBefore as any).top), 'the header stays put').toBeLessThanOrEqual(1)
    expect(
      (belowBefore as any).top - (belowAfter as any).top,
      'content below absorbs the folded height (moves up)'
    ).toBeGreaterThan(20)
    expect((labelAfter as any).height, 'collapsed label keeps its pill height').toBeGreaterThan(0)
    expect((aboveAfter as any).height, 'the row above is untouched by the fold').toBe((aboveBefore as any).height)
    // No artificial band at the seam: the folded rows are simply gone, so the seam
    // gap between the neighbouring rows may only shrink, never grow.
    const seamGapBefore = (belowBefore as any).top - (aboveBefore as any).bottom
    const seamGapAfter = (belowAfter as any).top - (aboveAfter as any).bottom
    expect(seamGapAfter, 'no blank band is inserted between the neighbouring messages').toBeLessThanOrEqual(
      seamGapBefore
    )
    // And the scroll height shrank by the removed rows (real content left the flow).
    expect(
      scrollBeforeFold.scrollHeight - scrollAfterFold.scrollHeight,
      'the folded rows leave the scrollable content'
    ).toBeGreaterThanOrEqual(40)
    console.log(
      `[E2E][SegmentFold] non-tail fold geometry ${JSON.stringify({
        aboveTopDelta: (aboveAfter as any).top - (aboveBefore as any).top,
        labelTopDelta: (labelAfter as any).top - (labelBefore as any).top,
        belowTopDelta: (belowAfter as any).top - (belowBefore as any).top,
        seamGapBefore,
        seamGapAfter,
        placement: {
          headerTop: placement.headerTop,
          belowBandPx: placement.belowBandPx,
          scroll: placement.scroll
        },
        scrollAfter: scrollAfterFold,
        distanceFromBottom: distanceFromBottom(scrollAfterFold),
        distanceFromOldest: distanceFromOldest(scrollAfterFold)
      })}`
    )

    const mountedAfterFold = await mountedMessageIds(page)
    for (const id of foldedMembers) expect(mountedAfterFold, `folded row ${id} must leave the flow`).not.toContain(id)
    await expect(page.locator('#messages [data-testid="topic-segment-label"]')).toHaveCount(1)
    const collapsed: SegmentChrome = await readSegmentChrome(page, segmentId)
    expect(collapsed.hasActions, 'no hover rename/dissolve while folded').toBe(false)
    expect(collapsed.hasExpandTarget).toBe(true)
    expect(collapsed.expandTitle).toContain(segmentName)
    expect(parseAuthorityCount(collapsed.countText), 'authority count stays visible while folded').toBe(
      foldedMembers.length
    )

    // ── Tail clamp honesty (no artificial blank, no forced lock) ──────────────
    // Real second cycle: expand restores the rows, then the viewport is wheeled
    // to the newest/bottom edge and back only until the left rule is clickable at
    // the tail — now too little content sits below the group to absorb the fold.
    // The honest outcome is the container's own clamp: scrollHeight shrinks by
    // the removed rows and the header may leave the viewport. Nothing is padded
    // and no scroll position is forced.
    await page.locator(`${segmentHostSelector(segmentId)} [data-testid="topic-segment-expand"]`).click()
    await expect(host).toHaveAttribute('data-segment-folded', 'false', { timeout: 15000 })
    await settleFoldMotion(page)
    await settleTwoFrames(page)

    // Toward the newest/bottom edge (column-reverse: positive deltaY) with real
    // wheel gestures over the focused viewport.
    for (let i = 0; i < 25; i++) {
      if (distanceFromBottom(await readScroll(page)) <= 2) break
      await wheelMessagesViewport(page, 480)
    }
    const tailEdge = await readScroll(page)
    const reachedNewestEdge = distanceFromBottom(tailEdge) <= 2
    // Back toward older content only until the group's label + left rule are
    // genuinely clickable inside the viewport — as close to the newest edge as the
    // gesture allows, so too little content sits below the group to absorb the
    // fold. A click on an off-viewport target would auto-scroll it into view and
    // silently move the viewport, so this must be true BEFORE clicking.
    let tailReady = await readTailChrome(page, segmentId)
    let tailLastScrollTop: number | null = null
    let tailStalled = 0
    for (let i = 0; i < 25 && !tailReady.ready; i++) {
      const scrollNow = await readScroll(page)
      tailStalled =
        tailLastScrollTop !== null && Math.abs(scrollNow.scrollTop - tailLastScrollTop) < 2 ? tailStalled + 1 : 0
      if (tailStalled >= 2) break
      tailLastScrollTop = scrollNow.scrollTop
      await wheelMessagesViewport(page, tailReady.deltaY)
      tailReady = await readTailChrome(page, segmentId)
    }
    expect(
      tailReady.ready,
      `tail cycle must bring the group chrome into the viewport before folding (${JSON.stringify(tailReady)})`
    ).toBe(true)

    const tailBefore = await readScroll(page)
    const tailLabelBefore = await readRect(page, labelSelector)
    await page.locator(`${segmentHostSelector(segmentId)} [data-testid="topic-segment-fold"]`).click()
    await expect(host).toHaveAttribute('data-segment-folded', 'true', { timeout: 15000 })
    // The clip animation removes the body progressively; the clamp measurement
    // describes the settled DOM, so wait for the motion before reading geometry.
    await settleFoldMotion(page)
    const tailLabelAfter = (await settleRects(page, [labelSelector]))[0]
    const tailAfter = await readScroll(page)
    const tailHostHeight = await host.evaluate((el) => (el as HTMLElement).getBoundingClientRect().height)
    // Removing the rows must shrink the scrollable content by their height.
    expect(
      tailBefore.scrollHeight - tailAfter.scrollHeight,
      'tail fold shrinks the scroll height by the removed rows'
    ).toBeGreaterThanOrEqual(40)
    // No artificial band: the chrome host stays out of flow and no placeholder
    // element is mounted to hold a blank gap open.
    expect(tailHostHeight, 'collapsed chrome takes no flow height at the tail').toBe(0)
    await expect(page.locator('#messages [data-testid="folded-placeholder"]')).toHaveCount(0)
    await expect(page.locator('#messages [data-testid="folded-spacer"]')).toHaveCount(0)
    // The header is allowed to leave the viewport (a clamp is the honest outcome);
    // nothing forces a scroll position beyond the container's own legal range.
    const legalMinScrollTop = -(tailAfter.scrollHeight - tailAfter.clientHeight) - 1
    expect(tailAfter.scrollTop, 'no forced scroll offset below the newest edge').toBeLessThanOrEqual(1)
    expect(tailAfter.scrollTop, 'no forced scroll offset beyond the oldest edge').toBeGreaterThanOrEqual(
      legalMinScrollTop
    )
    console.log(
      `[E2E][SegmentFold] tail clamp ${JSON.stringify({
        tailEdge,
        reachedNewestEdge,
        tailReady,
        tailBefore,
        tailAfter,
        labelBefore: tailLabelBefore,
        labelAfter: tailLabelAfter,
        headerStayedInViewport:
          !!tailLabelAfter &&
          (tailLabelAfter as any).top >= 0 &&
          (tailLabelAfter as any).bottom <= tailAfter.clientHeight,
        distanceFromBottomAfter: distanceFromBottom(tailAfter),
        distanceFromOldestAfter: distanceFromOldest(tailAfter)
      })}`
    )

    // ── Same-profile relaunch: fold state comes back from the authority ───────
    const userDataDir = getUserDataDir()
    const chatDbPath = getChatDbPath()
    expect(chatDbPath).not.toBeNull()
    await electronApp.close()
    const relaunched = await relaunchSameProfile({ userDataDir, ownedTmpRoot, mockPort })
    try {
      const page2 = relaunched.page
      await waitForAppReady(page2)
      await page2.evaluate((limit: number) => {
        ;(window as any).store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
      }, DISPLAY_LIMIT)
      // The topic comes back FOLDED, so the route loads all seeded ids while the
      // flow mounts only the rows the fold leaves: waiting for `SEED_MESSAGES`
      // mounted rows would wait for rows that folded semantics never mount.
      await activateTopicAndWaitForBootstrap(page2, topicId, SEED_MESSAGES, MOUNTED_ROWS_WHILE_FOLDED)

      const host2 = page2.locator(segmentHostSelector(segmentId))
      // The chrome host itself is ZERO-FLOW by design once a group is folded:
      // `position: absolute` with a 0px bounding box (the collapse invariants
      // asserted above), so Playwright classifies it as hidden and a
      // `toBeVisible()` on the host can never pass — it would assert something
      // the folded design forbids. "The chrome came back after relaunch"
      // therefore means: the host is ATTACHED with `data-segment-folded="true"`,
      // and the folded UI that genuinely paints inside it — the expand target
      // and the collapsed label pill carrying the persisted authority count —
      // is visible.
      await host2.waitFor({ state: 'attached', timeout: 30000 })
      await expect(host2).toHaveAttribute('data-segment-folded', 'true', { timeout: 15000 })
      const expand2 = page2.locator(`${segmentHostSelector(segmentId)} [data-testid="topic-segment-expand"]`)
      await expect(expand2, 'the folded expand target must be visible after relaunch').toBeVisible({
        timeout: 15000
      })
      const label2 = page2.locator(`${segmentHostSelector(segmentId)} [data-testid="topic-segment-label"]`)
      await expect(label2, 'the collapsed label pill must be visible after relaunch').toBeVisible({
        timeout: 15000
      })
      const restored: SegmentChrome = await readSegmentChrome(page2, segmentId)
      expect(restored.folded, 'folded flag restored from the persisted catalog').toBe(true)
      expect(restored.hasRule).toBe(false)
      expect(restored.hasExpandTarget).toBe(true)
      expect(restored.expandTitle).toContain(segmentName)
      expect(parseAuthorityCount(restored.countText), 'authority count survives the relaunch').toBe(
        foldedMembers.length
      )
      expect(restored.labelText, 'group name stays hidden (persisted, shown in the hint)').not.toContain(segmentName)
      const mounted2 = await mountedMessageIds(page2)
      for (const id of foldedMembers)
        expect(mounted2, `folded row ${id} must stay hidden after relaunch`).not.toContain(id)
      await expect(page2.locator('#messages [data-testid="topic-segment-label"]')).toHaveCount(1)
    } finally {
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => relaunched.app.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      // Process-settle only (not a correctness gate).
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }

    // Durable truth: the folded flag lives in topic_segments.extra, membership
    // stays authoritative in topic_segment_messages (never derived from a
    // loaded window).
    const esc = (value: string) => value.replace(/'/g, "''")
    const rowResult = queryChatDbViaElectron(
      chatDbPath!,
      `SELECT id, name, extra FROM topic_segments WHERE id = '${esc(segmentId)}'`
    )
    expect(rowResult.ok, 'post-exit segment query must succeed').toBe(true)
    const rows = (rowResult as any).rows as Array<{ id: string; name: string; extra: string | null }>
    expect(rows.length, 'the folded group must persist across the relaunch cycle').toBe(1)
    expect(rows[0].name).toBe(segmentName)
    const extra = rows[0].extra ? JSON.parse(rows[0].extra) : {}
    expect(extra.folded, 'folded presentation state must be persisted as a boolean').toBe(true)
    const membersResult = queryChatDbViaElectron(
      chatDbPath!,
      `SELECT message_id FROM topic_segment_messages WHERE segment_id = '${esc(segmentId)}' ORDER BY sort_order`
    )
    expect(membersResult.ok).toBe(true)
    expect(((membersResult as any).rows as Array<{ message_id: string }>).map((r) => r.message_id)).toEqual(
      foldedMembers
    )
    console.log('[E2E][SegmentFold] relaunch + persisted folded flag verified')
  })

  /**
   * Route-tail label slot (the one place a folded group is NOT zero-flow).
   *
   * The collapsed label pill is out-of-flow chrome painted downward from the
   * group's seam. When that group ends the whole message flow, the seam IS the
   * scroll end, so the pill used to land in the scroll host's bottom padding and
   * get clipped (and could sit under the composer's Layers trigger). The
   * product rule is: the flow-terminal folded group keeps ONE minimal reserved
   * slot (pill height + a small safety gap) so the pill stays completely inside
   * the scrollport and clickable; every other folded group keeps the zero-flow
   * seam; consecutive terminal folds share that single slot and stay non-
   * overlapping through the existing horizontal cascade.
   */
  test('route-terminal fold keeps exactly one minimal label slot inside the scrollport', async ({ mainWindow }) => {
    test.setTimeout(300000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED route-tail label slot: seeded 5-turn topic with two segments (the flow-terminal group + its adjacent older group) + real left-rule fold clicks → exactly ONE reserved tail slot, both collapsed labels fully inside the #messages scrollport, the pill clearing the previous visible row, the composer and the Layers trigger, and the expand target word never covered by that trigger; real expand → the slot disappears with the returning body while the non-terminal group keeps its zero-flow seam.'
    })

    const page = mainWindow
    const assistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `segfoldtail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const midSegmentId = `${topicId}-mid-seg`
    const tailSegmentId = `${topicId}-tail-seg`
    const midSegmentName = 'Fold Mid Group'
    const tailSegmentName = 'Fold Tail Group'
    console.log(`[E2E][SegmentFold] seeding terminal-slot topic ${topicId}`)

    const addOk = await page.evaluate(
      ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
        try {
          ;(window as any).store.dispatch({
            type: 'assistants/addTopic',
            payload: {
              assistantId,
              topic: {
                id: topicId,
                assistantId,
                name,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              }
            }
          })
          return { ok: true }
        } catch (e) {
          return { ok: false, err: e instanceof Error ? e.message : String(e) }
        }
      },
      { topicId, assistantId, name: `Segment Tail Slot ${topicId}` }
    )
    expect(addOk.ok, `addTopic failed: ${(addOk as any).err}`).toBe(true)

    const entries = buildSeedEntries(topicId, assistantId)
    // turn 4 → mid group, turn 5 → the group that ends the flow.
    const midMembers = [
      msgId(topicId, turnIndices(SEED_TURNS - 1).user),
      msgId(topicId, turnIndices(SEED_TURNS - 1).assistant)
    ]
    const tailMembers = [
      msgId(topicId, turnIndices(SEED_TURNS).user),
      msgId(topicId, turnIndices(SEED_TURNS).assistant)
    ]
    const persisted = await page.evaluate(
      async ({
        topicId,
        assistantId,
        name,
        entries,
        midSegmentId,
        midSegmentName,
        midMembers,
        tailSegmentId,
        tailSegmentName,
        tailMembers
      }: Record<string, any>) => {
        try {
          const api: any = (window as any).api.chatDb
          const ensured = await api.ensureTopic({ topicId, assistantId, name })
          if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
          const pasted = await api.pasteMessagesToTopic({ topicId, entries })
          if (!pasted || pasted.ok !== true) return { ok: false, err: `paste ${JSON.stringify(pasted)}` }
          const mid = await api.upsertSegment({
            segmentId: midSegmentId,
            topicId,
            name: midSegmentName,
            messageIds: midMembers
          })
          if (!mid || mid.ok !== true) return { ok: false, err: `upsert mid ${JSON.stringify(mid)}` }
          const tail = await api.upsertSegment({
            segmentId: tailSegmentId,
            topicId,
            name: tailSegmentName,
            messageIds: tailMembers
          })
          if (!tail || tail.ok !== true) return { ok: false, err: `upsert tail ${JSON.stringify(tail)}` }
          return { ok: true }
        } catch (e) {
          return { ok: false, err: e instanceof Error ? e.message : String(e) }
        }
      },
      {
        topicId,
        assistantId,
        name: `Segment Tail Slot ${topicId}`,
        entries,
        midSegmentId,
        midSegmentName,
        midMembers,
        tailSegmentId,
        tailSegmentName,
        tailMembers
      }
    )
    expect(persisted.ok, `terminal-slot seed failed: ${(persisted as any).err}`).toBe(true)

    await activateTopicAndWaitForBootstrap(page, topicId, SEED_MESSAGES)
    // The row above the terminal group that stays visible in both states.
    const rowAboveTerminalId = msgId(topicId, turnIndices(SEED_TURNS - 2).assistant)

    // Fold the adjacent older group first: it is NOT the flow terminal, so it
    // must take no flow height and reserve no slot of its own.
    await page.locator(`${segmentHostSelector(midSegmentId)} [data-testid="topic-segment-fold"]`).click()
    await expect(page.locator(segmentHostSelector(midSegmentId))).toHaveAttribute('data-segment-folded', 'true', {
      timeout: 15000
    })
    await settleFoldMotion(page)
    await expect(page.locator('#messages [data-segment-fold-tail-slot]')).toHaveCount(0)
    const midHostHeight = await page
      .locator(segmentHostSelector(midSegmentId))
      .evaluate((el) => (el as HTMLElement).getBoundingClientRect().height)
    expect(midHostHeight, 'a non-terminal collapsed chrome host takes no flow height').toBe(0)

    // Fold the flow-terminal group: exactly one minimal slot appears.
    await page.locator(`${segmentHostSelector(tailSegmentId)} [data-testid="topic-segment-fold"]`).click()
    await expect(page.locator(segmentHostSelector(tailSegmentId))).toHaveAttribute('data-segment-folded', 'true', {
      timeout: 15000
    })
    await settleFoldMotion(page)
    await settleTwoFrames(page)

    const geometry = await page.evaluate(
      ({
        tailSegmentId,
        midSegmentId,
        rowAboveTerminalId
      }: {
        tailSegmentId: string
        midSegmentId: string
        rowAboveTerminalId: string
      }) => {
        const box = (document.getElementById('messages') as HTMLElement | null)?.getBoundingClientRect() ?? null
        const hostRect = (segmentId: string) => {
          const host = document.querySelector(
            `#messages [data-testid="topic-segment-line"][data-segment-id="${segmentId}"]`
          ) as HTMLElement | null
          const label = host?.querySelector('[data-testid="topic-segment-label"]') as HTMLElement | null
          const expand = host?.querySelector('[data-testid="topic-segment-expand"]') as HTMLElement | null
          const labelRect = label?.getBoundingClientRect() ?? null
          const expandRect = expand?.getBoundingClientRect() ?? null
          return {
            labelText: label?.textContent ?? '',
            cascade: label?.getAttribute('data-segment-cascade') ?? null,
            label: labelRect
              ? {
                  top: labelRect.top,
                  bottom: labelRect.bottom,
                  left: labelRect.left,
                  right: labelRect.right,
                  height: labelRect.height
                }
              : null,
            expand: expandRect
              ? {
                  top: expandRect.top,
                  bottom: expandRect.bottom,
                  left: expandRect.left,
                  right: expandRect.right
                }
              : null
          }
        }
        const slots = Array.from(document.querySelectorAll('#messages [data-segment-fold-tail-slot]')).map(
          (element) => {
            const rect = (element as HTMLElement).getBoundingClientRect()
            return { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width }
          }
        )
        const rowAbove =
          (
            document.querySelector(`#messages [data-message-id="${rowAboveTerminalId}"]`) as HTMLElement | null
          )?.getBoundingClientRect() ?? null
        const composer = (document.getElementById('inputbar') as HTMLElement | null)?.getBoundingClientRect() ?? null
        const trigger =
          (
            document.querySelector('[data-testid="topic-segment-drawer-trigger"]') as HTMLElement | null
          )?.getBoundingClientRect() ?? null
        const labels = Array.from(document.querySelectorAll('#messages [data-testid="topic-segment-label"]')).length
        return {
          box: box ? { top: box.top, bottom: box.bottom, height: box.height, left: box.left, right: box.right } : null,
          slots,
          labels,
          tail: hostRect(tailSegmentId),
          mid: hostRect(midSegmentId),
          rowAbove: rowAbove ? { top: rowAbove.top, bottom: rowAbove.bottom } : null,
          composer: composer ? { top: composer.top, bottom: composer.bottom } : null,
          trigger: trigger
            ? { top: trigger.top, bottom: trigger.bottom, left: trigger.left, right: trigger.right }
            : null
        }
      },
      { tailSegmentId, midSegmentId, rowAboveTerminalId }
    )
    console.log(`[E2E][SegmentFold] route-tail slot geometry ${JSON.stringify(geometry)}`)

    expect(geometry.box, 'the #messages scrollport must be measurable').not.toBeNull()
    expect(geometry.labels, 'each collapsed group keeps exactly one label').toBe(2)
    expect(geometry.slots, 'exactly ONE reserved tail slot exists for the whole flow').toHaveLength(1)
    const slot = geometry.slots[0]
    expect(slot.height, 'the reserved slot is one label height plus a small safety gap').toBeGreaterThanOrEqual(24)
    expect(slot.height, 'the reserved slot never grows into a blank band').toBeLessThanOrEqual(48)
    expect(slot.width, 'the reserved slot spans the body column').toBeGreaterThan(0)

    // The collapsed pill is completely inside the scrollport (this is exactly
    // what the previous zero-flow tail could not guarantee).
    expect(geometry.tail.label, 'the terminal group must paint its collapsed label').not.toBeNull()
    expect(geometry.tail.label!.top, 'the pill starts inside the scrollport').toBeGreaterThanOrEqual(
      geometry.box!.top + 1
    )
    expect(geometry.tail.label!.bottom, 'the pill ends inside the scrollport (no clipped bottom)').toBeLessThanOrEqual(
      geometry.box!.bottom - 1
    )
    expect(geometry.tail.label!.height, 'the pill keeps its own height').toBeGreaterThanOrEqual(20)

    // No artificial blank: the pill sits within the reserved slot height of the
    // scroll end, so the bottom padding stays the ordinary one.
    const pillToScrollEnd = geometry.box!.bottom - geometry.tail.label!.bottom
    expect(pillToScrollEnd, 'the tail pill is not pushed away from the scroll end').toBeLessThanOrEqual(
      slot.height + 24
    )

    // It never engages the previous visible message row.
    expect(geometry.rowAbove, 'the row above the terminal group must stay mounted').not.toBeNull()
    expect(
      geometry.rowAbove!.bottom,
      'the tail pill must sit below the previous message, not over it'
    ).toBeLessThanOrEqual(geometry.tail.label!.top + 1)

    // It never engages the composer or the Layers trigger, and the trigger
    // icon (still the higher layer) never covers the expand target's word.
    expect(geometry.composer, 'the composer must be measurable').not.toBeNull()
    expect(geometry.tail.label!.bottom, 'the tail pill stays above the composer').toBeLessThanOrEqual(
      geometry.composer!.top + 1
    )
    if (geometry.trigger) {
      const trigger = geometry.trigger
      const overlaps = (rect: { top: number; bottom: number; left: number; right: number }) =>
        Math.min(rect.bottom, trigger.bottom) - Math.max(rect.top, trigger.top) > 0 &&
        Math.min(rect.right, trigger.right) - Math.max(rect.left, trigger.left) > 0
      expect(overlaps(geometry.tail.label!), 'the tail pill must not overlap the Layers trigger').toBe(false)
      expect(geometry.tail.expand, 'the expand target must exist while folded').not.toBeNull()
      expect(overlaps(geometry.tail.expand!), 'the trigger icon must not cover the expand target').toBe(false)
    }

    // Consecutive terminal folds share that one slot: coincident labels keep the
    // existing horizontal cascade, so they stay distinguishable and never overlap.
    expect(geometry.mid.label, 'the adjacent collapsed group keeps its own label').not.toBeNull()
    expect(geometry.mid.label!.top, 'coincident collapsed labels share one seam').toBeCloseTo(
      geometry.tail.label!.top,
      0
    )
    expect(geometry.mid.cascade, 'coincident labels are cascaded, never stacked').not.toBe(geometry.tail.cascade)
    expect(
      Math.abs(geometry.mid.label!.left - geometry.tail.label!.left),
      'the cascade keeps the two labels horizontally apart'
    ).toBeGreaterThanOrEqual(100)

    // ── Reverse: expanding the terminal group removes the slot with the body ─
    await page.locator(`${segmentHostSelector(tailSegmentId)} [data-testid="topic-segment-expand"]`).click()
    await expect(page.locator(segmentHostSelector(tailSegmentId))).toHaveAttribute('data-segment-folded', 'false', {
      timeout: 15000
    })
    await settleFoldMotion(page)
    await settleTwoFrames(page)
    await expect(page.locator('#messages [data-segment-fold-tail-slot]')).toHaveCount(0)
    const tailRowsBack = await mountedMessageIds(page)
    for (const id of tailMembers) expect(tailRowsBack, `expanded row ${id} must return to the flow`).toContain(id)
    // The adjacent collapsed group is still zero-flow (nothing forced a band).
    const midHostHeightAfter = await page
      .locator(segmentHostSelector(midSegmentId))
      .evaluate((el) => (el as HTMLElement).getBoundingClientRect().height)
    expect(midHostHeightAfter, 'a non-terminal folded group keeps its zero-flow seam').toBe(0)
    console.log('[E2E][SegmentFold] route-tail slot verified')
  })

  /**
   * Folded-group navigation (the collapsed group as a navigation target).
   *
   * A collapsed group has no mounted body, so its ONLY navigable presentation
   * is the collapsed label pill. The TopicSegmentDrawer row still navigates the
   * group's authoritative first member (never a DOM click that expands it), and
   * the unified navigation transaction must land that LABEL inside the
   * `#messages` scrollport — from a position where the label is off-screen —
   * while the group stays folded: bodies unmounted, fold metadata untouched,
   * context/token counts and the persisted anchor unchanged.
   */
  test('drawer navigation lands an off-screen folded label in the scrollport without unfolding', async ({
    mainWindow
  }) => {
    test.setTimeout(300000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED folded navigation: seeded 5-turn topic with a segment on the OLDEST turn + real left-rule fold click → real wheel gestures scroll the collapsed label off-screen → real TopicSegmentDrawer row click navigates the authority first member and positions the collapsed LABEL inside the #messages scrollport, with the group still folded, its member rows still unmounted, and token count / persisted anchor / context boundary unchanged.'
    })

    const page = mainWindow
    const assistantId = await prepareDisplayCountAndAssistant(page)
    await seedContextCount(page, CONTEXT_COUNT, assistantId)
    const topicId = `segfoldnav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const segmentId = `${topicId}-seg`
    const segmentName = 'Fold Navigation Group'
    console.log(`[E2E][SegmentFold] seeding navigation topic ${topicId}`)

    // Oldest turn: after folding, scrolling back to the newest end puts its
    // collapsed label well above the scrollport, so the drawer navigation has to
    // travel for a folded target that is genuinely off-screen.
    const foldedMembers = await seedFoldedCandidateTopic(page, assistantId, topicId, segmentId, segmentName, 1)
    await activateTopicAndWaitForBootstrap(page, topicId, SEED_MESSAGES)
    await expect(
      page.locator(`#messages [data-testid="topic-segment-line"][data-segment-id="${segmentId}"]`)
    ).toHaveCount(1, { timeout: 15000 })

    // Real left-rule fold click (never a dispatch): the group is folded by the
    // same gesture a user performs.
    await page.locator(`${segmentHostSelector(segmentId)} [data-testid="topic-segment-fold"]`).click()
    await expect(page.locator(segmentHostSelector(segmentId))).toHaveAttribute('data-segment-folded', 'true', {
      timeout: 15000
    })
    await settleFoldMotion(page)
    await expect(page.locator('#messages [data-segment-fold-tail-slot]')).toHaveCount(0)
    const mountedFolded = await mountedMessageIds(page)
    for (const id of foldedMembers) {
      expect(mountedFolded, `folded row ${id} must leave the mounted flow`).not.toContain(id)
    }

    const foldedLabelState = () =>
      page.evaluate((segmentId: string) => {
        const container = document.getElementById('messages') as HTMLElement | null
        const host = document.querySelector(
          `#messages [data-testid="topic-segment-line"][data-segment-id="${segmentId}"]`
        ) as HTMLElement | null
        const label = host?.querySelector('[data-testid="topic-segment-label"]') as HTMLElement | null
        if (!container || !label) return null
        const c = container.getBoundingClientRect()
        const r = label.getBoundingClientRect()
        return {
          label: { top: r.top, bottom: r.bottom, height: r.height },
          box: { top: c.top, bottom: c.bottom },
          // Start-aligned navigation lands the label flush on the top edge, so
          // the inside test tolerates sub-pixel rounding there and still
          // requires the pill fully above the bottom edge.
          inside: r.top >= c.top - 1 && r.bottom <= c.bottom - 2,
          scrollTop: container.scrollTop
        }
      }, segmentId)

    // REAL wheel gestures toward the newest end (positive deltaY in this
    // column-reverse viewport) until the collapsed label is off-screen above.
    let beforeState = await foldedLabelState()
    expect(beforeState, 'the collapsed label must be measurable').not.toBeNull()
    for (let step = 0; step < 12 && !(beforeState!.label.bottom < beforeState!.box.top); step++) {
      await wheelMessagesViewport(page, 240)
      beforeState = await foldedLabelState()
    }
    expect(
      beforeState!.label.bottom,
      `the collapsed label must start off-screen above the scrollport (label=${JSON.stringify(beforeState!.label)} box=${JSON.stringify(beforeState!.box)})`
    ).toBeLessThan(beforeState!.box.top)
    expect(beforeState!.inside, 'the navigation must actually travel').toBe(false)

    const tokenBefore = await page.locator('[data-testid="token-count-context"]').textContent()
    const anchorBefore = await getPersistedAnchorGroupKey(page, topicId)
    const boundaryBefore = await page.locator('#messages [data-testid="context-boundary"]').count()
    // Real drawer row click: the row navigates the group's authority first
    // member; the transaction chooses the label presentation.
    await page.locator('[data-testid="topic-segment-drawer-trigger"]').click()
    const foldedRow = page.locator('[data-testid="topic-segment-drawer-row"][data-segment-folded="true"]')
    await expect(foldedRow).toHaveCount(1, { timeout: 15000 })
    await foldedRow.click()

    // The LABEL (never an unmounted body) must end up fully inside the scrollport.
    await page.waitForFunction(
      (segmentId: string) => {
        const container = document.getElementById('messages') as HTMLElement | null
        const host = document.querySelector(
          `#messages [data-testid="topic-segment-line"][data-segment-id="${segmentId}"]`
        ) as HTMLElement | null
        const label = host?.querySelector('[data-testid="topic-segment-label"]') as HTMLElement | null
        if (!container || !label) return false
        const c = container.getBoundingClientRect()
        const r = label.getBoundingClientRect()
        return r.top >= c.top - 1 && r.bottom <= c.bottom - 2
      },
      segmentId,
      { timeout: 15000 }
    )
    const afterLabelSelector = `${segmentHostSelector(segmentId)} [data-testid="topic-segment-label"]`
    await settleRects(page, [afterLabelSelector])

    const afterState = await foldedLabelState()
    if (!afterState) throw new Error('the collapsed label disappeared after navigation')
    console.log(`[E2E][SegmentFold] folded navigation geometry ${JSON.stringify({ beforeState, afterState })}`)
    expect(afterState.inside, 'the collapsed label must be inside the scrollport after navigation').toBe(true)
    expect(
      afterState.label.top,
      'start-aligned: the navigated label sits on the scrollport top edge'
    ).toBeLessThanOrEqual(afterState.box.top + 8)
    expect(
      afterState.label.height,
      'the navigated box is the label pill, not the zero-height chrome host'
    ).toBeGreaterThanOrEqual(20)
    expect(
      Math.abs(afterState.scrollTop - beforeState!.scrollTop),
      'navigation moved the viewport to the folded label'
    ).toBeGreaterThan(0)

    // Fold presentation is untouched: still folded, bodies still unmounted, and
    // the group keeps its zero-flow seam (it is not the flow terminal).
    await expect(page.locator(segmentHostSelector(segmentId))).toHaveAttribute('data-segment-folded', 'true')
    await expect(page.locator('#messages [data-segment-fold-tail-slot]')).toHaveCount(0)
    const hostHeight = await page
      .locator(segmentHostSelector(segmentId))
      .evaluate((el) => (el as HTMLElement).getBoundingClientRect().height)
    expect(hostHeight, 'a non-terminal folded group keeps its zero-flow seam').toBe(0)
    const mountedAfter = await mountedMessageIds(page)
    for (const id of foldedMembers) {
      expect(mountedAfter, `navigation must not expand folded row ${id}`).not.toContain(id)
    }
    const unrelatedRows = [
      msgId(topicId, turnIndices(2).user),
      msgId(topicId, turnIndices(2).assistant),
      msgId(topicId, turnIndices(SEED_TURNS).user)
    ]
    for (const id of unrelatedRows) {
      expect(mountedAfter, `unrelated row ${id} stays mounted`).toContain(id)
    }

    // Context, token estimation and the persisted anchor are navigation-invariant.
    const tokenAfter = await page.locator('[data-testid="token-count-context"]').textContent()
    expect(tokenAfter, 'navigation never changes the context turn count').toBe(tokenBefore)
    const anchorAfter = await getPersistedAnchorGroupKey(page, topicId)
    expect(anchorAfter, 'navigation never moves the persisted anchor').toBe(anchorBefore)
    // The anchor stays a seeded participating user turn (the folded oldest turn
    // is excluded from participation), and it is byte-identical across the
    // navigation.
    const seededUserIds = Array.from({ length: SEED_TURNS }, (_, index) => msgId(topicId, turnIndices(index + 1).user))
    expect(seededUserIds, 'the persisted anchor is a seeded user turn').toContain(anchorAfter)
    expect(
      await page.locator('#messages [data-testid="context-boundary"]').count(),
      'navigation never moves the context boundary'
    ).toBe(boundaryBefore)

    // The renderer's authority catalog still reports the group as folded: the
    // navigation neither expanded it nor wrote fold metadata.
    const catalogAfter = await page.evaluate((segmentId: string) => {
      const s = (window as any).store.getState()
      const segment = s.topicSegments?.segments?.entities?.[segmentId] ?? null
      return segment ? { folded: segment.folded ?? null, members: segment.messageIds ?? [] } : null
    }, segmentId)
    expect(catalogAfter, 'the folded segment stays in the authority catalog').not.toBeNull()
    expect(catalogAfter!.folded, 'navigation never writes the folded flag').toBe(true)
    for (const id of foldedMembers) expect(catalogAfter!.members).toContain(id)
    console.log('[E2E][SegmentFold] folded navigation verified')
  })
})
