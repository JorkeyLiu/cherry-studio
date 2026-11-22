/**
 * Message-level fold (折叠区块) — integrated E2E
 *
 * Replaces the retired topic-segment fold asset. Fold is no longer a property
 * of a message GROUP: it is a message-level authority fact (`overflow.folded`
 * on the message row, commanded by `window.api.chatDb.setTurnFolds` with stable
 * turn/ask ids) and a Renderer presentation object — one centered summary block
 * ("N turns folded · Excluded from context") whose folded rows leave the request
 * while the flow keeps their run hosts mounted, so a group's single header row
 * and its continuous rail survive the fold.
 *
 * Evidence tier: INTEGRATED —
 * - deterministic setup only for content (approved `ensureTopic` +
 *   `pasteMessagesToTopic`, plus the group authority `upsertSegment` used by the
 *   catalog/drawer specs); no test-only fold dispatch, no `topic_segments.extra`
 *   folded flag and no test-only Redux fold write;
 * - the fold / unfold gestures are REAL UI gestures: edit-mode turn cover
 *   clicks (plain + shift range) → the edit context menu item, and the folded
 *   block's own right-click menu for unfolding;
 * - requests are proven from the mock provider request log (user prompts and
 *   assistant bodies compared by content, never by Redux alone);
 * - participation counts come from the rendered `token-count-context`;
 * - navigation reveal drives the real `NAVIGATE_TO_MESSAGE` transaction through
 *   the group navigation drawer.
 *
 * Turn model — this seed MUST mirror production chat shape, because the turn
 * (message group) is the fold/selection unit in the renderer AND in Main:
 *   - one turn = one user row + every assistant row whose `askId` is that user
 *     id (`getMessageGroups`, `buildContextTurns`, Main
 *     `groupEffectiveTurnsInTx` all group exactly this way);
 *   - an assistant row with no `askId` is NOT a turn member anywhere (the
 *     renderer group builder skips it entirely), so a seed without `askId`
 *     relations cannot express whole-turn fold at all — it collapses to
 *     one selectable turn per user row.
 * With `askId` relations: SEED_TURNS turns, each carrying user + assistant, and
 * folding one turn removes exactly ONE context turn (user and assistant travel
 * together as one turn).
 *
 * Participation accounting (`contextCount` = current/max, both expressed in
 * participating turns — Main `deriveParticipatingClosureCounts` filters folded
 * turns out of `totalTurnCount` and `selectedTurnCount` alike):
 *   - seed: SEED_TURNS turns (= 5)
 *   - fold turns 3 and 4: 3 participating turns
 *   - a REAL product exchange adds exactly one turn (assistant links back with
 *     askId = userId, so it joins the sent turn instead of opening a new one)
 *
 * Stable locators only (presentation, no decorative class names):
 *   [data-testid="folded-section-collapsed"][data-folded-section-selected][data-folded-section-partial]
 *   folded-section-expand-btn / folded-section-expanded / folded-section-header /
 *   folded-section-collapse-btn / folded-section-gutter-rail /
 *   folded-section-partial-hint
 *   [data-testid="topic-segment-group"][data-segment-id] / topic-segment-label /
 *   topic-segment-count / topic-segment-rail / topic-segment-drawer-trigger /
 *   topic-segment-drawer-row
 *   [data-testid="conversation-navigation"] / conversation-nav-item-<messageId> (the ordinary resident outline)
 */
import type { Page } from '@playwright/test'

import { expect, findProductRequestAfter, getRequestSequence, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

const SEED_TURNS = 5
/** 1-indexed seeded turns folded by the range gesture in the participation case. */
const FOLD_TURNS = [3, 4] as const
const DISPLAY_LIMIT = 20
const CONTEXT_COUNT = 10

/** Seed turns: one user row + one assistant row each (production `askId` link). */
const TOTAL_TURNS = SEED_TURNS
const FOLDED_TURNS = FOLD_TURNS.length

/**
 * Participating turns after folding N turns. Folding removes turns from BOTH
 * sides of `contextCount` (Main `deriveParticipatingClosureCounts` filters
 * folded turns out of total and selected alike), so each case derives its own
 * number instead of reusing one constant.
 */
const turnsAfterFold = (foldedTurns: number): number => TOTAL_TURNS - foldedTurns

/** The two-turn participation case. */
const TURNS_WHILE_FOLDED = turnsAfterFold(FOLDED_TURNS)
const TURNS_AFTER_FOLDED_SEND = TURNS_WHILE_FOLDED + 1
/** Unfolding restores the two folded turns on top of the folded-state exchange. */
const TURNS_AFTER_UNFOLD = TURNS_AFTER_FOLDED_SEND + FOLDED_TURNS
const TURNS_AFTER_UNFOLD_SEND = TURNS_AFTER_UNFOLD + 1

/**
 * The toggle gesture. On macOS Chromium turns Control+click into the platform
 * SECONDARY click, so it never reaches the click handler that reads `ctrlKey`;
 * Command (Meta) is the modifier a macOS user actually toggles a selection
 * with, and the product accepts either (`metaKey || ctrlKey`).
 */
const TOGGLE_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control'

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

/** Stable authority ids of one seeded turn. */
function turnIds(topicId: string, turn: number): { user: string; assistant: string } {
  return {
    user: msgId(topicId, turnIndices(turn).user),
    assistant: msgId(topicId, turnIndices(turn).assistant)
  }
}

function userText(turn: number): string {
  return `fold-seed-turn-${turn}-user`
}

function assistantText(turn: number): string {
  return `fold-seed-turn-${turn}-assistant`
}

// ---------------------------------------------------------------------------
// Deterministic setup (content + group entity only — the fold is a UI gesture)
// ---------------------------------------------------------------------------

async function prepareDisplayCountAndAssistant(page: Page): Promise<string> {
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
async function seedContextCount(page: Page, contextCount: number, assistantId: string): Promise<void> {
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

/**
 * Production-shaped chat rows: every assistant row answers the user row of its
 * own turn (`askId` = that user id) and carries the producing model, exactly as
 * the product writes a real exchange. This is what makes user + assistant ONE
 * turn for selection, fold membership and context participation.
 */
function buildSeedEntries(topicId: string, assistantId: string) {
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  const createdAt = '2026-01-01T00:00:00.000Z'
  for (let turn = 1; turn <= SEED_TURNS; turn++) {
    const ids = turnIds(topicId, turn)
    for (const role of ['user', 'assistant'] as const) {
      const id = role === 'user' ? ids.user : ids.assistant
      const index = role === 'user' ? turnIndices(turn).user : turnIndices(turn).assistant
      entries.push({
        message: {
          id,
          topicId,
          role,
          createdAt,
          updatedAt: createdAt,
          status: 'success',
          blocks: [`${id}-block`],
          sortOrder: index,
          ...(role === 'assistant'
            ? {
                assistantId,
                // Production answer → question link: the turn's own user row.
                askId: ids.user,
                model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' },
                modelId: 'mock-model'
              }
            : {})
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
 * Seeds one topic through the authority path and creates ONE message group over
 * the given seeded turns, so the fold can be proven to happen INSIDE a group
 * (group chrome must survive it). The group is created before cold activation,
 * so its catalog reaches Redux only through the production joint publication
 * (`loadTopicMessagesThunk`). Nothing here writes a fold flag.
 */
async function seedTopicWithGroup(
  page: Page,
  assistantId: string,
  topicId: string,
  groupTurns: readonly number[]
): Promise<{ segmentId: string; memberIds: string[] }> {
  const name = `Message Fold Test ${topicId}`
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

  const segmentId = `${topicId}-seg-fold`
  // Group membership follows authority order: whole turns, user before answer.
  const memberIds = groupTurns.flatMap((turn) => [turnIds(topicId, turn).user, turnIds(topicId, turn).assistant])
  const persisted = await page.evaluate(
    async ({ topicId, assistantId, name, entries, segmentId, memberIds }: Record<string, any>) => {
      try {
        const api: any = (window as any).api.chatDb
        const ensured = await api.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
        const pasted = await api.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste ${JSON.stringify(pasted)}` }
        const upserted = await api.upsertSegment({
          segmentId,
          topicId,
          name: 'Fold Group',
          messageIds: memberIds,
          branchId: null
        })
        if (!upserted || upserted.ok !== true) return { ok: false, err: `upsertSegment ${JSON.stringify(upserted)}` }
        return { ok: true, count: upserted.value?.messageCount ?? null }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId, name, entries: buildSeedEntries(topicId, assistantId), segmentId, memberIds }
  )
  expect(persisted.ok, `seed failed: ${(persisted as any).err}`).toBe(true)
  expect((persisted as any).count, 'the group must own every seeded turn member').toBe(memberIds.length)
  return { segmentId, memberIds }
}

/**
 * Activates the topic and waits for its bootstrap to land: the route's
 * message-id list in the store (loaded authority rows) and the MOUNTED
 * `#messages [data-message-id]` rows. `mountedRows` defaults to the full seed,
 * which is right while nothing is folded.
 */
async function activateTopicAndWaitForBootstrap(
  page: Page,
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
// Request / count / flow readers
// ---------------------------------------------------------------------------

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

async function uiSendMessage(page: Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.fill(text)
  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
}

async function waitForAssistantResponseComplete(
  page: Page,
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

async function countAssistants(page: Page, topicId: string): Promise<number> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages.messageIdsByTopic[topicId] || []
    return msgIds.filter((id: string) => s.messages.entities[id]?.role === 'assistant').length
  }, topicId)
}

/** The TokenCount context block shows exactly `current/max`. */
async function expectTokenCount(page: Page, current: number, max: number, timeout = 15000): Promise<void> {
  await expect(page.locator('[data-testid="token-count-context"]')).toHaveText(
    new RegExp(`^\\s*${current}\\s*\\/\\s*${max}\\s*$`),
    { timeout }
  )
}

async function mountedMessageIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#messages [data-message-id]'))
      .map((el) => el.getAttribute('data-message-id'))
      .filter((id): id is string => typeof id === 'string')
  )
}

// ---------------------------------------------------------------------------
// Edit-mode turn cover gestures (the cover, not the inert message content)
// ---------------------------------------------------------------------------

async function enableEditMode(page: Page): Promise<void> {
  const enabled: boolean = await page.evaluate(() => (window as any).store.getState().editMode?.enabled === true)
  if (enabled) return
  await page.locator('[data-testid="edit-mode-toggle"]').click()
  await page.waitForFunction(() => (window as any).store.getState().editMode?.enabled === true, null, {
    timeout: 15000
  })
}

async function disableEditMode(page: Page): Promise<void> {
  const enabled: boolean = await page.evaluate(() => (window as any).store.getState().editMode?.enabled === true)
  if (!enabled) return
  await page.locator('[data-testid="edit-mode-toggle"]').click()
  await page.waitForFunction(() => (window as any).store.getState().editMode?.enabled !== true, null, {
    timeout: 15000
  })
}

/**
 * Edit-turn interaction shield geometry. In edit mode the message content is
 * native `inert` (`display: contents`) and a sibling `[data-testid=edit-turn-cover]`
 * receives pointer/hover/right-click, so gestures target the cover at a
 * truthfully hit-tested point (real `elementFromPoint`, no force, no synthetic
 * DOM click). Electron has no Playwright viewport, so window size falls back to
 * `window.innerWidth/innerHeight`, and the route keeper compensates programmatic
 * `scrollIntoViewIfNeeded` — visibility is established with genuine
 * `page.mouse.wheel` intent over `#messages` and remeasured before each click.
 */
type CoverGeom = {
  found: boolean
  turnAsk: string | null
  winW: number
  winH: number
  messageRect: { x: number; y: number; width: number; height: number } | null
  coverRect: { x: number; y: number; width: number; height: number } | null
  containerRect: { x: number; y: number; width: number; height: number } | null
  ok: boolean
  x: number
  y: number
  hitKind: string | null
  hitTurnAsk: string | null
}

async function readCoverGeom(page: Page, messageId: string): Promise<CoverGeom> {
  return page.evaluate((mid: string) => {
    const out: CoverGeom = {
      found: false,
      turnAsk: null,
      winW: window.innerWidth,
      winH: window.innerHeight,
      messageRect: null,
      coverRect: null,
      containerRect: null,
      ok: false,
      x: -1,
      y: -1,
      hitKind: null,
      hitTurnAsk: null
    }
    const msg = document.querySelector(`[data-message-id="${mid}"]`) as HTMLElement | null
    const container = document.getElementById('messages') as HTMLElement | null
    if (!msg || !container) return out
    const turn = msg.closest('[data-testid="edit-turn"]') as HTMLElement | null
    if (!turn) return out
    const cover = turn.querySelector('[data-testid="edit-turn-cover"]') as HTMLElement | null
    if (!cover) return out
    out.found = true
    out.turnAsk = turn.getAttribute('data-turn-ask')
    const mr = msg.getBoundingClientRect()
    const cr = cover.getBoundingClientRect()
    const vr = container.getBoundingClientRect()
    out.messageRect = { x: mr.left, y: mr.top, width: mr.width, height: mr.height }
    out.coverRect = { x: cr.left, y: cr.top, width: cr.width, height: cr.height }
    out.containerRect = { x: vr.left, y: vr.top, width: vr.width, height: vr.height }
    // Visible intersection of message + cover + #messages viewport.
    const ix0 = Math.max(mr.left, cr.left, vr.left)
    const iy0 = Math.max(mr.top, cr.top, vr.top)
    const ix1 = Math.min(mr.right, cr.right, vr.right)
    const iy1 = Math.min(mr.bottom, cr.bottom, vr.bottom)
    if (ix1 - ix0 < 10 || iy1 - iy0 < 10) return out
    // Floating edit action-bar occlusion zone: union of edit-* buttons + margin.
    let barTop = Infinity
    let barBottom = -Infinity
    let barLeft = Infinity
    let barRight = -Infinity
    let hasBar = false
    for (const btn of Array.from(
      document.querySelectorAll(
        '[data-testid="edit-copy-btn"],[data-testid="edit-cut-btn"],[data-testid="edit-paste-btn"],[data-testid="edit-delete-btn"],[data-testid="edit-close-btn"]'
      )
    )) {
      const b = (btn as HTMLElement).getBoundingClientRect()
      if (b.width <= 0 || b.height <= 0) continue
      hasBar = true
      barTop = Math.min(barTop, b.top)
      barBottom = Math.max(barBottom, b.bottom)
      barLeft = Math.min(barLeft, b.left)
      barRight = Math.max(barRight, b.right)
    }
    const inBar = (x: number, y: number): boolean => {
      if (!hasBar) return false
      return x >= barLeft - 6 && x <= barRight + 6 && y >= barTop - 6 && y <= barBottom + 6
    }
    const cands: Array<{ x: number; y: number }> = []
    const insetX0 = ix0 + 5
    const insetX1 = ix1 - 5
    const insetY0 = iy0 + 5
    const insetY1 = iy1 - 5
    // Prefer vertical center-away-from-top-bar: middle rows first.
    for (const fy of [0.5, 0.65, 0.35, 0.8, 0.2]) {
      for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        cands.push({ x: insetX0 + (insetX1 - insetX0) * fx, y: insetY0 + (insetY1 - insetY0) * fy })
      }
    }
    for (const c of cands) {
      if (!(c.x >= 0 && c.y >= 0 && c.x < window.innerWidth && c.y < window.innerHeight)) continue
      if (inBar(c.x, c.y)) continue
      let hit: HTMLElement | null = null
      try {
        hit = document.elementFromPoint(c.x, c.y) as HTMLElement | null
      } catch {
        continue
      }
      if (!hit) continue
      const hitCover = hit.closest('[data-testid="edit-turn-cover"]') as HTMLElement | null
      const hitTurn = hit.closest('[data-testid="edit-turn"]') as HTMLElement | null
      const hitAsk = hitTurn?.getAttribute('data-turn-ask') ?? null
      out.hitKind = hitCover ? 'cover' : hitTurn ? 'turn' : hit.tagName
      out.hitTurnAsk = hitAsk
      if ((hitCover || hitTurn) && hitAsk === out.turnAsk) {
        out.ok = true
        out.x = c.x
        out.y = c.y
        return out
      }
    }
    return out
  }, messageId)
}

async function isCoverBoxStable(page: Page, messageId: string, tol = 2): Promise<boolean> {
  const frames: Array<{ x: number; y: number } | null> = await page.evaluate(
    (mid: string) =>
      new Promise<Array<{ x: number; y: number } | null>>((resolve) => {
        const read = (): { x: number; y: number } | null => {
          const msg = document.querySelector(`[data-message-id="${mid}"]`) as HTMLElement | null
          if (!msg) return null
          const r = msg.getBoundingClientRect()
          return { x: r.left, y: r.top }
        }
        const acc: Array<{ x: number; y: number } | null> = []
        const step = (): void => {
          acc.push(read())
          if (acc.length < 3) {
            requestAnimationFrame(step)
            return
          }
          resolve(acc)
        }
        requestAnimationFrame(step)
      }),
    messageId
  )
  if (frames.some((f) => !f)) return false
  const xs = frames.map((f) => f!.x)
  const ys = frames.map((f) => f!.y)
  return Math.max(...xs) - Math.min(...xs) <= tol && Math.max(...ys) - Math.min(...ys) <= tol
}

async function wheelCoverIntoView(page: Page, messageId: string, maxSteps = 20): Promise<CoverGeom> {
  const focusMessages = async (): Promise<void> => {
    const box = await page.locator('#messages').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  }
  const frameSettle = async (): Promise<void> => {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        })
    )
  }
  await focusMessages()
  let last: CoverGeom = await readCoverGeom(page, messageId)
  for (let i = 0; i < maxSteps; i++) {
    if (last.ok && (await isCoverBoxStable(page, messageId))) return last
    // Wheel direction follows the cover center relative to the container.
    let dy = 480
    if (last.coverRect && last.containerRect) {
      const mid = (last.coverRect.y + last.coverRect.height / 2) as number
      const cTop = last.containerRect.y
      const cBottom = last.containerRect.y + last.containerRect.height
      if (last.coverRect.y + last.coverRect.height <= cTop) dy = -480
      else if (last.coverRect.y >= cBottom) dy = 480
      else dy = mid < cTop + (cBottom - cTop) / 2 ? -240 : 240
    }
    await focusMessages()
    await page.mouse.wheel(0, dy)
    await frameSettle()
    last = await readCoverGeom(page, messageId)
  }
  if (last.ok && (await isCoverBoxStable(page, messageId))) return last
  return last
}

async function messageCoverPoint(page: Page, messageId: string): Promise<{ x: number; y: number }> {
  const sel = `[data-message-id="${messageId}"]`
  const message = page.locator(sel).first()
  await message.scrollIntoViewIfNeeded()
  await expect(message).toBeVisible({ timeout: 15000 })
  const turn = page.locator(`[data-testid="edit-turn"]:has(${sel})`).first()
  await expect(turn).toBeVisible({ timeout: 15000 })
  await expect(turn.locator('[data-testid="edit-turn-cover"]').first()).toBeVisible({ timeout: 15000 })
  const settled = await wheelCoverIntoView(page, messageId)
  if (!settled.ok) {
    throw new Error(
      `[E2E] cover point not hit-testable for ${messageId}: ` +
        JSON.stringify({
          turnAsk: settled.turnAsk,
          win: { w: settled.winW, h: settled.winH },
          messageRect: settled.messageRect,
          coverRect: settled.coverRect,
          containerRect: settled.containerRect,
          hitKind: settled.hitKind,
          hitTurnAsk: settled.hitTurnAsk
        })
    )
  }
  if (!(settled.x >= 0 && settled.y >= 0 && settled.x < settled.winW && settled.y < settled.winH)) {
    throw new Error(`[E2E] cover point outside window for ${messageId}: (${settled.x},${settled.y})`)
  }
  return { x: settled.x, y: settled.y }
}

async function clickGroup(page: Page, messageId: string, modifiers?: { shift?: boolean }): Promise<void> {
  const point = await messageCoverPoint(page, messageId)
  if (modifiers?.shift) {
    await page.keyboard.down('Shift')
    try {
      await page.mouse.click(point.x, point.y)
    } finally {
      await page.keyboard.up('Shift')
    }
  } else {
    await page.mouse.click(point.x, point.y)
  }
}

async function openTurnMenu(page: Page, messageId: string): Promise<void> {
  const point = await messageCoverPoint(page, messageId)
  await page.mouse.click(point.x, point.y, { button: 'right' })
}

/** The live edit selection, from the store the edit hook owns. */
async function selectedGroups(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).store.getState().editMode.selectedGroupIds as string[])
}

/**
 * Selection assertion on STABLE turn ids (the seed's user message ids): the
 * turn, not a rendered row, is the selection unit, so this never weakens the
 * assertion to whatever happens to be in the window.
 */
async function expectSelection(page: Page, expected: string[]): Promise<void> {
  await page.waitForFunction(
    (ids: string[]) => {
      const sel: string[] = (window as any).store.getState().editMode?.selectedGroupIds ?? []
      return sel.length === ids.length && ids.every((id) => sel.includes(id))
    },
    expected,
    { timeout: 15000 }
  )
}

// ---------------------------------------------------------------------------
// Fold block helpers
// ---------------------------------------------------------------------------

const collapsedBlock = (page: Page) => page.locator('[data-testid="folded-section-collapsed"]')
const expandedBlock = (page: Page) => page.locator('[data-testid="folded-section-expanded"]')

/** The edit-mode fold menu item (fold only exists in the edit selection menu). */
function foldMenuItem(page: Page) {
  return page.getByRole('menuitem', { name: /折叠消息|Fold Selected Turns/ })
}

/** The folded block's own unfold item. */
function unfoldMenuItem(page: Page) {
  return page.getByRole('menuitem', { name: /^(取消折叠|Unfold)$/ })
}

/**
 * The block's summary sentence. Locale-agnostic on purpose: the business claim
 * is "N turns folded, and they do not count as context", not one locale's
 * wording.
 */
function summaryPattern(turns: number): RegExp {
  return new RegExp(`(?:已折叠\\s*${turns}\\s*轮对话|${turns}\\s*conversations? folded)`)
}

/**
 * Folds the given seeded turns through the real edit-mode gestures: plain click
 * on the first turn's user row, Shift click on the last one (a genuine range
 * selection over STABLE turn ids), then the selection menu's fold item.
 */
async function foldSeededTurns(page: Page, topicId: string, turns: readonly number[]): Promise<string[]> {
  const first = turnIds(topicId, turns[0]).user
  const expected = turns.map((turn) => turnIds(topicId, turn).user)
  await enableEditMode(page)
  await clickGroup(page, first)
  if (turns.length > 1) {
    await clickGroup(page, turnIds(topicId, turns[turns.length - 1]).user, { shift: true })
  }
  await expectSelection(page, expected)
  await openTurnMenu(page, turnIds(topicId, turns[turns.length - 1]).user)
  const item = foldMenuItem(page)
  await expect(item).toBeVisible({ timeout: 15000 })
  await expect(item).toBeEnabled({ timeout: 15000 })
  await item.click()
  await expect(collapsedBlock(page)).toBeVisible({ timeout: 30000 })
  return expected
}

/**
 * Right-click the collapsed block and open its ONE owned menu.
 *
 * Targeted through the block's own summary surface (a locator), never through
 * raw viewport coordinates. The block is first settled explicitly in the
 * upper part of #messages: the menu anchors at the pointer and opens
 * downward, so opening low on screen leaves it hanging behind the sticky
 * composer (the item click then hit-tests the textarea) or forces a
 * flip/reposition that never stabilizes and closes before the item click.
 * With room below, the item click needs no scroll that would disturb the
 * open menu. Still a real secondary click ON the block, no force.
 */
async function openBlockMenu(page: Page): Promise<void> {
  await collapsedBlock(page).scrollIntoViewIfNeeded()
  await page.evaluate(() => {
    const block = document.querySelector('[data-testid="folded-section-collapsed"]') as HTMLElement | null
    const scroller = document.getElementById('messages') as HTMLElement | null
    if (!block || !scroller) return
    const b = block.getBoundingClientRect()
    const s = scroller.getBoundingClientRect()
    scroller.scrollTop += b.top + b.height / 2 - (s.top + s.height * 0.3)
  })
  await page.waitForFunction(
    () => {
      const block = document.querySelector('[data-testid="folded-section-collapsed"]') as HTMLElement | null
      const scroller = document.getElementById('messages') as HTMLElement | null
      if (!block || !scroller) return false
      const b = block.getBoundingClientRect()
      const s = scroller.getBoundingClientRect()
      return b.top >= s.top && b.bottom <= s.bottom
    },
    null,
    { timeout: 15000 }
  )
  await collapsedBlock(page).locator('[data-testid="folded-section-expand-btn"]').click({ button: 'right' })
}
// ---------------------------------------------------------------------------
// Left outline (ConversationNavigation) + selection-style readers
// ---------------------------------------------------------------------------

/** Enables the ordinary resident outline (the same store flag the navigation spec uses). */
async function enableConversationNavigation(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).store.dispatch({ type: 'settings/setMessageNavigation', payload: true })
  })
  const navEnabled = await page.evaluate(() => (window as any).store.getState().settings?.messageNavigation)
  expect(navEnabled).toBe(true)
  await expect(page.getByTestId('conversation-navigation')).toBeVisible({ timeout: 20000 })
}

/** Rendered outline order: stable-ID testids in DOM order (chronological). */
async function navItemTestIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="conversation-nav-item-"]')).map(
      (el) => (el as HTMLElement).getAttribute('data-testid') || ''
    )
  )
}

/** Outline assertion with the route debounced refetch in mind (auto-retry, exact order). */
async function expectNavItems(page: Page, expected: string[], timeout = 30000): Promise<void> {
  await expect.poll(async () => await navItemTestIds(page), { timeout }).toEqual(expected)
}

const navItemId = (messageId: string): string => `conversation-nav-item-${messageId}`

/** Newest user row of a topic (a real send appends exactly one turn). */
async function latestUserId(page: Page, topicId: string): Promise<string | null> {
  return page.evaluate((id: string) => {
    const s = (window as any).store?.getState()
    const ids = (s?.messages?.messageIdsByTopic?.[id] ?? []) as string[]
    const entities = s?.messages?.entities ?? {}
    for (let k = ids.length - 1; k >= 0; k--) {
      if (entities[ids[k]]?.role === 'user') return ids[k] as string
    }
    return null
  }, topicId)
}

/**
 * Computed box-shadow of the fold shell in the given state. The claim under
 * test is visual (ring vs no ring), so the evidence is the resolved style,
 * never the data attribute or the styled-components class.
 */
async function foldShellBoxShadow(page: Page, expanded: boolean): Promise<string | null> {
  return page.evaluate((isExpanded: boolean) => {
    const shell = document.querySelector(
      `[data-testid="${isExpanded ? 'folded-section-expanded' : 'folded-section-collapsed'}"]`
    ) as HTMLElement | null
    if (!shell) return null
    return getComputedStyle(shell).boxShadow
  }, expanded)
}

/**
 * Nearest flow ancestor of a message row that paints any box-shadow (the
 * ordinary per-turn SelectionBlock when the turn is selected, nothing when
 * it is not). Walks real ancestors and reads resolved styles, so an
 * unselected inner turn reports null instead of a class name.
 */
async function rowOutlineShadow(page: Page, messageId: string): Promise<string | null> {
  return page.evaluate((mid: string) => {
    const row = document.querySelector(`#messages [data-message-id="${mid}"]`) as HTMLElement | null
    if (!row) return null
    let el = row.parentElement
    let depth = 0
    while (el && el.id !== 'messages' && depth < 15) {
      if (getComputedStyle(el).boxShadow !== 'none') return getComputedStyle(el).boxShadow
      el = el.parentElement
      depth += 1
    }
    return null
  }, messageId)
}

/**
 * Whole-block select on the collapsed cover through a genuine hit-tested
 * pointer gesture (no force, no synthetic dispatch). The block is first
 * centered explicitly in #messages so Playwright's own pre-click scroll is a
 * no-op and never re-scrolls it under the top-centered floating edit toolbar;
 * the click lands on the row's right-edge whitespace (past the summary label
 * and its partial hint, both of which paint above the cover) so the resolved
 * target is the cover itself. `toggle` holds the platform toggle modifier the
 * handler reads (ctrlKey || metaKey).
 */
async function clickSelectCover(page: Page, toggle = false): Promise<void> {
  const cover = collapsedBlock(page).locator('[data-testid="folded-section-select-cover"]')
  await collapsedBlock(page).scrollIntoViewIfNeeded()
  await page.evaluate(() => {
    const block = document.querySelector('[data-testid="folded-section-collapsed"]') as HTMLElement | null
    const scroller = document.getElementById('messages') as HTMLElement | null
    if (!block || !scroller) return
    const b = block.getBoundingClientRect()
    const s = scroller.getBoundingClientRect()
    scroller.scrollTop += b.top + b.height / 2 - (s.top + s.height * 0.6)
  })
  await page.waitForFunction(
    () => {
      const block = document.querySelector('[data-testid="folded-section-collapsed"]') as HTMLElement | null
      const scroller = document.getElementById('messages') as HTMLElement | null
      if (!block || !scroller) return false
      const b = block.getBoundingClientRect()
      const s = scroller.getBoundingClientRect()
      return b.top >= s.top && b.bottom <= s.bottom
    },
    null,
    { timeout: 15000 }
  )
  await expect(cover).toBeVisible({ timeout: 15000 })
  const box = await cover.boundingBox()
  if (!box) throw new Error('[E2E] select cover has no bounding box')
  const position = { x: Math.max(0, Math.floor(box.width - 12)), y: Math.floor(box.height / 2) }
  if (toggle) {
    await page.keyboard.down(TOGGLE_MODIFIER)
    try {
      await cover.click({ position })
    } finally {
      await page.keyboard.up(TOGGLE_MODIFIER)
    }
  } else {
    await cover.click({ position })
  }
}

test.describe('Message-level fold — 折叠区块 presentation, participation and navigation', () => {
  test('folding selected turns through the edit menu leaves the real request, drops the counts, and unfolding restores participation in place', async ({
    mainWindow
  }) => {
    test.setTimeout(480000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: real edit-mode whole-turn range selection (plain + Shift on the turn covers, stable user ids) to ONE atomic turn-level fold command; the folded rows leave the mounted flow and the real product request (mock provider log), the rendered participating-turn count drops by exactly the folded turns, the collapsed block renders its neutral summary; the left outline drops the folded turns (chronological order kept), keeps them out during browse expansion, and restores them in order on unfold; expanded edit-mode partial/full selection paints ordinary per-turn outlines with no aggregate outer ring or hint (resolved-style evidence), while collapsed keeps the whole-block selected/partial feedback; and the block menu unfolds to restore participation at the original position.'
    })
    const page = mainWindow
    await waitForAppReady(page)
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    await seedContextCount(page, CONTEXT_COUNT, liveAssistantId)
    const topicId = `msgfold-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await seedTopicWithGroup(page, liveAssistantId, topicId, [1])
    await activateTopicAndWaitForBootstrap(page, topicId, SEED_TURNS * 2)

    // Baseline: every seeded turn participates (contextCount 10 > 5 turns).
    await expectTokenCount(page, TOTAL_TURNS, TOTAL_TURNS)
    await expect(collapsedBlock(page)).toHaveCount(0)
    const seedUserIds = [1, 2, 3, 4, 5].map((turn) => turnIds(topicId, turn).user)

    const foldedTurnIds = await foldSeededTurns(page, topicId, FOLD_TURNS)
    const foldedRows = FOLD_TURNS.flatMap((turn) => [turnIds(topicId, turn).user, turnIds(topicId, turn).assistant])
    const foldedUsers = FOLD_TURNS.map((turn) => userText(turn))
    const foldedAssistants = FOLD_TURNS.map((turn) => assistantText(turn))

    // The fold is a presentation change only: one block states what it hides.
    const collapsedText = (await collapsedBlock(page).innerText()).replace(/\s+/g, ' ')
    expect(collapsedText, 'the block states how many turns it folds').toMatch(summaryPattern(FOLDED_TURNS))
    const mountedAfterFold = await mountedMessageIds(page)
    for (const id of foldedRows) {
      expect(mountedAfterFold, `folded row ${id} must leave the flow`).not.toContain(id)
    }
    // Neighbouring turns (same group, untouched) stay mounted.
    expect(mountedAfterFold).toContain(turnIds(topicId, 2).assistant)
    expect(mountedAfterFold).toContain(turnIds(topicId, 5).user)

    // A successful command clears the selection (no silent re-fold on the block).
    await expectSelection(page, [])

    // Participating turns follow the authority definition (folded turns out).
    await expectTokenCount(page, TURNS_WHILE_FOLDED, TURNS_WHILE_FOLDED)
    // The outline mounts only after the fold gestures: with the outline
    // mounted, the fold's own cover click is not hit-testable (deterministic
    // overlap in two runs), while the outline-off spec folds cleanly.
    await enableConversationNavigation(page)
    // Authority-folded turns leave the left outline; the rest keep chronological order.
    const unfoldedUserIds = [1, 2, 5].map((turn) => turnIds(topicId, turn).user)
    await expectNavItems(page, unfoldedUserIds.map(navItemId))

    // ── Real product request while folded ───────────────────────────────────
    const seqFolded = getRequestSequence()
    let assistantCount = await countAssistants(page, topicId)
    await uiSendMessage(page, 'fold request turn')
    assistantCount = await waitForAssistantResponseComplete(page, topicId, assistantCount)

    const foldedReq = findProductRequestAfter(seqFolded)
    expect(foldedReq, 'a real product request must reach the mock provider while folded').not.toBeNull()
    const foldedPrompts = getRequestUserPrompts(foldedReq)
    expect(foldedPrompts, 'request must exclude the folded turns and keep chronological order').toEqual([
      userText(1),
      userText(2),
      userText(5),
      'fold request turn'
    ])
    for (const prompt of foldedUsers) expect(foldedPrompts).not.toContain(prompt)
    const foldedAssistantTexts = getRequestAssistantTexts(foldedReq)
    for (const body of foldedAssistants) {
      expect(foldedAssistantTexts, 'folded assistant body must not leak into the request').not.toContain(body)
    }
    await expectTokenCount(page, TURNS_AFTER_FOLDED_SEND, TURNS_AFTER_FOLDED_SEND)
    const foldedSendUserId = await latestUserId(page, topicId)
    expect(foldedSendUserId, 'the folded-state exchange appends one user turn').not.toBeNull()

    // ── Browse the block + edit-mode per-turn selection (resolved-style evidence) ──
    // Collapsed whole-block selection paints the ordinary full ring: the same
    // ring the selected turn range uses. Read it as resolved style — it is the
    // live reference for the inner outlines below.
    await collapsedBlock(page).locator('[data-testid="folded-section-select-cover"]').click()
    await expectSelection(page, foldedTurnIds)
    await expect(collapsedBlock(page)).toHaveAttribute('data-folded-section-selected', 'true', { timeout: 15000 })
    await expect(page.locator('[data-testid="folded-section-partial-hint"]')).toHaveCount(0)
    const fullRing = await foldShellBoxShadow(page, false)
    expect(fullRing, 'collapsed full selection paints the ordinary ring').not.toBeNull()
    expect(fullRing).not.toBe('none')
    // Back to no selection through the proven toggle gesture.
    await page.keyboard.down(TOGGLE_MODIFIER)
    try {
      await collapsedBlock(page).locator('[data-testid="folded-section-select-cover"]').click()
    } finally {
      await page.keyboard.up(TOGGLE_MODIFIER)
    }
    await expectSelection(page, [])

    // Browse (expand) is a normal-mode gesture: leave edit mode first, like the
    // navigation-reveal case. Browsing is not unfolding.
    await disableEditMode(page)
    await collapsedBlock(page).locator('[data-testid="folded-section-expand-btn"]').click()
    await expect(expandedBlock(page)).toBeVisible({ timeout: 30000 })
    // Folded turns stay out of the outline while browsing, and participation
    // is untouched by the browse.
    await expectNavItems(page, [...unfoldedUserIds, foldedSendUserId as string].map(navItemId))
    await expectTokenCount(page, TURNS_AFTER_FOLDED_SEND, TURNS_AFTER_FOLDED_SEND)

    // Edit-mode inner selection: one inner turn cover (partial selection of the block).
    await enableEditMode(page)
    await clickGroup(page, turnIds(topicId, 3).user)
    await expectSelection(page, [turnIds(topicId, 3).user])
    // No aggregate outer ring and no partial hint on the expanded shell ...
    expect(await foldShellBoxShadow(page, true), 'expanded shell carries no aggregate ring').toBe('none')
    await expect(page.locator('[data-testid="folded-section-partial-hint"]')).toHaveCount(0)
    // ... while the selected inner turn shows the ordinary per-turn outline
    // (identical resolved ring to the collapsed whole-block reference) and the
    // unselected inner turn paints nothing.
    expect(await rowOutlineShadow(page, turnIds(topicId, 3).user)).toBe(fullRing)
    expect(await rowOutlineShadow(page, turnIds(topicId, 3).assistant)).toBe(fullRing)
    expect(await rowOutlineShadow(page, turnIds(topicId, 4).user)).toBeNull()
    expect(await rowOutlineShadow(page, turnIds(topicId, 4).assistant)).toBeNull()

    // Collapsing a partial selection keeps the partial whole-block feedback: a
    // visibly weaker ring (never the full ring, never none) plus the stated
    // selected/total count.
    await expandedBlock(page).locator('[data-testid="folded-section-expand-label"]').click()
    await expect(collapsedBlock(page)).toBeVisible({ timeout: 30000 })
    await expectSelection(page, [turnIds(topicId, 3).user])
    await expect(collapsedBlock(page)).toHaveAttribute('data-folded-section-partial', 'true', { timeout: 15000 })
    const partialRing = await foldShellBoxShadow(page, false)
    expect(partialRing, 'collapsed partial selection keeps a weaker ring').not.toBeNull()
    expect(partialRing).not.toBe('none')
    expect(partialRing, 'partial ring must not impersonate the full ring').not.toBe(fullRing)
    const partialHint = page.locator('[data-testid="folded-section-partial-hint"]')
    await expect(partialHint).toBeVisible({ timeout: 15000 })
    await expect(partialHint).toHaveText(/1.*2/, { timeout: 15000 })

    // Plain block click replaces the partial selection with the whole block;
    // clearing from the full state reuses the proven toggle cover gesture.
    await clickSelectCover(page)
    await expectSelection(page, foldedTurnIds)
    // Clearing clicks the same cover with the toggle modifier held.
    await clickSelectCover(page, true)
    await expectSelection(page, [])

    // Full inner selection through a clean browse: expand in normal mode,
    // re-enter edit mode, then plain + Shift on the inner covers.
    await disableEditMode(page)
    await collapsedBlock(page).locator('[data-testid="folded-section-expand-btn"]').click()
    await expect(expandedBlock(page)).toBeVisible({ timeout: 30000 })
    await enableEditMode(page)
    await clickGroup(page, turnIds(topicId, 3).user)
    await clickGroup(page, turnIds(topicId, 4).user, { shift: true })
    await expectSelection(page, foldedTurnIds)
    // Fully selected expanded block: ordinary per-turn outlines on every inner
    // turn, still no aggregate outer ring and no hint.
    expect(await foldShellBoxShadow(page, true), 'expanded full selection carries no aggregate ring').toBe('none')
    await expect(page.locator('[data-testid="folded-section-partial-hint"]')).toHaveCount(0)
    for (const row of foldedRows) {
      expect(await rowOutlineShadow(page, row), `inner row ${row} shows the ordinary per-turn outline`).toBe(fullRing)
    }

    // Collapsing a full selection keeps the selection; clearing leaves the
    // existing unfold preconditions (collapsed, no selection).
    await expandedBlock(page).locator('[data-testid="folded-section-expand-label"]').click()
    await expect(collapsedBlock(page)).toBeVisible({ timeout: 30000 })
    await expectSelection(page, foldedTurnIds)
    // Clearing clicks the same cover with the toggle modifier held.
    await clickSelectCover(page, true)
    await expectSelection(page, [])

    // ── Real unfold gesture on the block's own menu ────────────────────────
    await openBlockMenu(page)
    const unfold = unfoldMenuItem(page)
    await expect(unfold).toBeVisible({ timeout: 15000 })
    // The block owns exactly ONE menu: no second (message list) menu appears.
    await expect(page.locator('.ant-dropdown:not(.ant-dropdown-hidden)')).toHaveCount(1)
    // State-correct browse item: a collapsed block offers "expand"/"展开查看"
    // (`chat.expand_view`; "收起浏览" is the EXPANDED block's item) alongside the
    // unfold action — the block owns its own state-aware menu.
    await expect(page.getByRole('menuitem', { name: /^(展开查看|Expand view)$/ })).toBeVisible({
      timeout: 15000
    })
    await unfold.click()
    await expect(collapsedBlock(page)).toHaveCount(0, { timeout: 30000 })
    expect(await mountedMessageIds(page), 'unfolded rows return to the flow').toEqual(
      expect.arrayContaining(foldedRows)
    )
    await expectTokenCount(page, TURNS_AFTER_UNFOLD, TURNS_AFTER_UNFOLD)
    // Unfolded turns rejoin the outline in chronological order, at their
    // original positions ahead of the folded-state exchange.
    await expectNavItems(page, [...seedUserIds, foldedSendUserId as string].map(navItemId))

    // ── Participation restored in the real request (original position) ─────
    const seqUnfolded = getRequestSequence()
    assistantCount = await countAssistants(page, topicId)
    await uiSendMessage(page, 'unfold request turn')
    assistantCount = await waitForAssistantResponseComplete(page, topicId, assistantCount)

    const unfoldedReq = findProductRequestAfter(seqUnfolded)
    expect(unfoldedReq, 'a real product request must reach the mock provider after unfolding').not.toBeNull()
    expect(getRequestUserPrompts(unfoldedReq), 'unfolded turns participate at their original position').toEqual([
      userText(1),
      userText(2),
      userText(3),
      userText(4),
      userText(5),
      'fold request turn',
      'unfold request turn'
    ])
    const unfoldedAssistantTexts = getRequestAssistantTexts(unfoldedReq)
    for (const body of foldedAssistants) expect(unfoldedAssistantTexts).toContain(body)
    await expectTokenCount(page, TURNS_AFTER_UNFOLD_SEND, TURNS_AFTER_UNFOLD_SEND)
    expect(assistantCount).toBeGreaterThan(SEED_TURNS)
    expect(foldedTurnIds.length).toBe(FOLDED_TURNS)
    console.log('[E2E][MessageFold] fold exclusion + unfold restore verified against the request log')
  })

  test('a partially folded group keeps its single header and continuous rail, and the block selects as one object without writing a fold', async ({
    mainWindow
  }) => {
    test.setTimeout(300000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: one message group spans two whole turns; folding only the FIRST turn through real gestures leaves the group chrome mounted exactly once (one header row, one continuous rail, unchanged route-qualified turn count) with its unfolded member still in the flow, and the collapsed block is one selection object in edit mode (plain = whole block, ctrl = toggle, right-click = claim the block and restore the block selection) — none of those gestures changes the fold.'
    })
    const page = mainWindow
    await waitForAppReady(page)
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    await seedContextCount(page, CONTEXT_COUNT, liveAssistantId)
    const topicId = `msgfoldgrp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { segmentId, memberIds } = await seedTopicWithGroup(page, liveAssistantId, topicId, [3, 4])
    await activateTopicAndWaitForBootstrap(page, topicId, SEED_TURNS * 2)

    const groupHost = page.locator(`#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`)
    await expect(groupHost).toHaveCount(1, { timeout: 15000 })

    // Fold ONLY the group's first turn: the group stays half-visible.
    await foldSeededTurns(page, topicId, [3])
    await expectSelection(page, [])
    const foldedRowIds = [turnIds(topicId, 3).user, turnIds(topicId, 3).assistant]
    const survivingRowIds = [turnIds(topicId, 4).user, turnIds(topicId, 4).assistant]

    // Group chrome survives the fold exactly once: one host, one rail, one
    // header, and the route-qualified turn count still covers every turn
    // (the 4 seeded messages form 2 turns on this route).
    await expect(
      page.locator(`#messages [data-testid="topic-segment-group"][data-segment-id="${segmentId}"]`),
      'the group host must stay mounted once'
    ).toHaveCount(1)
    await expect(
      page.locator(`#messages [data-testid="topic-segment-rail"][data-segment-id="${segmentId}"]`),
      'the group keeps ONE continuous rail'
    ).toHaveCount(1)
    await expect(groupHost.locator('[data-testid="topic-segment-label"]').first()).toBeVisible({ timeout: 15000 })
    await expect(groupHost.locator('[data-testid="topic-segment-count"]').first()).toHaveText(/2/, { timeout: 15000 })
    const mountedAfterPartialFold = await mountedMessageIds(page)
    for (const id of foldedRowIds) expect(mountedAfterPartialFold).not.toContain(id)
    for (const id of survivingRowIds) {
      expect(mountedAfterPartialFold, `unfolded group member ${id} must stay in the flow`).toContain(id)
    }
    expect(memberIds.length).toBe(4)
    const blockText = (await collapsedBlock(page).innerText()).replace(/\s+/g, ' ')
    expect(blockText).toMatch(summaryPattern(1))

    // ── Block selection through the real edit-selection wiring ─────────────
    // The collapsed selection surface is the row's own whitespace cover: the
    // rail and the summary text keep the browse toggle in every state and
    // mode and never select.
    const turnId = turnIds(topicId, 3).user
    await clickSelectCover(page)
    await expectSelection(page, [turnId])
    await expect(collapsedBlock(page)).toHaveAttribute('data-folded-section-selected', 'true', { timeout: 15000 })
    // Selecting never expands: the block is still the collapsed browse object.
    await expect(collapsedBlock(page)).toBeVisible()
    await expect(expandedBlock(page)).toHaveCount(0)

    // Toggle removes the block from the selection. The modifier is the one the
    // platform actually delivers (Command on macOS, where Control+click is the
    // OS secondary click and never reaches the click handler).
    await clickSelectCover(page, true)
    await expectSelection(page, [])
    await expect(collapsedBlock(page)).toHaveAttribute('data-folded-section-selected', 'false', { timeout: 15000 })

    // Right-click claims the block's ONE menu and restores the block selection.
    await openBlockMenu(page)
    await expect(unfoldMenuItem(page)).toBeVisible({ timeout: 15000 })
    await expect(page.locator('.ant-dropdown:not(.ant-dropdown-hidden)'), 'exactly one menu').toHaveCount(1)
    await expectSelection(page, [turnId])
    await page.keyboard.press('Escape')
    await expect(unfoldMenuItem(page)).toBeHidden({ timeout: 15000 })

    // No selection gesture wrote a fold: the same rows are still hidden, and
    // the unfolded group member is still in the flow.
    await expect(collapsedBlock(page)).toBeVisible()
    const mountedBeforeUnfold = await mountedMessageIds(page)
    for (const id of foldedRowIds) expect(mountedBeforeUnfold).not.toContain(id)
    for (const id of survivingRowIds) {
      expect(mountedBeforeUnfold, `unfolded group member ${id} must still be in the flow`).toContain(id)
    }
    // One folded turn: 5 − 1 participating turns.
    await expectTokenCount(page, turnsAfterFold(1), turnsAfterFold(1))
    console.log('[E2E][MessageFold] partial group fold keeps one header + one rail; block selects as one object')
  })

  test('navigating to a folded message lands on its collapsed marker without expanding', async ({ mainWindow }) => {
    test.setTimeout(300000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: fold one whole turn, then navigate through the real group drawer row (NAVIGATE_TO_MESSAGE into a folded target). The existing navigation transaction reports the target as fold-hidden and positions its collapsed marker in the viewport without opening the block; only a manual expand mounts `#message-<id>`. Collapsing the block again leaves participation unchanged.'
    })
    const page = mainWindow
    await waitForAppReady(page)
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    await seedContextCount(page, CONTEXT_COUNT, liveAssistantId)
    const topicId = `msgfoldnav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { segmentId } = await seedTopicWithGroup(page, liveAssistantId, topicId, [3])
    await activateTopicAndWaitForBootstrap(page, topicId, SEED_TURNS * 2)

    await foldSeededTurns(page, topicId, [3])
    const folded = turnIds(topicId, 3)
    // One folded turn: 5 − 1 participating turns.
    await expectTokenCount(page, turnsAfterFold(1), turnsAfterFold(1))
    // Browse toggles are normal-mode gestures: leave edit mode first.
    await disableEditMode(page)

    // Real drawer row (the group's navigation surface) → NAVIGATE_TO_MESSAGE
    // with the group's first message, which is folded.
    const trigger = page.locator('[data-testid="topic-segment-drawer-trigger"]').first()
    await trigger.waitFor({ state: 'visible', timeout: 15000 })
    await trigger.hover()
    await trigger.click()
    const row = page.locator('[data-testid="topic-segment-drawer-row"]:has-text("Fold Group")').first()
    await expect(row).toBeVisible({ timeout: 15000 })
    await row.click()

    // Marker-only reveal: the block stays collapsed and the transaction lands
    // on the collapsed marker — never an auto-expand, never the hidden row.
    await expect(expandedBlock(page), 'navigation never auto-expands the block').toHaveCount(0)
    await expect(collapsedBlock(page), 'the collapsed marker is the reveal target').toBeVisible({ timeout: 30000 })
    await expect(collapsedBlock(page), 'the marker settles inside the viewport').toBeInViewport({ timeout: 15000 })
    await expect(
      page.locator(`#messages [data-message-id="${folded.user}"]`),
      'the hidden row stays unmounted while collapsed'
    ).toHaveCount(0)
    expect(segmentId).toContain('-seg-fold')

    // Only a manual expand mounts the row.
    await collapsedBlock(page).locator('[data-testid="folded-section-expand-btn"]').click()
    await expect(expandedBlock(page)).toBeVisible({ timeout: 30000 })
    const target = page.locator(`#messages [data-message-id="${folded.user}"]`)
    await expect(target, 'the manually revealed folded row must mount into the flow').toBeAttached({ timeout: 30000 })
    await expect(target, 'the manually revealed folded row must be visible').toBeVisible({ timeout: 15000 })
    await expect(page.locator(`#message-${folded.user}`)).toBeInViewport({ timeout: 15000 })

    // Browsing the block back to collapsed does not restore context. The
    // browse toggle is the summary label in both states (the rail keeps the
    // same toggle); there is no separate collapse button.
    await expandedBlock(page).locator('[data-testid="folded-section-expand-label"]').click()
    // Browsing never restores participation: still 5 − 1.
    await expectTokenCount(page, turnsAfterFold(1), turnsAfterFold(1))
    console.log('[E2E][MessageFold] navigation reveal settled on the collapsed marker without expanding')
  })
})
