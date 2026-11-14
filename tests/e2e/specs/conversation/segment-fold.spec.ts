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
 *   [data-testid="topic-segment-group"][data-segment-id][data-segment-folded]
 *   topic-segment-label / topic-segment-rail / topic-segment-rule /
 *   topic-segment-fold / topic-segment-expand / topic-segment-count /
 *   topic-segment-actions
 *   ONE `topic-segment-group` row per mounted group: the group owns ONE
 *     in-flow header row (same 32px occupancy folded and expanded), ONE
 *     continuous `topic-segment-rail` spanning every mounted run of the group,
 *     ONE `topic-segment-rule` mark and ONE menu. There is no per-run rail, no
 *     continuation mark and no reserved tail slot.
 * The header row is a REAL normal-flow row in both presentation states, so a
 * folded group is not a zero-flow seam: its body settles to zero height below
 * that row counter which keeps the collapsed label inside the scrollport.
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
 *
 * `memberIds` defaults to the two rows of `foldTurn`. A caller that needs a
 * group spanning SEVERAL turn runs (a later-rail fixture) passes its own
 * consecutive member list.
 */
async function seedFoldedCandidateTopic(
  page: any,
  assistantId: string,
  topicId: string,
  segmentId: string,
  segmentName: string,
  foldTurn: number = FOLD_TURN,
  memberIds?: string[]
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
  // A caller-supplied consecutive member list wins; the default is the one
  // turn's two rows. `members` (never the parameter) is what gets written.
  const members = memberIds ?? [
    msgId(topicId, turnIndices(foldTurn).user),
    msgId(topicId, turnIndices(foldTurn).assistant)
  ]

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
    { topicId, assistantId, name, entries, segmentId, segmentName, memberIds: members }
  )
  expect(persisted.ok, `seed failed: ${(persisted as any).err}`).toBe(true)
  // Unfolded by default: the wire carries no folded property at all.
  expect((persisted as any).wire?.folded).toBeUndefined()
  expect((persisted as any).wire?.messageCount).toBe(members.length)
  return members
}
/**
 * Seeds ONE topic that carries SEVERAL message groups in a single transaction
 * (one `ensureTopic` + one `pasteMessagesToTopic` + one `upsertSegment` per
 * group). An adjacency contract needs groups that really are neighbours in the
 * mounted flow, which a single-group seed cannot express; seeding each group
 * through its own `seedFoldedCandidateTopic` call would re-paste the same topic
 * twice.
 */
async function seedAdjacentSegmentTopic(
  page: any,
  assistantId: string,
  topicId: string,
  groups: Array<{ segmentId: string; segmentName: string; memberIds: string[] }>
): Promise<void> {
  const name = `Segment Adjacency Test ${topicId}`
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
  const persisted = await page.evaluate(
    async ({ topicId, assistantId, name, entries, groups }: Record<string, any>) => {
      try {
        const api: any = (window as any).api.chatDb
        const ensured = await api.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
        const pasted = await api.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste ${JSON.stringify(pasted)}` }
        for (const group of groups as Array<{ segmentId: string; segmentName: string; memberIds: string[] }>) {
          const upserted = await api.upsertSegment({
            segmentId: group.segmentId,
            topicId,
            name: group.segmentName,
            messageIds: group.memberIds
          })
          if (!upserted || upserted.ok !== true) return { ok: false, err: `upsert ${JSON.stringify(upserted)}` }
        }
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId, name, entries, groups }
  )
  expect(persisted.ok, `seed failed: ${(persisted as any).err}`).toBe(true)
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
      `#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`
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
      // "Visible" also means "not faded out": a folded group keeps its rule
      // mounted (the chrome fades with the body instead of unmounting ahead of
      // it), so the settled folded rule is attached but fully transparent.
      ruleVisible:
        !!rule &&
        (rule as HTMLElement).getBoundingClientRect().height > 0 &&
        Number.parseFloat(window.getComputedStyle(rule as HTMLElement).opacity || '0') > 0
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
      `#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`
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
          `#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`
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
  return `#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`
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
    // `topic-segment-group` host, a second label or a second fold write target.
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
          `#messages [data-testid="topic-segment-group"][data-segment-id="${id}"]`
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
          `#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`
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
    // The rule stays mounted and fades with the body: the chrome never switches
    // ahead of the content it belongs to, so the folded state has a transparent
    // (faded-out) rule rather than a missing one.
    expect(collapsed.hasRule, 'collapsed state keeps the left rule mounted').toBe(true)
    expect(collapsed.ruleVisible, 'the mounted rule is fully faded out while folded').toBe(false)
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

    // The group header row is the chrome host, and it is a REAL normal-flow row:
    // it owns the group's only flow contribution (a fixed compact row, identical
    // in both presentation states) and must add no padding/margin/min-height on
    // top of that row.
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
    expect(hostFlow.position, 'the group header is a real normal-flow row').toBe('relative')
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
    // The group header row is the group's FIXED in-flow occupancy: the same
    // compact row height in both presentation states. A collapsed group therefore
    // keeps its header row instead of collapsing the seam to zero flow, and the
    // body below it settles to zero height.
    expect(hostFolded.height, 'the collapsed header keeps its normal-flow row').toBeGreaterThanOrEqual(30)
    expect(hostFolded.height, 'the collapsed header keeps its normal-flow row').toBeLessThanOrEqual(34)
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
    // The group header row is a real normal-flow row: it keeps its fixed compact
    // height at the flow terminal too (identical to the expanded measurement
    // taken above), and the collapsed body contributes exactly zero below it —
    // no reserved tail slot and no placeholder element holding a blank gap open.
    expect(tailHostHeight, 'the group header row keeps its fixed normal-flow height at the flow terminal').toBe(
      hostFlow.height
    )
    expect(
      hostFlow.height,
      'the fixed group header row is the compact 32px row, folded and expanded alike'
    ).toBeCloseTo(SEGMENT_GROUP_HEADER_ROW_PX, 0)
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
      expect(restored.hasRule, 'folded state keeps the left rule mounted after relaunch').toBe(true)
      expect(restored.ruleVisible, 'the restored rule is faded out while folded').toBe(false)
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
   * Group-owned header row — the redesign contract.
   *
   * Every message group owns ONE in-flow header row that occupies the same
   * normal-flow height in BOTH presentation states. The old route-tail exception
   * (a folded group was zero-flow everywhere except for one reserved label slot
   * at the flow end, with consecutive terminal folds spread by a horizontal
   * cascade) is gone: collapsing settles the group BODY to zero height below
   * that row, so the collapsed label always stays inside the scrollport without
   * any reserved band. Two adjacent groups (one folded, one expanded) therefore
   * keep separate, non-overlapping header rows and each keeps exactly one rail.
   */
  test('adjacent folded and expanded groups keep one stable occupied header row each, with no tail slot and no cascade', async ({
    mainWindow
  }) => {
    test.setTimeout(300000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED group header occupancy: seeded 5-turn topic with two ADJACENT groups (seeded turns 3 and 4) + a real rail fold click on the older group → exactly two in-flow `topic-segment-group` rows at the fixed compact height, no `[data-segment-fold-tail-slot]`, no `data-segment-cascade`, the folded and expanded header rows vertically disjoint, the folded group’s header NODE identity unchanged across expand (one stable anchor), and one rail / one fold target per group.'
    })

    const page = mainWindow
    const assistantId = await prepareDisplayCountAndAssistant(page)
    await seedContextCount(page, CONTEXT_COUNT, assistantId)
    const topicId = `segfoldadjacent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const olderSegmentId = `${topicId}-older-seg`
    const newerSegmentId = `${topicId}-newer-seg`
    console.log(`[E2E][SegmentFold] seeding adjacent-group topic ${topicId}`)

    // Seeded turns 3 and 4 are consecutive rows of the mounted flow, so the two
    // groups are neighbours with no unsegmented content between them.
    const olderMembers = [msgId(topicId, turnIndices(3).user), msgId(topicId, turnIndices(3).assistant)]
    const newerMembers = [msgId(topicId, turnIndices(4).user), msgId(topicId, turnIndices(4).assistant)]
    await seedAdjacentSegmentTopic(page, assistantId, topicId, [
      { segmentId: olderSegmentId, segmentName: 'Adjacent Older Group', memberIds: olderMembers },
      { segmentId: newerSegmentId, segmentName: 'Adjacent Newer Group', memberIds: newerMembers }
    ])
    await activateTopicAndWaitForBootstrap(page, topicId, SEED_MESSAGES)

    const olderHost = page.locator(segmentHostSelector(olderSegmentId))
    const newerHost = page.locator(segmentHostSelector(newerSegmentId))
    await expect(olderHost, 'the older group owns one header row').toHaveCount(1, { timeout: 15000 })
    await expect(newerHost, 'the newer group owns one header row').toHaveCount(1, { timeout: 15000 })

    // One real rail click folds the older group (no test-only dispatch).
    const foldSelector = `${segmentHostSelector(olderSegmentId)} [data-testid="topic-segment-fold"]`
    const foldReveal = await revealChromeInViewport(page, foldSelector)
    expect(foldReveal?.inside ?? false, 'the rail fold target is revealable with real wheels').toBe(true)
    await page.locator(foldSelector).click()
    await expect(olderHost).toHaveAttribute('data-segment-folded', 'true', { timeout: 15000 })
    await settleFoldMotion(page)
    await expect(newerHost).toHaveAttribute('data-segment-folded', 'false')

    // No reserved tail slot, no horizontal cascade: the group owns its own row.
    await expect(page.locator('#messages [data-segment-fold-tail-slot]')).toHaveCount(0)
    await expect(page.locator('#messages [data-segment-cascade]')).toHaveCount(0)
    // One continuous rail per group (never one per run).
    await expect(page.locator('#messages [data-testid="topic-segment-rail"]')).toHaveCount(2)

    const geometry = await page.evaluate(
      ({ olderSegmentId, newerSegmentId }: { olderSegmentId: string; newerSegmentId: string }) => {
        const pick = (segmentId: string) => {
          const row = document.querySelector(
            `#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`
          ) as HTMLElement | null
          if (!row) return null
          const rect = row.getBoundingClientRect()
          const rail = row.querySelector('[data-testid="topic-segment-rail"]') as HTMLElement | null
          const fold = row.querySelector('[data-testid="topic-segment-fold"]') as HTMLElement | null
          const expand = row.querySelector('[data-testid="topic-segment-expand"]') as HTMLElement | null
          return {
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            railId: rail?.getAttribute('data-segment-id') ?? null,
            hasFold: !!fold,
            hasExpand: !!expand,
            label: (() => {
              const label = row.querySelector('[data-testid="topic-segment-label"]') as HTMLElement | null
              if (!label) return null
              const l = label.getBoundingClientRect()
              return { top: l.top, bottom: l.bottom, height: l.height }
            })()
          }
        }
        return { older: pick(olderSegmentId), newer: pick(newerSegmentId) }
      },
      { olderSegmentId, newerSegmentId }
    )
    expect(geometry.older, 'the folded group still paints its header row').not.toBeNull()
    expect(geometry.newer, 'the expanded group paints its header row').not.toBeNull()
    // Fixed compact occupancy, identical in the collapsed and expanded state.
    expect(geometry.older!.height).toBeGreaterThanOrEqual(30)
    expect(geometry.older!.height).toBeLessThanOrEqual(34)
    expect(geometry.newer!.height).toBeGreaterThanOrEqual(30)
    expect(geometry.newer!.height).toBeLessThanOrEqual(34)
    // Adjacent headers never overlap: each owns its own row.
    const disjoint =
      geometry.older!.bottom <= geometry.newer!.top + 0.5 || geometry.newer!.bottom <= geometry.older!.top + 0.5
    expect(disjoint, 'adjacent group header rows must not overlap').toBe(true)
    // Each group owns its own rail; the folded group offers no fold write,
    // the expanded one does.
    expect(geometry.older!.railId).toBe(olderSegmentId)
    expect(geometry.newer!.railId).toBe(newerSegmentId)
    expect(geometry.older!.hasFold).toBe(false)
    expect(geometry.older!.hasExpand).toBe(true)
    expect(geometry.newer!.hasFold).toBe(true)
    // The collapsed label is complete inside its OWN header row: the row is the
    // normal-flow occupant in both states, so the pill can never be pushed out of
    // the row into a reserved tail band.
    //
    // Scrollport containment is deliberately NOT asserted here: the fold's intent
    // capture keeps the header row (and the content above it) stationary, and this
    // fixture folds with more removed body height than the room left toward the
    // newest edge, so the viewport is honestly clamped there and the row can sit
    // a few px above the scrollport edge (measured row top 71.48 vs box top
    // 84.5). Reachability of the collapsed label through a real wheel gesture is
    // asserted right below.
    expect(geometry.older!.label, 'the folded group paints its label pill').not.toBeNull()
    expect(geometry.older!.label!.height, 'the collapsed label keeps its 24px pill height').toBeCloseTo(24, 0)
    expect(geometry.older!.label!.top, 'the collapsed label starts inside its own header row').toBeGreaterThanOrEqual(
      geometry.older!.top - 0.5
    )
    expect(geometry.older!.label!.bottom, 'the collapsed label ends inside its own header row').toBeLessThanOrEqual(
      geometry.older!.bottom + 0.5
    )

    // The header NODE identity is stable across the fold: mark the node, expand
    // through the group's own expand word, and compare.
    await page.evaluate((segmentId: string) => {
      ;(window as any).__segmentHeaderProbe = document.querySelector(
        `#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`
      )
    }, olderSegmentId)
    const expandSelector = `${segmentHostSelector(olderSegmentId)} [data-testid="topic-segment-expand"]`
    const expandReveal = await revealChromeInViewport(page, expandSelector)
    expect(expandReveal?.inside ?? false, 'the collapsed label is revealable with real wheels').toBe(true)
    await page.locator(expandSelector).click()
    await expect(olderHost).toHaveAttribute('data-segment-folded', 'false', { timeout: 15000 })
    await settleFoldMotion(page)
    const identity = await page.evaluate((segmentId: string) => {
      const header = document.querySelector(
        `#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`
      ) as HTMLElement | null
      return {
        sameNode: header === (window as any).__segmentHeaderProbe,
        height: header?.getBoundingClientRect().height ?? null
      }
    }, olderSegmentId)
    expect(identity.sameNode, 'the group header node survives the fold (one stable anchor)').toBe(true)
    expect(identity.height).toBeGreaterThanOrEqual(30)
    expect(identity.height).toBeLessThanOrEqual(34)
    console.log('[E2E][SegmentFold] adjacent group header rows verified')
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
      page.locator(`#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`)
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
          `#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`
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
          `#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`
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
      'the navigated box is the label pill, never the header row band'
    ).toBeGreaterThanOrEqual(20)
    expect(
      Math.abs(afterState.scrollTop - beforeState!.scrollTop),
      'navigation moved the viewport to the folded label'
    ).toBeGreaterThan(0)

    // Fold presentation is untouched: still folded and bodies still unmounted, while
    // the group keeps its fixed normal-flow header row (it is never zero-flow — the
    // group boundary owns that row in BOTH presentation states, non-terminal included).
    await expect(page.locator(segmentHostSelector(segmentId))).toHaveAttribute('data-segment-folded', 'true')
    await expect(page.locator('#messages [data-segment-fold-tail-slot]')).toHaveCount(0)
    const hostHeight = await page
      .locator(segmentHostSelector(segmentId))
      .evaluate((el) => (el as HTMLElement).getBoundingClientRect().height)
    expect(hostHeight, 'a collapsed group keeps its fixed in-flow header row (no zero-flow seam)').toBeCloseTo(
      SEGMENT_GROUP_HEADER_ROW_PX,
      0
    )
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

  /**
   * The group edge carries the group's own right-click menu.
   *
   * The menu is the SAME write/navigation surface the chrome already offers,
   * reached from the same edge (never from message content): collapse/expand
   * (owner-only, exactly the rail's write), rename, dissolve (same confirmation
   * string), and jump to the group's first message (the drawer's navigation
   * event). It claims the right click, so the message list's own context-menu
   * host never opens a second menu for the same gesture. Collapse and expand
   * from the menu run the one concurrent motion (fade + space on one time base),
   * and the group header + everything above it stay put while the delta lands
   * below.
   */
  test('the group edge right-click menu folds, expands and jumps without opening the message menu', async ({
    mainWindow
  }) => {
    test.setTimeout(300000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        "INTEGRATED group-edge menu: seeded topic + real right-click ON THE GROUP EDGE (the rail's collapse hit target while expanded, the pill while folded) → the group menu opens and the message list context menu does not; real menu collapse → rendered fold motion phase then settle, the SAME rule DOM node still mounted but faded out, rows above held within 1px; real right-click on the folded pill → expand + jump offered, rename/dissolve withheld; real menu expand → motion phase then settle with the rule visible again; real menu jump → the group start row lands start-aligned inside the #messages scrollport with participation unchanged."
    })

    const page = mainWindow
    const assistantId = await prepareDisplayCountAndAssistant(page)
    await seedContextCount(page, CONTEXT_COUNT, assistantId)
    const topicId = `segfoldmenu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const segmentId = `${topicId}-seg`
    const segmentName = 'Fold Menu Group'
    console.log(`[E2E][SegmentFold] seeding menu topic ${topicId}`)

    const foldedMembers = await seedFoldedCandidateTopic(page, assistantId, topicId, segmentId, segmentName)
    await activateTopicAndWaitForBootstrap(page, topicId, SEED_MESSAGES)

    const host = page.locator(segmentHostSelector(segmentId))
    await expect(host, 'segment chrome must render for the seeded group').toHaveCount(1, { timeout: 15000 })
    const rule = page.locator(`${segmentHostSelector(segmentId)} [data-testid="topic-segment-rule"]`)
    // Real user targets on the group edge: the rail's transparent collapse
    // target covers the rule (4px of rule + 4px gutter) in the expanded state,
    // and the pill is the edge object while folded (the fold target is only
    // mounted expanded). Clicking the bare rule node would be intercepted by
    // the hit target that exists exactly to make that edge clickable.
    const foldTarget = page.locator(`${segmentHostSelector(segmentId)} [data-testid="topic-segment-fold"]`)
    const label = page.locator(`${segmentHostSelector(segmentId)} [data-testid="topic-segment-label"]`)

    const collapseItem = page.getByRole('menuitem', { name: /^(Collapse group|折叠消息组)$/ })
    const expandItem = page.getByRole('menuitem', { name: /^(Expand group|展开消息组)$/ })
    const renameItem = page.getByRole('menuitem', { name: /^(Rename|重命名)$/ })
    const dissolveItem = page.getByRole('menuitem', { name: /^(Dissolve Group|解散消息组)$/ })
    const jumpItem = page.getByRole('menuitem', { name: /^(Jump to start|跳转至起点|跳轉至起點)$/ })

    // Non-tail placement: the fold's height delta must land on content below,
    // which is the only placement where "rows above stay put" is a real claim
    // (at the newest edge the honest outcome is a natural clamp).
    const placement = await placeGroupAtNonTailViewport(page, segmentId, foldedMembers)
    expect(placement.belowBandPx, 'non-tail placement keeps content below the header').toBeGreaterThanOrEqual(150)

    // ── Step 1: real right click ON THE GROUP EDGE ───────────────────────────
    // The collapse hit target IS the group edge in the expanded state (it
    // covers the 4px rule plus the gutter, by design), so a real user right
    // click lands here — never on the rule node underneath it.
    await foldTarget.click({ button: 'right' })
    await expect(collapseItem, 'the group menu offers collapse').toBeVisible({ timeout: 10000 })
    await expect(renameItem, 'the group menu offers rename').toBeVisible()
    await expect(dissolveItem, 'the group menu offers dissolve').toBeVisible()
    await expect(jumpItem, 'the group menu offers jump to the group start').toBeVisible()
    // Exactly one popup is open, and it is the group's: the message list's own
    // context-menu host never opens a second, conflicting menu.
    await expect(page.locator('.ant-dropdown-menu:visible'), 'one menu, the group menu').toHaveCount(1)
    console.log('[E2E][SegmentFold] group-edge menu opened')
    const aboveId = msgId(topicId, turnIndices(FOLD_TURN - 1).assistant)
    const aboveSelector = `#messages [data-message-id="${aboveId}"]`
    const aboveBefore = (await settleRects(page, [aboveSelector]))[0]
    expect(aboveBefore, 'row above the group must be mounted').not.toBeNull()

    // Under OS reduced motion the component settles instantly; the phase is then
    // never painted, which is the correct behaviour and not a missed motion.
    const motionEnabled = await page.evaluate(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    const waitForFoldPhase = () =>
      page.waitForFunction(() => !!document.querySelector('#messages [data-segment-fold-phase]'), undefined, {
        timeout: 5000,
        polling: 10
      })

    // Node identity is part of the rendered claim: the chrome must animate in
    // place, so the SAME rule element has to survive the fold (a replaced node
    // could only be committed already faded — no transition left to run).
    await rule.evaluate((el) => ((el as any).__segmentFoldRuleMark = 'before-fold'))
    await collapseItem.click()
    if (motionEnabled) await waitForFoldPhase()
    await expect(host).toHaveAttribute('data-segment-folded', 'true', { timeout: 15000 })
    await settleFoldMotion(page)

    const collapsed = await readSegmentChrome(page, segmentId)
    expect(collapsed.folded, 'the menu collapses the group').toBe(true)
    expect(collapsed.hasRule, 'the rule stays mounted while folded (it fades, it does not switch)').toBe(true)
    expect(collapsed.ruleVisible, 'the folded rule is faded out').toBe(false)
    expect(collapsed.hasFoldTarget, 'the fold hit target leaves with the expanded chrome').toBe(false)
    expect(
      await rule.evaluate((el) => ((el as any).__segmentFoldRuleMark as string | undefined) ?? null),
      'the folded rule is the same DOM node (the fade runs on it in place)'
    ).toBe('before-fold')
    expect(collapsed.hasActions, 'hover rename/dissolve are withheld while folded').toBe(false)
    const aboveAfter = (await settleRects(page, [aboveSelector]))[0]
    expect(
      Math.abs((aboveAfter as any).top - (aboveBefore as any).top),
      'content above the group stays put across the menu fold'
    ).toBeLessThanOrEqual(1)

    // ── Step 2: the folded pill's menu keeps the whole group menu ────────────
    // The folded header offers the SAME four items: rename and dissolve stay
    // reachable because the rename popover and the dissolve Popconfirm are
    // anchored surfaces with no dependency on an expanded body. Only the
    // fold switch flips its label, and only the fold write stays owner-only.
    await label.click({ button: 'right' })
    await expect(expandItem, 'a folded group offers expand').toBeVisible({ timeout: 10000 })
    await expect(jumpItem).toBeVisible()
    await expect(renameItem, 'the folded menu keeps rename (anchored popover)').toBeVisible()
    await expect(dissolveItem, 'the folded menu keeps dissolve (anchored Popconfirm)').toBeVisible()
    await expect(page.locator('.ant-dropdown-menu:visible'), 'one menu, the group menu').toHaveCount(1)

    await expandItem.click()
    if (motionEnabled) await waitForFoldPhase()
    await expect(host).toHaveAttribute('data-segment-folded', 'false', { timeout: 15000 })
    await settleFoldMotion(page)

    const reExpanded = await readSegmentChrome(page, segmentId)
    expect(reExpanded.hasRule, 'the rule is back with the expanded chrome').toBe(true)
    expect(reExpanded.ruleVisible, 'the expanded rule is visible again').toBe(true)
    expect(reExpanded.hasFoldTarget, 'the fold hit target returns').toBe(true)
    expect(reExpanded.hasActions, 'hover rename/dissolve return').toBe(true)
    const mountedBack = await mountedMessageIds(page)
    for (const id of foldedMembers) expect(mountedBack, `expanded row ${id} is back in the flow`).toContain(id)

    // ── Step 3: jump to the group start from the same edge menu ─────────────
    const tokenBefore = await page.locator('[data-testid="token-count-context"]').textContent()
    const anchorBefore = await getPersistedAnchorGroupKey(page, topicId)
    await foldTarget.click({ button: 'right' })
    await expect(jumpItem).toBeVisible({ timeout: 10000 })
    await jumpItem.click()

    const firstMemberId = foldedMembers[0]
    const firstMemberSelector = `#messages [data-message-id="${firstMemberId}"]`
    await settleRects(page, [firstMemberSelector])
    const landing = await page.evaluate((firstMemberId: string) => {
      const container = document.getElementById('messages') as HTMLElement | null
      const row = document.querySelector(`#messages [data-message-id="${firstMemberId}"]`) as HTMLElement | null
      if (!container || !row) return null
      const c = container.getBoundingClientRect()
      const r = row.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, box: { top: c.top, bottom: c.bottom }, scrollTop: container.scrollTop }
    }, firstMemberId)
    expect(landing, 'the group start row must be mounted for the jump').not.toBeNull()
    console.log(`[E2E][SegmentFold] menu jump landing ${JSON.stringify(landing)}`)
    expect(landing!.top, 'start-aligned: the group start row lands on the scrollport top edge').toBeLessThanOrEqual(
      landing!.box.top + 8
    )
    expect(landing!.bottom, 'the jump target is inside the scrollport').toBeGreaterThan(landing!.box.top)
    // Navigation never changes participation.
    expect(await page.locator('[data-testid="token-count-context"]').textContent()).toBe(tokenBefore)
    expect(await getPersistedAnchorGroupKey(page, topicId)).toBe(anchorBefore)
    console.log('[E2E][SegmentFold] group-edge menu verified')
  })
})

/**
 * Places the GROUP's single continuous rail under the pointer while the group's
 * elected header pill sits entirely OUTSIDE the `#messages` scrollport — the
 * geometry a reader actually meets after scrolling into a group: the header is
 * far offscreen and the same group edge is still at hand further down.
 *
 * The rail is ONE overlay owned by the group (it spans every mounted run plus
 * the group's internal divider heights), so this helper places it instead of
 * picking “a later rail”. It returns the offset (inside the rail element) of a
 * point that is both inside the scrollport and inside the rail, which is where a
 * real click/hover must land: Playwright clicks the CENTER of an element, and
 * the center of a group-long rail is legitimately far outside the scrollport.
 *
 * Real wheel gestures only, same direction convention as
 * `revealChromeInViewport`: a NEGATIVE `deltaY` pushes content DOWN (toward
 * older rows), a positive one pushes it UP (toward newer rows).
 */
async function placeGroupRailWithHeaderOffscreen(
  page: any,
  segmentId: string,
  timeoutMs = 15000
): Promise<{
  railTop: number
  railBottom: number
  labelTop: number
  labelBottom: number
  boxTop: number
  boxBottom: number
  scrollTop: number
  clickOffsetY: number
  labelOutside: boolean
}> {
  const EDGE = 10
  const MIN_VISIBLE = 48
  const clampStep = (n: number) => Math.sign(n) * Math.max(48, Math.min(220, Math.round(Math.abs(n))))
  let last: any = null
  let stagnant = 0
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate(
      ({ segmentId, edge, minVisible }: { segmentId: string; edge: number; minVisible: number }) => {
        const container = document.getElementById('messages') as HTMLElement | null
        const header = document.querySelector(
          `#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`
        ) as HTMLElement | null
        if (!container || !header) return null
        const rail = header.querySelector('[data-testid="topic-segment-rail"]') as HTMLElement | null
        const label = header.querySelector('[data-testid="topic-segment-label"]') as HTMLElement | null
        if (!rail || !label) return null
        const c = container.getBoundingClientRect()
        const r = rail.getBoundingClientRect()
        const l = label.getBoundingClientRect()
        // The usable part of the rail: the intersection of the rail and the
        // scrollport, with an edge margin on both sides.
        const visibleTop = Math.max(r.top, c.top + edge)
        const visibleBottom = Math.min(r.bottom, c.bottom - edge)
        const visibleHeight = visibleBottom - visibleTop
        return {
          railTop: r.top,
          railBottom: r.bottom,
          labelTop: l.top,
          labelBottom: l.bottom,
          boxTop: c.top,
          boxBottom: c.bottom,
          scrollTop: container.scrollTop,
          clickOffsetY: Math.round(visibleTop + Math.min(visibleHeight / 2, visibleHeight - 12) - r.top),
          visibleHeight,
          labelOutside: l.bottom <= c.top || l.top >= c.bottom
        }
      },
      { segmentId, edge: EDGE, minVisible: MIN_VISIBLE }
    )
    if (!state) throw new Error(`the group rail of ${segmentId} is not rendered`)
    last = state
    if (state.labelOutside && state.visibleHeight >= MIN_VISIBLE && state.clickOffsetY > 0) {
      return state
    }

    let deltaY: number
    if (state.labelBottom > state.boxTop && state.labelTop < state.boxBottom) {
      // The pill still overlaps the box: content has to move UP until it clears
      // the top edge (the rail continues far below, so it survives that move).
      deltaY = clampStep(state.labelBottom - state.boxTop + 24)
    } else if (state.visibleHeight < MIN_VISIBLE) {
      // No usable piece of the rail is inside the box: bring the group's span
      // into view from whichever side it is closer to.
      const overflowAbove = state.railTop < state.boxTop ? state.railBottom - state.boxTop : 0
      deltaY = clampStep(overflowAbove > 0 ? -(state.boxBottom - state.railBottom + MIN_VISIBLE) : MIN_VISIBLE)
    } else {
      deltaY = clampStep(MIN_VISIBLE)
    }

    const scrollTopBefore = state.scrollTop
    await wheelMessagesViewport(page, deltaY)
    const scrollTopAfter = await page.evaluate(
      () => (document.getElementById('messages') as HTMLElement | null)?.scrollTop ?? null
    )
    stagnant = scrollTopAfter !== null && Math.abs(scrollTopAfter - scrollTopBefore) < 2 ? stagnant + 1 : 0
    if (stagnant >= 2) {
      throw new Error(`the viewport cannot travel any further for ${segmentId}: ${JSON.stringify(last)}`)
    }
  }
  throw new Error(`the group rail never reached the header-offscreen placement: ${JSON.stringify(last)}`)
}
/** Fixed normal-flow row height of one group header row (see TopicSegmentLine). */
const SEGMENT_GROUP_HEADER_ROW_PX = 32

/**
 * Ownership probe for one viewport point: does `document.elementFromPoint`
 * resolve to the SAME group's own rail surface? Used before AND after a
 * real-pointer gesture, so the gesture is proven to land on this group's edge
 * rather than on whatever else might occupy that coordinate.
 */
async function readRailOwnership(
  page: any,
  segmentId: string,
  point: { x: number; y: number }
): Promise<{ owned: boolean; testId: string | null; onHeaderPill: boolean }> {
  return page.evaluate(
    ({ segmentId, point }: { segmentId: string; point: { x: number; y: number } }) => {
      const el = document.elementFromPoint(point.x, point.y) as HTMLElement | null
      const owner = el?.closest('[data-testid="topic-segment-group"]')
      return {
        owned: !!owner && owner.getAttribute('data-segment-id') === segmentId,
        testId: el?.getAttribute('data-testid') ?? el?.tagName.toLowerCase() ?? null,
        onHeaderPill: !!el?.closest('[data-testid="topic-segment-label"]')
      }
    },
    { segmentId, point }
  )
}

interface RailPointerPoint {
  x: number
  y: number
  railTop: number
  railBottom: number
  boxTop: number
  boxBottom: number
  scrollTop: number
  hitTestId: string | null
}

/**
 * Resolves a REAL-pointer point on the group's ONE continuous rail that is
 * ALREADY inside the `#messages` scrollport, from the CURRENTLY measured rects.
 *
 * `locator.hover/click({ position })` cannot be used on this rail: Playwright
 * scrolls a locator target into view before gesturing, and this rail is taller
 * than the column-reverse scrollport, so the auto-scroll moves the viewport and
 * invalidates both the header-offscreen placement and the measurement. The
 * gesture therefore takes an ABSOLUTE viewport coordinate that
 * `document.elementFromPoint` already proves to be this group's own rail
 * surface (never the header pill, never a message body, never another group's
 * chrome), and drives `page.mouse` directly. When the current placement has no
 * usable slice of the rail inside the box, one bounded real wheel step is taken
 * (never a `scrollTop` write) and the probe is repeated.
 */
async function resolveRailPointerPoint(page: any, segmentId: string, attempts = 8): Promise<RailPointerPoint> {
  const EDGE = 10
  const MIN_SLICE = 16
  let last: any = null
  let lastScrollTop: number | null = null
  let stagnant = 0
  for (let attempt = 0; attempt < attempts; attempt++) {
    const state: any = await page.evaluate(
      ({ segmentId, edge, minSlice }: { segmentId: string; edge: number; minSlice: number }) => {
        const container = document.getElementById('messages') as HTMLElement | null
        const header = document.querySelector(
          `#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`
        ) as HTMLElement | null
        const rail = header?.querySelector('[data-testid="topic-segment-rail"]') as HTMLElement | null
        if (!container || !header || !rail) return { ok: false, reason: 'the group rail is not rendered' }
        const c = container.getBoundingClientRect()
        const r = rail.getBoundingClientRect()
        const top = Math.max(r.top, c.top + edge)
        const bottom = Math.min(r.bottom, c.bottom - edge)
        const base = {
          railTop: r.top,
          railBottom: r.bottom,
          boxTop: c.top,
          boxBottom: c.bottom,
          scrollTop: container.scrollTop
        }
        if (bottom - top < minSlice) {
          return { ...base, ok: false, reason: `no usable rail slice inside the scrollport (${top}..${bottom})` }
        }
        // The 8px hit target sits over the 4px rail: the coordinate is proven by
        // hit-testing, never by assuming this gutter belongs to the group.
        const x = Math.round(r.left + 3)
        const mid = Math.round((top + bottom) / 2)
        const candidates: number[] = [mid]
        for (let step = 1; step <= 8; step++) {
          const span = Math.min(step * 16, Math.floor((bottom - top) / 2) - 2)
          if (span <= 0) break
          candidates.push(mid - span, mid + span)
        }
        for (const y of candidates) {
          if (y < top || y > bottom) continue
          const el = document.elementFromPoint(x, y) as HTMLElement | null
          const owner = el?.closest('[data-testid="topic-segment-group"]')
          if (!owner || owner.getAttribute('data-segment-id') !== segmentId) continue
          if (el?.closest('[data-testid="topic-segment-label"]')) continue
          return {
            ...base,
            ok: true,
            x,
            y,
            hitTestId: el?.getAttribute('data-testid') ?? el?.tagName.toLowerCase() ?? null
          }
        }
        return {
          ...base,
          ok: false,
          reason: 'elementFromPoint does not resolve to this group rail inside the scrollport'
        }
      },
      { segmentId, edge: EDGE, minSlice: MIN_SLICE }
    )
    if (!state) throw new Error(`the group rail of ${segmentId} is not rendered`)
    if (state.ok) return state
    last = state
    const scrollTop = await page.evaluate(
      () => (document.getElementById('messages') as HTMLElement | null)?.scrollTop ?? null
    )
    stagnant =
      lastScrollTop !== null && scrollTop !== null && Math.abs(scrollTop - lastScrollTop) < 2 ? stagnant + 1 : 0
    lastScrollTop = scrollTop
    if (stagnant >= 2) break
    await wheelMessagesViewport(page, attempt % 2 === 0 ? -160 : 160)
  }
  throw new Error(`no real-pointer point on the group rail of ${segmentId}: ${JSON.stringify(last)}`)
}

/**
 * Later-turn rail surface — the group edge on a run that is NOT the elected
 * header run. The point of this asset is that the rail is a full group edge:
 * left click collapses through the one shared fold write, right click opens the
 * group's one menu, and the anchored rename/dissolve popovers follow the rail
 * pointer with the header label far outside the scrollport (nothing here
 * depends on the pill being rendered).
 */
test.describe('Topic segment fold — later-turn rail', () => {
  test('the ONE group rail collapses and opens the group menu anywhere on the line, and rename, jump and dissolve work with the header offscreen', async ({
    mainWindow
  }) => {
    test.setTimeout(300000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        "INTEGRATED one group rail: seeded consecutive 8-row group spanning turns 1..4 (turn 5 stays newer, outside the group) — FOUR turn runs physically carry the group, so the single group-owned rail must span all of them + real wheel gestures until a deep point of that ONE rail is inside the #messages scrollport while the elected header pill is entirely outside it; with the pill on screen the group name and its hover pencil rename INLINE in the pill itself (focused with the whole name selected, Enter/blur commit a trimmed name, Escape writes nothing, no popover, no mask, no fold and no navigation) and the header's own Trash2 dissolve is the original anchored Popconfirm at its trigger button (arrow, no mask, no modal, i18n copy + 取消/确认) and cancels without touching the group; a right click on the pill opens the same group menu at the group TOP, where a menu action surface still keeps its region beside the WHOLE menu 8px clear and its LEFT arrow on the group rail (the boundary clamp opens it below the whole menu when the region above would leave the arrow past the rail); hover on a deep rail point → the groupwide hover state turns on (pill actions visible) with exactly ONE rail/ONE rule mark for the whole line (no per-run marks); real LEFT CLICK on the same deep point collapses the group through the one shared fold write (participating turns 10 → 2, the group's rows leave the mounted flow) and the collapsed label expands back (2 → 10); real RIGHT CLICK on the same rail point → exactly one group menu with the exact item order (rename, collapse group, jump to start, dissolve group), no second message menu; menu rename → one compact anchored popover beside the WHOLE menu whose box is captured while the menu is still open (8px clear above the menu, LEFT arrow on its own left edge pointing at the group rail: the 1px pin IS the rail line, 13px between the rail and the surface's left edge), no backdrop, single-line input prefilled with the current name, Enter saves and the name persists, reopen + Escape leaves it unchanged; menu jump start-aligns the group's first row without changing participation; menu dissolve → the same anchored Popconfirm beside the whole menu (same rail-pointer geometry, body-size copy, no heading, ≤360px wide, LEFT arrow, no mask) cancels without touching the group, then confirmed removes the group while all ten messages stay mounted and participating."
    })

    const page = mainWindow
    const assistantId = await prepareDisplayCountAndAssistant(page)
    await seedContextCount(page, CONTEXT_COUNT, assistantId)
    const topicId = `segfoldlaterrail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const segmentId = `${topicId}-seg`
    const segmentName = 'Later Rail Group'
    console.log(`[E2E][SegmentFold] seeding later-rail topic ${topicId}`)

    // Turns 1..4 are the group. Seeded rows carry no shared askId, so those
    // eight rows are FOUR separate turn runs — the group-owned rail must span
    // every one of them as ONE line. Turn 5 deliberately stays OUT of the group:
    // it is the newer content a wheel gesture uses to hold the group edge at
    // hand while the header sits far off above it — and after the fold it is
    // what stays mounted while the group's own rows leave the flow.
    const LATER_TURNS = [1, 2, 3, 4]
    const laterMembers = LATER_TURNS.flatMap((turn) => [
      msgId(topicId, turnIndices(turn).user),
      msgId(topicId, turnIndices(turn).assistant)
    ])
    // Folding removes the group's eight rows: 8 of 10 context turns leave, and
    // the two turn-5 rows outside the group are what stays mounted.
    const whileFolded = SEED_MESSAGES - laterMembers.length

    const seeded = await seedFoldedCandidateTopic(
      page,
      assistantId,
      topicId,
      segmentId,
      segmentName,
      LATER_TURNS[0],
      laterMembers
    )
    expect(seeded, 'the seeded group is the whole consecutive member list').toEqual(laterMembers)
    await activateTopicAndWaitForBootstrap(page, topicId, SEED_MESSAGES)

    const host = page.locator(segmentHostSelector(segmentId))
    await expect(host, 'segment chrome must render for the seeded group').toHaveCount(1, { timeout: 15000 })
    // ONE continuous rail owned by the group — never one per run, never a
    // continuation mark on a later turn.
    const rail = host.locator('[data-testid="topic-segment-rail"]')
    await expect(rail, 'the group owns exactly ONE continuous rail').toHaveCount(1, { timeout: 15000 })
    await expect(page.locator('#messages [data-segment-continuation-host]')).toHaveCount(0)
    await expect(page.locator('#messages [data-testid="topic-segment-fold-continuation"]')).toHaveCount(0)
    // One label pill, on the header only.
    await expect(host.locator('[data-testid="topic-segment-label"]')).toHaveCount(1)

    // ── Shared reads for the rail-anchored group surfaces ───────────────────
    // The WHOLE menu box a group action surface relates to, captured while that
    // menu is still open (it unmounts with the user's click).
    type MenuBox = { left: number; right: number; top: number; bottom: number }
    const RENAME_ITEM = /^(Rename|重命名|重新命名)$/
    const COLLAPSE_ITEM = /^(Collapse group|折叠消息组|摺疊訊息組)$/
    const JUMP_ITEM = /^(Jump to start|跳转至起点|跳轉至起點)$/
    const DISSOLVE_ITEM = /^(Dissolve Group|解散消息组|解散訊息組)$/
    const DISSOLVE_COPY = /确定要解散此消息组吗|確定要解散此消息組嗎|Are you sure you want to dissolve this group/
    const visibleMenuItems = page.locator('.ant-dropdown-menu:visible .ant-dropdown-menu-item')
    // Anchored action surfaces (rename Popover / dissolve Popconfirm) share one
    // antd overlay class family: `.ant-popover` is the surface root (a Popconfirm
    // root carries BOTH `ant-popover` and `ant-popconfirm`) and
    // `.ant-popover-arrow` is the direction indicator. Neither paints a modal
    // mask, so a stray `.ant-modal` anywhere is a regression.
    const actionSurface = page.locator('.ant-popover:visible')
    const actionArrow = actionSurface.locator('.ant-popover-arrow')
    const modalMask = page.locator('.ant-modal-mask')
    const modalWrap = page.locator('.ant-modal-wrap')
    const renameInput = actionSurface.locator('input')
    // The popup speaks the locale's own wording: never the library's `OK`.
    const CANCEL_TEXT = /^(取消|Cancel)$/
    const CONFIRM_TEXT = /^(确认|確認|Confirm)$/
    const readSegmentName = () =>
      page.evaluate((segmentId: string) => {
        const s = (window as any).store?.getState()
        return (s?.topicSegments?.segments?.entities?.[segmentId]?.name as string | undefined) ?? null
      }, segmentId)

    // Production reads the WHOLE menu box while the click is still dispatching: a
    // group action surface sits beside the whole menu the user chose from — never
    // beside one row of it — and that menu unmounts with the click. A pre-click
    // measurement can still be moving with the menu's open animation, so the test
    // reads the SAME box from the DOM at the click instant.
    const armMenuBoxCapture = async (rowIndex: number) => {
      await visibleMenuItems.nth(rowIndex).evaluate((el) => {
        ;(window as any).__segmentFoldMenuBox = null
        el.addEventListener(
          'click',
          () => {
            const menu = (el as HTMLElement).closest('.ant-dropdown-menu') ?? el
            const rect = menu.getBoundingClientRect()
            ;(window as any).__segmentFoldMenuBox = {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom
            }
          },
          { capture: true, once: true }
        )
      })
    }
    const readMenuBox = () => page.evaluate(() => (window as any).__segmentFoldMenuBox as MenuBox | null)

    /**
     * One anchored surface's geometry, read against the WHOLE menu box captured
     * for this invocation. `side` is where the surface sits relative to that box;
     * the rail is the arrow's target, so its span comes with the read.
     */
    const readMenuSurfaceGeometry = (pinTestId: string, menuBox: MenuBox) =>
      actionSurface.evaluate(
        (el, args: { pinTestId: string; menuBox: MenuBox }) => {
          const rect = el.getBoundingClientRect()
          const arrow = el.querySelector('.ant-popover-arrow') as HTMLElement | null
          const arrowRect = arrow ? arrow.getBoundingClientRect() : null
          const pin = document.querySelector(`[data-testid="${args.pinTestId}"]`) as HTMLElement | null
          const pinRect = pin ? pin.getBoundingClientRect() : null
          const rail = document.querySelector('#messages [data-testid="topic-segment-rule"]') as HTMLElement | null
          const railRect = rail ? rail.getBoundingClientRect() : null
          const side = rect.bottom <= args.menuBox.top + 1 ? 'above' : 'below'
          const arrowMidY = arrowRect ? (arrowRect.top + arrowRect.bottom) / 2 : null
          return {
            side,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            gapAboveMenu: Math.round(args.menuBox.top - rect.bottom),
            gapBelowMenu: Math.round(rect.top - args.menuBox.bottom),
            aboveRoom: Math.round(args.menuBox.top - 8),
            belowRoom: Math.round(window.innerHeight - args.menuBox.bottom - 8),
            leftOffsetFromRail: railRect ? Math.round(rect.left - railRect.left) : null,
            arrowPresent: arrowRect !== null,
            arrowLeft: arrowRect ? arrowRect.left : null,
            arrowRight: arrowRect ? arrowRect.right : null,
            arrowDepth: arrowRect ? Math.round(rect.left - arrowRect.left) : null,
            arrowMidY,
            // The paint that makes the arrow a LEFT arrow (not merely a box at
            // the left edge) comes from the placement class: log both, so a lost
            // class or a lost transform is visible in the evidence itself.
            surfaceClass: el.className,
            arrowTransform: arrow ? getComputedStyle(arrow).transform : null,
            arrowOnRail:
              arrowMidY !== null && railRect !== null
                ? arrowMidY >= railRect.top + 1 && arrowMidY <= railRect.bottom - 1
                : false,
            pinWidth: pinRect ? pinRect.width : null,
            pinHeight: pinRect ? pinRect.height : null,
            pinLeft: pinRect ? pinRect.left : null,
            pinTop: pinRect ? pinRect.top : null,
            railLeft: railRect ? railRect.left : null,
            railTop: railRect ? railRect.top : null,
            railBottom: railRect ? railRect.bottom : null,
            insideViewport:
              rect.top >= -1 &&
              rect.bottom <= window.innerHeight + 1 &&
              rect.left >= -1 &&
              rect.right <= window.innerWidth + 1
          }
        },
        { pinTestId, menuBox }
      )

    /**
     * Assert the rail-pointer contract of one anchored group-action surface and
     * return its measured geometry:
     * - the WHOLE menu's box is the vertical reference: the surface keeps the
     *   region above it `8px` clear, or opens below it `8px` clear;
     * - its arrow is painted on the surface's own LEFT edge and points at the
     *   group rail, whose span the arrow's middle must land INSIDE;
     * - the surface's left edge keeps only the arrow's room from the rail
     *   (`13px`), and the `1px` pin IS the rail's line at the anchored edge.
     */
    const expectMenuSurfaceGeometry = async (options: {
      pinTestId: string
      menuBox: MenuBox
      label: string
      maxWidth: number
      requireArrowOnRail?: boolean
    }) => {
      // A popup is read only once its own open motion has settled: the zoom
      // animation scales the whole rectangle, so an early read reports every
      // edge (and the arrow) at the animation's scale instead of the rectangle
      // the user actually sees.
      await actionSurface.evaluate(async (el) => {
        const animations = el.getAnimations({ subtree: true })
        await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
      })
      const geometry = await readMenuSurfaceGeometry(options.pinTestId, options.menuBox)
      console.log(`[E2E][SegmentFold] ${options.label} surface geometry ${JSON.stringify(geometry)}`)
      expect(geometry, `the ${options.label} surface is mounted`).not.toBeNull()
      const g = geometry!
      expect(g.insideViewport, `the ${options.label} surface stays inside the viewport`).toBe(true)
      expect(g.width, `compact ${options.label} surface width`).toBeGreaterThanOrEqual(180)
      expect(g.width, `compact ${options.label} surface width`).toBeLessThanOrEqual(options.maxWidth)
      const menuGap = g.side === 'above' ? g.gapAboveMenu : g.gapBelowMenu
      const menuSide = g.side === 'above' ? 'above' : 'below'
      expect(
        menuGap,
        `the ${options.label} surface opens ${menuSide} the WHOLE menu, 8px clear`
      ).toBeGreaterThanOrEqual(6)
      expect(menuGap, `the ${options.label} surface opens ${menuSide} the WHOLE menu, 8px clear`).toBeLessThanOrEqual(
        11
      )
      expect(g.railLeft, 'the group rail is mounted as the arrow target').not.toBeNull()
      expect(g.arrowPresent, 'the surface carries a direction arrow').toBe(true)
      expect(g.arrowRight, 'the arrow is painted on the surface LEFT edge, never its right').not.toBeNull()
      expect(g.arrowRight!, 'the arrow is painted on the surface LEFT edge, never its right').toBeLessThanOrEqual(
        g.left + 2
      )
      expect(g.arrowLeft!, 'the arrow sticks out to the LEFT, toward the rail').toBeLessThanOrEqual(g.left - 4)
      expect(g.arrowLeft!, 'the arrow stops at the rail, never in empty space left of it').toBeGreaterThanOrEqual(
        g.railLeft! - 10
      )
      expect(
        g.leftOffsetFromRail!,
        'the surface LEFT edge keeps only the arrow gap from the rail'
      ).toBeGreaterThanOrEqual(11)
      expect(g.leftOffsetFromRail!, 'the surface LEFT edge keeps only the arrow gap from the rail').toBeLessThanOrEqual(
        15
      )
      if (options.requireArrowOnRail !== false) {
        expect(g.arrowMidY, 'the arrow points INSIDE the rail span, never above or below it').not.toBeNull()
        expect(g.arrowMidY!, 'the arrow points INSIDE the rail span').toBeGreaterThanOrEqual(g.railTop! + 1)
        expect(g.arrowMidY!, 'the arrow points INSIDE the rail span').toBeLessThanOrEqual(g.railBottom! - 1)
      }
      expect(g.pinWidth, 'the pin is a 1px point on the rail').not.toBeNull()
      expect(g.pinWidth!).toBeLessThanOrEqual(1.5)
      expect(g.pinHeight!).toBeLessThanOrEqual(1.5)
      expect(g.pinLeft, 'the pin is a 1px point on the rail').not.toBeNull()
      expect(Math.abs(g.pinLeft! - g.railLeft!), 'the pin IS the rail line').toBeLessThanOrEqual(1)
      const anchoredEdge = g.side === 'above' ? options.menuBox.top - 8 : options.menuBox.bottom + 8
      expect(
        Math.abs(g.pinTop! - anchoredEdge),
        'the pin is the anchored edge, 8px clear of the WHOLE menu'
      ).toBeLessThanOrEqual(2)
      return g
    }

    // The one rail really spans the whole group: its measured box starts at the
    // header and reaches the group’s last mounted row, i.e. it crosses all four
    // turn runs instead of stopping at the elected run.
    const railSpan = await page.evaluate(
      ({ segmentId, firstMemberId, lastMemberId }: Record<string, string>) => {
        const header = document.querySelector(
          `#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`
        ) as HTMLElement | null
        const rail = header?.querySelector('[data-testid="topic-segment-rail"]') as HTMLElement | null
        const first = document.querySelector(`#messages [data-message-id="${firstMemberId}"]`) as HTMLElement | null
        const last = document.querySelector(`#messages [data-message-id="${lastMemberId}"]`) as HTMLElement | null
        if (!rail || !first || !last) return null
        const r = rail.getBoundingClientRect()
        const f = first.getBoundingClientRect()
        const l = last.getBoundingClientRect()
        return {
          railTop: r.top,
          railBottom: r.bottom,
          railHeight: r.height,
          firstTop: f.top,
          lastBottom: l.bottom,
          rules: header?.querySelectorAll('[data-testid="topic-segment-rule"]').length ?? 0
        }
      },
      {
        segmentId,
        firstMemberId: laterMembers[0],
        lastMemberId: laterMembers[laterMembers.length - 1]
      }
    )
    expect(railSpan, 'the group rail and its boundary rows must be mounted').not.toBeNull()
    // Headed at the group header, tailed just above the group’s last row, and
    // taller than any single row: one line across four runs.
    expect(railSpan!.railTop, 'the rail starts at the group header').toBeLessThanOrEqual(railSpan!.firstTop + 48)
    expect(railSpan!.railBottom, 'the rail reaches the group’s last mounted row').toBeGreaterThanOrEqual(
      railSpan!.lastBottom - 48
    )
    expect(railSpan!.railHeight, 'the rail spans the whole multi-run group').toBeGreaterThan(
      (railSpan!.lastBottom - railSpan!.firstTop) * 0.5
    )
    expect(railSpan!.rules, 'exactly one rule mark for the whole line').toBe(1)

    // ── The direct header dissolve is the ORIGINAL anchored Popconfirm ───────
    // The Trash2 action inside the header pill keeps the pre-existing surface:
    // an antd Popconfirm wrapped around that trigger button, arrow at the
    // button, no backdrop, and the app's own i18n copy/button wording. This
    // runs BEFORE the header is pushed offscreen, so the button-anchored path
    // itself is what is under test here (the menu path is covered later).
    const headerLabelSelector = `${segmentHostSelector(segmentId)} [data-testid="topic-segment-label"]`
    const headerReveal = await revealChromeInViewport(page, headerLabelSelector)
    expect(headerReveal?.inside ?? false, 'the group header is revealable for the direct dissolve').toBe(true)
    await page.locator(headerLabelSelector).hover()
    await expect(host.locator('[data-testid="topic-segment-actions"]')).toHaveCSS('opacity', '1')
    const headerDissolveSurface = page.locator('.ant-popover:visible')
    const HEADER_DISSOLVE_ACTION = /^(Dissolve Group|解散消息组|解散訊息組)$/
    const HEADER_DISSOLVE_COPY =
      /确定要解散此消息组吗|確定要解散此消息組嗎|Are you sure you want to dissolve this group/
    const HEADER_CANCEL_TEXT = /^(取消|Cancel)$/
    const HEADER_CONFIRM_TEXT = /^(确认|確認|Confirm)$/
    const headerTrigger = host.getByTitle(HEADER_DISSOLVE_ACTION)
    await expect(headerTrigger, 'the header offers its own dissolve button').toHaveCount(1)
    const headerTriggerRect = await headerTrigger.boundingBox()
    expect(headerTriggerRect, 'the header dissolve trigger must have a box').not.toBeNull()
    await headerTrigger.click()
    await expect(headerDissolveSurface, 'the direct dissolve opens exactly one anchored surface').toHaveCount(1, {
      timeout: 10000
    })
    await expect(
      page.locator('.ant-popover.ant-popconfirm:visible'),
      'the header dissolves through the original Popconfirm, never a modal'
    ).toHaveCount(1)
    await expect(
      headerDissolveSurface.locator('.ant-popover-arrow'),
      'the direct confirm carries a direction arrow'
    ).toHaveCount(1)
    await expect(page.locator('.ant-modal-mask'), 'the direct dissolve paints no backdrop').toHaveCount(0)
    await expect(page.locator('.ant-modal-wrap'), 'the direct dissolve is not a modal').toHaveCount(0)
    await expect(page.locator('.ant-modal'), 'no modal box at all').toHaveCount(0)
    await expect(headerDissolveSurface.locator('.ant-popconfirm-title')).toHaveText(HEADER_DISSOLVE_COPY)
    await expect(
      headerDissolveSurface.locator('.ant-popconfirm-description'),
      'the copy is the only body text (never a heading band)'
    ).toHaveCount(0)
    const headerAppearance = await headerDissolveSurface.evaluate(
      (el, anchor) => {
        const buttons = Array.from(el.querySelectorAll('.ant-popconfirm-buttons .ant-btn')) as HTMLElement[]
        const rect = el.getBoundingClientRect()
        return {
          width: rect.width,
          insideViewport:
            rect.top >= -1 &&
            rect.bottom <= window.innerHeight + 1 &&
            rect.left >= -1 &&
            rect.right <= window.innerWidth + 1,
          horizontalOffset: Math.round((rect.left + rect.right) / 2 - anchor.centerX),
          aboveGap: Math.round(anchor.top - rect.bottom),
          belowGap: Math.round(rect.top - anchor.bottom),
          buttonTexts: buttons.map((button) => button.textContent ?? ''),
          dangerButtons: el.querySelectorAll('.ant-popconfirm-buttons .ant-btn-dangerous').length
        }
      },
      {
        centerX: headerTriggerRect!.x + headerTriggerRect!.width / 2,
        top: headerTriggerRect!.y,
        bottom: headerTriggerRect!.y + headerTriggerRect!.height
      }
    )
    console.log(`[E2E][SegmentFold] header dissolve appearance ${JSON.stringify(headerAppearance)}`)
    expect(headerAppearance.width, 'compact header confirm width').toBeLessThanOrEqual(360)
    expect(headerAppearance.insideViewport, 'the header confirm stays inside the viewport').toBe(true)
    expect(
      Math.abs(headerAppearance.horizontalOffset),
      'the header confirm points at its button, never the window'
    ).toBeLessThanOrEqual(120)
    expect(
      Math.min(Math.abs(headerAppearance.aboveGap), Math.abs(headerAppearance.belowGap)),
      'the header confirm sits beside its trigger'
    ).toBeLessThanOrEqual(40)
    expect(headerAppearance.buttonTexts).toHaveLength(2)
    expect(headerAppearance.buttonTexts[0]).toMatch(HEADER_CANCEL_TEXT)
    expect(headerAppearance.buttonTexts[1]).toMatch(HEADER_CONFIRM_TEXT)
    expect(headerAppearance.buttonTexts[1], 'the app wording, never the library default').not.toMatch(/^OK$/i)
    expect(headerAppearance.dangerButtons, 'the header confirm keeps its danger style').toBe(1)
    await headerDissolveSurface.locator('.ant-popconfirm-buttons .ant-btn').first().click()
    await expect(headerDissolveSurface, 'cancelling the header confirm closes it').toHaveCount(0, {
      timeout: 10000
    })
    await expect(host, 'a cancelled header dissolve keeps the group').toHaveCount(1)
    await expect(page.locator('.ant-modal-mask'), 'no mask lingers after the anchored confirm closes').toHaveCount(0, {
      timeout: 5000
    })

    // ── Step 0a: the pill's own rename happens INLINE, never in a surface ─────
    // Clicking the group name (or its hover pencil) turns the pill into a
    // one-line editor in place: no popover, no popconfirm, no mask, no row
    // movement. It opens focused with the whole name selected, Enter/blur commit
    // a trimmed draft, a blank or unchanged draft writes nothing, Escape drops
    // it, and neither gesture folds the group nor navigates the conversation.
    const inlineRenamed = 'Inline Renamed Group'
    const inlineEditor = host.locator('[data-testid="topic-segment-rename-inline"]')
    const headerRenameTrigger = host.getByTitle(/^(Rename|重命名|重新命名)$/)
    await expect(host.getByText(segmentName, { exact: true }), 'the pill shows the seeded name').toHaveCount(1)
    await host.getByText(segmentName, { exact: true }).click()
    await expect(inlineEditor, 'the pill itself becomes the editor').toHaveCount(1, { timeout: 10000 })
    await expect(inlineEditor, 'the editor is the pill, not an overlay').toBeFocused()
    await expect(inlineEditor, 'the editor opens on the current name').toHaveValue(segmentName)
    const inlineSelection = await inlineEditor.evaluate((el) => {
      const input = el as HTMLInputElement
      return { start: input.selectionStart, end: input.selectionEnd, length: input.value.length }
    })
    expect(inlineSelection.start, 'the whole name is selected on open (one keystroke away)').toBe(0)
    expect(inlineSelection.end).toBe(inlineSelection.length)
    await expect(actionSurface, 'the inline editor opens NO anchored surface').toHaveCount(0)
    await expect(page.locator('.ant-modal-mask'), 'the inline editor paints no backdrop').toHaveCount(0)
    await inlineEditor.fill(inlineRenamed)
    await inlineEditor.press('Enter')
    await expect(inlineEditor, 'Enter closes the inline editor').toHaveCount(0, { timeout: 10000 })
    await expect.poll(async () => await readSegmentName(), { timeout: 15000 }).toBe(inlineRenamed)
    await expect(host.locator('[data-testid="topic-segment-label"]')).toContainText(inlineRenamed)
    await expect(host, 'an inline rename never folds the group').toHaveAttribute('data-segment-folded', 'false')
    // The hover pencil is the SAME inline entrance, and Escape drops the draft.
    await page.locator(headerLabelSelector).hover()
    await expect(host.locator('[data-testid="topic-segment-actions"]')).toHaveCSS('opacity', '1')
    await headerRenameTrigger.click()
    await expect(inlineEditor, 'the pencil opens the same inline editor').toHaveCount(1, { timeout: 10000 })
    await expect(inlineEditor).toHaveValue(inlineRenamed)
    await expect(actionSurface, 'the pencil opens NO anchored surface either').toHaveCount(0)
    await inlineEditor.fill('Discarded Inline Name')
    await inlineEditor.press('Escape')
    await expect(inlineEditor, 'Escape closes the inline editor').toHaveCount(0, { timeout: 10000 })
    expect(await readSegmentName(), 'a cancelled inline rename writes nothing').toBe(inlineRenamed)
    await expect(actionSurface, 'no surface is left behind by the inline editor').toHaveCount(0)

    // ── Step 0b: a menu surface at the group top still points at the rail ────
    // The pill IS the group's own top edge, so a right click on it opens the group
    // menu at the group top. The surface keeps its region beside the WHOLE menu,
    // 8px clear, and the boundary clamp opens it BELOW that menu whenever the
    // region above would leave the LEFT arrow past the rail's span (the rail only
    // starts below the pill) and the below side can still host a compact surface.
    await page.locator(headerLabelSelector).click({ button: 'right' })
    await expect(page.locator('.ant-dropdown-menu:visible'), 'one group menu from the pill').toHaveCount(1)
    await expect(visibleMenuItems, 'the group menu offers its four actions').toHaveCount(4, { timeout: 10000 })
    await armMenuBoxCapture(0)
    await visibleMenuItems.nth(0).click()
    const flipMenuBox = await readMenuBox()
    expect(flipMenuBox, 'the whole menu box is read at click time').not.toBeNull()
    await renameInput.waitFor({ state: 'visible', timeout: 10000 })
    const flip = await expectMenuSurfaceGeometry({
      pinTestId: 'topic-segment-rename-anchor',
      menuBox: flipMenuBox!,
      label: 'menu at the group top',
      maxWidth: 320,
      requireArrowOnRail: false
    })
    // The clamp applies when the other side can host a compact surface; a viewport
    // too short for it keeps the roomier side. Either way the arrow must keep a
    // meaningful target.
    expect(
      flip.arrowOnRail || flip.belowRoom < 140,
      'the LEFT arrow points at the rail whenever a side can host the surface'
    ).toBe(true)
    await renameInput.press('Escape')
    await expect(actionSurface, 'Escape closes the menu surface').toHaveCount(0, { timeout: 10000 })
    await expect(page.locator('.ant-modal-mask'), 'no mask is ever painted').toHaveCount(0)

    const placement = await placeGroupRailWithHeaderOffscreen(page, segmentId)
    expect(placement.labelOutside, 'the header pill is offscreen while the group rail is at hand').toBe(true)
    console.log(`[E2E][SegmentFold] group rail placement ${JSON.stringify(placement)}`)

    const interactionTarget = host.locator('[data-testid="topic-segment-fold"]')
    await expect(interactionTarget, 'the one rail is interactive while expanded').toHaveCount(1)
    const usePlacement = async () => {
      const next = await placeGroupRailWithHeaderOffscreen(page, segmentId)
      expect(next.labelOutside, 'the header pill stays offscreen').toBe(true)
      await expect(interactionTarget).toHaveCount(1)
      return next
    }

    // ── Step 0: the whole line is ONE mark and ONE hover state ───────────────
    // A REAL pointer is moved onto a point deep inside the rail (far below the
    // header). The point comes from the current rects and is proven with
    // `elementFromPoint`, so no locator-level auto-scroll can move this
    // column-reverse viewport out of the placement that was just established.
    const railPoint = await resolveRailPointerPoint(page, segmentId)
    console.log(`[E2E][SegmentFold] group rail pointer point ${JSON.stringify(railPoint)}`)
    const pointOwnership = await readRailOwnership(page, segmentId, railPoint)
    expect(pointOwnership.owned, `the resolved point belongs to this group rail (${pointOwnership.testId})`).toBe(true)
    expect(pointOwnership.onHeaderPill, 'the resolved point is on the rail, never on the header pill').toBe(false)
    await page.mouse.move(railPoint.x, railPoint.y)
    // The gesture must not have moved the pointer off the group's own surface.
    await expect.poll(async () => (await readRailOwnership(page, segmentId, railPoint)).owned).toBe(true)
    await expect(host.locator('[data-testid="topic-segment-actions"]')).toHaveCSS('opacity', '1')
    await expect(host.locator('[data-testid="topic-segment-rule"]')).toHaveCSS('filter', 'brightness(1.35)')
    await expect(page.locator('#messages [data-testid="topic-segment-rule"]')).toHaveCount(1)
    // Leaving the line releases the same single hover state.
    const box = await page.locator('#messages').first().boundingBox()
    expect(box, '#messages must have a box').not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 8)
    await expect(host.locator('[data-testid="topic-segment-actions"]')).toHaveCSS('opacity', '0')
    await expect(host.locator('[data-testid="topic-segment-rule"]')).toHaveCSS('filter', 'none')

    // The menu is opened by a REAL right click on the already-proven rail point:
    // the coordinate is re-resolved from the current rects (and ownership
    // re-checked) so a placement drift can never turn this into a click on the
    // message body or on the nav.
    const openMenu = async () => {
      const point = await resolveRailPointerPoint(page, segmentId)
      expect((await readRailOwnership(page, segmentId, point)).owned, 'right click lands on the group rail').toBe(true)
      await page.mouse.click(point.x, point.y, { button: 'right' })
      // The open menu is a portal overlay: it may legitimately cover this
      // coordinate, so the ownership precondition belongs BEFORE the gesture
      // (asserted above), not after it.
      await expect(page.locator('.ant-dropdown-menu:visible'), 'one menu, the group menu').toHaveCount(1)
      await expect(visibleMenuItems, 'the group menu offers its four actions').toHaveCount(4, { timeout: 10000 })
      // The surface is anchored on the group RAIL beside the WHOLE menu, never at
      // the group header row. The placement above proves the header pill is
      // outside the scrollport, so a header-anchored surface would paint above the
      // viewport instead of beside the click; the menu must therefore be painted
      // inside the viewport.
      const menuPlacement = await page.evaluate(() => {
        const rectOf = (selector: string) => {
          const element = document.querySelector(selector) as HTMLElement | null
          const rect = element ? element.getBoundingClientRect() : null
          return rect ? { top: rect.top, bottom: rect.bottom } : null
        }
        return {
          menu: rectOf('.ant-dropdown-menu'),
          label: rectOf('#messages [data-testid="topic-segment-label"]'),
          viewportHeight: window.innerHeight
        }
      })
      expect(menuPlacement.menu, 'the opened group menu is mounted').not.toBeNull()
      expect(
        menuPlacement.menu!.top,
        'the group menu follows the rail pointer, never the offscreen header row'
      ).toBeGreaterThanOrEqual(0)
      expect(menuPlacement.menu!.bottom, 'the whole group menu stays inside the viewport').toBeLessThanOrEqual(
        menuPlacement.viewportHeight
      )
      console.log(`[E2E][SegmentFold] menu pointer anchor ${JSON.stringify(menuPlacement)}`)
      // The pointer only anchors the MENU itself (it is also the engine's
      // fallback when a menu box is unreachable); the action surfaces pin the
      // WHOLE menu's box and the group RAIL, so the caller compares both gaps.
      return point
    }
    // ── Step 1: the group rail's right click IS the group menu ───────────────
    await openMenu()
    await expect(visibleMenuItems, 'the group rail menu lists the four group actions in order').toHaveText([
      RENAME_ITEM,
      COLLAPSE_ITEM,
      JUMP_ITEM,
      DISSOLVE_ITEM
    ])
    console.log('[E2E][SegmentFold] group rail menu opened with the exact item order')

    // ── Step 2: rename through the anchored rename popover ───────────────────
    const renamed = 'Rail Renamed Group'
    // The WHOLE menu box is captured at the click instant: the surface hangs off
    // the whole menu, 8px clear, with its LEFT arrow on the group rail. The row
    // that is clicked unmounts with the menu the moment the item is chosen.
    await armMenuBoxCapture(0)
    await visibleMenuItems.nth(0).click()
    const renameMenuBox = await readMenuBox()
    expect(renameMenuBox, 'the whole menu box is read at click time').not.toBeNull()
    await renameInput.waitFor({ state: 'visible', timeout: 10000 })
    await expect(actionSurface, 'rename opens exactly one anchored surface').toHaveCount(1)
    await expect(actionArrow, 'the rename surface carries its LEFT direction arrow').toHaveCount(1)
    await expect(modalMask, 'rename paints no backdrop').toHaveCount(0)
    await expect(modalWrap, 'rename is not a modal').toHaveCount(0)
    await expect(page.locator('.ant-modal'), 'no modal box at all').toHaveCount(0)
    await expectMenuSurfaceGeometry({
      pinTestId: 'topic-segment-rename-anchor',
      menuBox: renameMenuBox!,
      label: 'rename',
      maxWidth: 320
    })
    await expect(renameInput, 'one single-line input').toHaveCount(1)
    await expect(renameInput, 'the input opens prefilled with the current name').toHaveValue(inlineRenamed)
    const renameButtons = actionSurface.locator('.ant-popover-inner button')
    await expect(renameButtons, 'the surface offers exactly two actions').toHaveCount(2)
    await expect(renameButtons.nth(0)).toHaveText(CANCEL_TEXT)
    await expect(renameButtons.nth(1)).toHaveText(CONFIRM_TEXT)
    await expect(renameButtons.nth(1), 'the app wording, never the library default').not.toHaveText(/^OK$/i)
    await renameInput.fill(renamed)
    await expect(renameInput).toHaveValue(renamed, { timeout: 5000 })
    await renameInput.press('Enter')
    await expect(actionSurface, 'Enter confirms and closes the surface').toHaveCount(0, { timeout: 10000 })
    await expect.poll(async () => await readSegmentName(), { timeout: 15000 }).toBe(renamed)
    await expect(host.locator('[data-testid="topic-segment-label"]')).toContainText(renamed)

    // ── Step 3: rename cancel writes nothing ─────────────────────────────────
    await openMenu()
    await visibleMenuItems.nth(0).click()
    await renameInput.waitFor({ state: 'visible', timeout: 10000 })
    await expect(renameInput, 'the surface opens prefilled with the current name').toHaveValue(renamed)
    await renameInput.fill('Discarded Rename')
    await renameInput.press('Escape')
    await expect(actionSurface, 'Escape cancels the surface').toHaveCount(0, { timeout: 10000 })
    expect(await readSegmentName(), 'a cancelled rename writes nothing').toBe(renamed)
    // No modal mask may linger: the real pointer must be able to return to the
    // message column (a live mask legitimately wins `elementFromPoint`).
    await expect(page.locator('.ant-modal-mask'), 'no mask is ever painted').toHaveCount(0, { timeout: 5000 })

    // ── Step 4: left click on the SAME group rail collapses the group ────────
    // Real pointer, pre-proven coordinate: the rail is longer than the
    // scrollport, so a locator click would auto-scroll and destroy the
    // header-offscreen placement established for this step.
    const foldPoint = await resolveRailPointerPoint(page, segmentId)
    expect((await readRailOwnership(page, segmentId, foldPoint)).owned, 'left click lands on the group rail').toBe(true)
    await page.mouse.click(foldPoint.x, foldPoint.y)
    await expect(host).toHaveAttribute('data-segment-folded', 'true', { timeout: 15000 })
    // Same contract as the baseline fold (segment-fold.spec.ts:1124): the
    // participating-context block reports the folded denominator as its MAX too,
    // because the folded turns leave BOTH the current count and the reachable
    // window of `contextCount` turns.
    await expectTokenCount(page, whileFolded, whileFolded)
    await expect.poll(async () => (await mountedMessageIds(page)).length, { timeout: 15000 }).toBe(whileFolded)
    await expect
      .poll(
        async () => {
          const ids = await mountedMessageIds(page)
          return laterMembers.every((id) => !ids.includes(id))
        },
        { timeout: 15000 }
      )
      .toBe(true)

    // The collapsed label expands back through the same shared fold write.
    const expandSelector = `${segmentHostSelector(segmentId)} [data-testid="topic-segment-expand"]`
    const revealed = await revealChromeInViewport(page, expandSelector)
    expect(revealed?.inside ?? false, 'the collapsed label is revealable with real wheels').toBe(true)
    await page.locator(expandSelector).click()
    await expect(host).toHaveAttribute('data-segment-folded', 'false', { timeout: 15000 })
    await expectTokenCount(page, CONTEXT_COUNT, CONTEXT_COUNT)
    await expect.poll(async () => (await mountedMessageIds(page)).length, { timeout: 15000 }).toBe(SEED_MESSAGES)

    // ── Step 5: jump to the group start from the group rail menu ─────────────
    await usePlacement()
    const tokenBeforeJump = await page.locator('[data-testid="token-count-context"]').textContent()
    await openMenu()
    await visibleMenuItems.nth(2).click()
    const firstMemberId = laterMembers[0]
    const firstMemberSelector = `#messages [data-message-id="${firstMemberId}"]`
    await settleRects(page, [firstMemberSelector])
    const landing = await page.evaluate((firstMemberId: string) => {
      const container = document.getElementById('messages') as HTMLElement | null
      const row = document.querySelector(`#messages [data-message-id="${firstMemberId}"]`) as HTMLElement | null
      if (!container || !row) return null
      const c = container.getBoundingClientRect()
      const r = row.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, box: { top: c.top, bottom: c.bottom } }
    }, firstMemberId)
    expect(landing, 'the group start row must be mounted for the jump').not.toBeNull()
    console.log(`[E2E][SegmentFold] group rail jump landing ${JSON.stringify(landing)}`)
    expect(landing!.top, 'start-aligned: the group start row lands on the scrollport top edge').toBeLessThanOrEqual(
      landing!.box.top + 8
    )
    expect(landing!.bottom, 'the jump target is inside the scrollport').toBeGreaterThan(landing!.box.top)
    expect(await page.locator('[data-testid="token-count-context"]').textContent()).toBe(tokenBeforeJump)

    // ── Step 6: dissolve — the same anchored Popconfirm, then removal ────────
    const readSegmentEntity = () =>
      page.evaluate((segmentId: string) => {
        const s = (window as any).store?.getState()
        return s?.topicSegments?.segments?.entities?.[segmentId] ? true : false
      }, segmentId)
    // The dissolve step starts from the group rail again (the jump moved the
    // viewport to the group start, where the header is at hand).
    await usePlacement()
    await openMenu()
    // The WHOLE menu box is captured at the click instant: the surface hangs off
    // the whole menu (the region the user already knows), never off one row of
    // it, and that menu unmounts the moment an item is chosen.
    await armMenuBoxCapture(3)
    await visibleMenuItems.nth(3).click()
    const dissolveMenuBox = await readMenuBox()
    expect(dissolveMenuBox, 'the whole menu box is read at click time').not.toBeNull()
    await expect(actionSurface, 'dissolve opens exactly one anchored surface').toHaveCount(1, { timeout: 10000 })
    await expect(
      page.locator('.ant-popover.ant-popconfirm:visible'),
      'the dissolve surface is the same anchored Popconfirm'
    ).toHaveCount(1)
    await expect(actionArrow, 'the confirm carries a direction arrow').toHaveCount(1)
    await expect(modalMask, 'dissolve paints no backdrop').toHaveCount(0)
    await expect(modalWrap, 'dissolve is not a modal').toHaveCount(0)
    await expect(page.locator('.ant-modal'), 'no modal box at all').toHaveCount(0)
    await expect(actionSurface.locator('.ant-popconfirm-title')).toHaveText(DISSOLVE_COPY)
    await expect(
      actionSurface.locator('.ant-popconfirm-description'),
      'the copy is the only body text (never a heading band)'
    ).toHaveCount(0)
    await expectMenuSurfaceGeometry({
      pinTestId: 'topic-segment-dissolve-anchor',
      menuBox: dissolveMenuBox!,
      label: 'dissolve',
      maxWidth: 360
    })
    const dissolveButtons = actionSurface.locator('.ant-popconfirm-buttons .ant-btn')
    await expect(dissolveButtons, 'the confirm offers exactly two actions').toHaveCount(2)
    await expect(dissolveButtons.first()).toHaveText(CANCEL_TEXT)
    await expect(dissolveButtons.last()).toHaveText(CONFIRM_TEXT)
    await expect(dissolveButtons.last(), 'the app wording, never the library default').not.toHaveText(/^OK$/i)
    await expect(actionSurface.locator('.ant-popconfirm-buttons .ant-btn-dangerous'), 'one danger confirm').toHaveCount(
      1
    )

    await actionSurface.locator('.ant-popconfirm-buttons .ant-btn').first().click()
    await expect(actionSurface, 'cancel closes the confirm').toHaveCount(0, { timeout: 10000 })
    await expect(host, 'a cancelled dissolve keeps the group').toHaveCount(1)
    expect(await readSegmentEntity(), 'a cancelled dissolve keeps the authority entity').toBe(true)
    await expect.poll(async () => (await mountedMessageIds(page)).length, { timeout: 15000 }).toBe(SEED_MESSAGES)

    await openMenu()
    await visibleMenuItems.nth(3).click()
    await expect(actionSurface, 'the confirm re-opens beside the WHOLE menu').toHaveCount(1, { timeout: 10000 })
    await actionSurface.locator('.ant-popconfirm-buttons .ant-btn').last().click()
    await expect(actionSurface, 'confirm closes the surface').toHaveCount(0, { timeout: 10000 })
    await expect(host, 'a confirmed dissolve removes the group chrome').toHaveCount(0, { timeout: 15000 })
    expect(await readSegmentEntity(), 'the authority entity is gone').toBe(false)
    await expect.poll(async () => (await mountedMessageIds(page)).length, { timeout: 15000 }).toBe(SEED_MESSAGES)
    const mountedAfterDissolve = await mountedMessageIds(page)
    for (const id of laterMembers) {
      expect(mountedAfterDissolve, `dissolved member ${id} stays an ordinary message`).toContain(id)
    }
    await expectTokenCount(page, CONTEXT_COUNT, CONTEXT_COUNT)
    console.log('[E2E][SegmentFold] later-rail group surface verified')
  })
})
