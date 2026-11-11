/**
 * Topic list ordering — real E2E verification.
 *
 * The default order of a topic list is "by update time" (`updated`): every
 * non-pinned topic is positioned by the REAL INSTANT of its latest message
 * `createdAt` as read from Main over the WHOLE topic (every route, branch tips
 * included), never by the topic's own `createdAt`/`updatedAt` metadata. A topic
 * that never received a message falls back to its own `createdAt` for ordering
 * only. Pinned topics always stay on top and keep their own relative order.
 *
 * Evidence tiers:
 *   - A INTEGRATED: fresh assistant (created through the product defaults) is
 *     already on `updated` and the topic context menu reports that selection;
 *     one real `Sort by update time` click re-sorts the non-pinned topics by
 *     their full-route latest message instant even though their metadata
 *     contradicts it (2030 timestamps on the oldest topic, an unopened branch
 *     tip holding the newest ordinary instant, a no-message topic via its
 *     `createdAt`); a real header-imported topic (null `createdAt`/`updatedAt`
 *     metadata, its own message instants) joins the authoritative order
 *     instead of staying at the head.
 *   - B INTEGRATED: under `updated` a REAL pointer drag reorders the list
 *     freely and does not disable the policy; a real metadata write (a
 *     context-menu rename through PromptPopup) and a real topic switch never
 *     move anything; one real textarea/Enter send moves ONLY the written topic
 *     to the ordinary head (others keep their relative order, the mock provider
 *     served it); a real drag then leaves that topic off the head, and a real
 *     inline edit of the just-sent turn advances the message `updatedAt` while
 *     `createdAt`, the Main-authority latest instant and the order stay — so an
 *     implementation that promoted a topic on a message write would move it and
 *     fail.
 *     returns the assistant to the explicit `manual` order (pinned first, the
 *     menu reports the creation entry); a real send while `manual` never moves
 *     a topic; re-activating "by update time" restores the continuous policy,
 *     so the next real send in a low topic moves it to the ordinary head, and
 *     deleting that just-sent turn drops the topic back to its real previous
 *     instant (single-topic fallback, the pin and every other topic unmoved).
 *
 * Seeding uses approved Main APIs only (`assistants/addTopic` projection plus
 * `chatDb.ensureTopic/appendMessage/createBranch`); no raw SQLite writes, no
 * renderer service mock. The mock provider is the only external endpoint.
 *
 * Out of scope by design (covered elsewhere, never re-proved here):
 *   - application-level persistence/relaunch: generic Redux + SQLite
 *     persistence is not this feature's behavior, and the ordering policy is
 *     asserted through the product surfaces above;
 *   - source-format validation of the imported payload — Main and service
 *     unit/integration suites own it;
 *   - one-time default initialization for assistants that never chose an order
 *     (idempotence, read failure retry, drag/choice during the read, epoch
 *     guard) — service unit tests own that low-level protection.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { Page } from '@playwright/test'

import {
  clearRequestLog,
  expect,
  findProductRequestAfter,
  getRequestSequence,
  test
} from '../../fixtures/electron.fixture'
import { cmContent, replaceEditorContent } from '../../utils/message-editor'

// ---------------------------------------------------------------------------
// Deterministic instants. Topic metadata deliberately CONTRADICTS the
// authoritative message instants so a metadata-driven order must differ.
// ---------------------------------------------------------------------------

const AT = {
  old: '2023-12-31T00:00:00.000Z',
  firstUser: '2024-01-01T00:00:00.000Z',
  firstReply: '2024-01-01T00:10:00.000Z',
  mid: '2024-02-01T05:00:00.000Z',
  branchMain: '2024-03-01T00:00:00.000Z',
  branchTip: '2024-06-01T00:00:00.000Z',
  emptyCreatedAt: '2024-05-01T00:00:00.000Z',
  pinned: '2024-07-01T00:00:00.000Z',
  imported: '2024-04-01T00:00:00.000Z',
  /** Metadata far beyond "now": an implementation reading it would rank this first. */
  conflictingMetadata: '2030-01-01T00:00:00.000Z'
} as const

const SORT_TITLE = /^(排序方式|Sort by)$/
const BY_CREATED = /^(按创建时间|By creation time)$/
const BY_UPDATED = /^(按更新时间|By update time)$/
const RENAME_ITEM = /^(编辑话题名|Edit Name)$/

// ---------------------------------------------------------------------------
// Shared helpers (spec-local only — never fixture-global)
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function liveAssistantId(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    const s = (window as any).store.getState()
    return (s.assistants?.assistants?.[0]?.id as string | undefined) ?? null
  })
  expect(id, 'a live assistant must exist').toBeTruthy()
  return id as string
}

/** Redux topic ids of one assistant, in projected (list) order. */
async function reduxTopicIds(page: Page, assistantId?: string): Promise<string[]> {
  return page.evaluate((aid: string | null) => {
    const s = (window as any).store.getState()
    const lists = s.assistants?.assistants ?? []
    const assistant = aid ? lists.find((a: any) => a.id === aid) : lists[0]
    return ((assistant?.topics ?? []) as any[]).map((topic) => topic.id) as string[]
  }, assistantId ?? null)
}

async function topicOrderMode(page: Page, assistantId?: string): Promise<string | null> {
  return page.evaluate((aid: string | null) => {
    const s = (window as any).store.getState()
    const lists = s.assistants?.assistants ?? []
    const assistant = aid ? lists.find((a: any) => a.id === aid) : lists[0]
    return ((assistant?.topicOrderMode as string | undefined) ?? null) as string | null
  }, assistantId ?? null)
}

async function findTopicRedux(page: Page, topicId: string): Promise<any | null> {
  return page.evaluate((id: string) => {
    const s = (window as any).store.getState()
    for (const assistant of s.assistants?.assistants ?? []) {
      const topic = (assistant.topics ?? []).find((entry: any) => entry.id === id)
      if (topic) return topic
    }
    return null
  }, topicId)
}

/** Real DOM order of the rendered topic rows (the virtualizer renders in list order). */
async function domTopicIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="topic-item"]')).map(
      (element) => element.getAttribute('data-topic-id') ?? ''
    )
  )
}

async function expectTopicOrder(page: Page, expected: string[], assistantId?: string): Promise<void> {
  await expect.poll(() => reduxTopicIds(page, assistantId), { timeout: 20000 }).toEqual(expected)
}

async function expectDomTopicOrder(page: Page, expected: string[]): Promise<void> {
  await expect(page.locator('[data-testid="topic-item"]')).toHaveCount(expected.length, { timeout: 20000 })
  await expect.poll(() => domTopicIds(page), { timeout: 20000 }).toEqual(expected)
}

/** True once the projection holds exactly this order — the click's product effect. */
function orderMatches(page: Page, expected: string[], assistantId?: string): () => Promise<boolean> {
  return async () => JSON.stringify(await reduxTopicIds(page, assistantId)) === JSON.stringify(expected)
}

async function dismissMenus(page: Page): Promise<void> {
  // Ant keeps hidden menu DOM alive; the oracle is zero VISIBLE menus. A real
  // outside click closes the dropdown AND its open submenu popup (focus-based
  // Escape handling is unreliable for submenu portals).
  if ((await page.locator('.ant-dropdown-menu:visible').count()) === 0) return
  const input = page.locator('.inputbar textarea, textarea[placeholder]').first()
  try {
    if ((await input.count()) > 0) {
      await input.click({ timeout: 5000 })
    } else {
      await page.locator('#messages').click({ position: { x: 8, y: 8 }, timeout: 5000 })
    }
  } catch {
    try {
      await page.keyboard.press('Escape')
    } catch {}
  }
  await expect(page.locator('.ant-dropdown-menu:visible')).toHaveCount(0, { timeout: 10000 })
}

function sortSubmenuTitle(page: Page) {
  return page
    .locator('.ant-dropdown-menu:visible .ant-dropdown-menu-submenu-title')
    .filter({ hasText: SORT_TITLE })
    .first()
}

/** Visible ordering leaves, scoped to the open popup so a stale one never matches. */
function sortEntries(page: Page) {
  return page.locator('.ant-dropdown-menu:visible .ant-dropdown-menu-item')
}

/** Real right-click on a topic row; the ordering submenu must be offered. */
async function openTopicMenu(page: Page, topicId: string): Promise<void> {
  await dismissMenus(page)
  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await item.scrollIntoViewIfNeeded()
  await expect(item).toBeVisible({ timeout: 15000 })
  await item.click({ button: 'right' })
  await sortSubmenuTitle(page).waitFor({ state: 'visible', timeout: 10000 })
}

/**
 * Real opening of the "Sort by" submenu. A real click on its title is tried first
 * (rc-menu toggles a popup submenu on title click) because it does not depend on
 * the pointer staying on the title across a popup re-layout; hover + ArrowRight
 * is the fallback.
 */
async function openSortSubmenu(page: Page): Promise<void> {
  const title = sortSubmenuTitle(page)
  await title.waitFor({ state: 'visible', timeout: 10000 })
  const entries = sortEntries(page).filter({ hasText: BY_UPDATED }).first()
  await title.click()
  const openedByClick = await entries
    .waitFor({ state: 'visible', timeout: 6000 })
    .then(() => true)
    .catch(() => false)
  if (openedByClick) return
  await title.hover()
  try {
    await title.focus()
  } catch {}
  await page.keyboard.press('ArrowRight')
  await entries.waitFor({ state: 'visible', timeout: 6000 })
}

/** The ordering menu reports the order the list is actually kept in. */
async function expectSelectedSort(page: Page, label: RegExp): Promise<void> {
  const selected = page.locator('.ant-dropdown-menu-item-selected:visible').filter({ hasText: label })
  await expect(selected.first()).toBeVisible({ timeout: 10000 })
}

/**
 * Real pointer click on one ordering entry, confirmed by the product effect.
 * Why the hit test: the submenu popup is a nested portal; Playwright's
 * scroll-into-view / stability retry can drop the hover that keeps it open. So
 * the click is placed at the leaf's settled box only after a hit test proves the
 * popup is on top at that point. Whether the interaction landed is judged by the
 * ordering it produced, never by popup chrome.
 */
async function tryClickSortEntry(page: Page, label: RegExp, applied: () => Promise<boolean>): Promise<boolean> {
  const entry = sortEntries(page).filter({ hasText: label }).first()
  if (!(await entry.isVisible().catch(() => false))) {
    console.log('[E2E] ordering entry is not visible')
    return false
  }
  const box = await entry.boundingBox({ timeout: 3000 }).catch(() => null)
  if (!box) {
    console.log('[E2E] ordering entry has no box')
    return false
  }
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  let hit: { text: string | null; visibleMenus: number } = { text: null, visibleMenus: 0 }
  for (let probe = 0; probe < 5; probe += 1) {
    hit = await page.evaluate(({ x, y }: { x: number; y: number }) => {
      const element = document.elementFromPoint(x, y) as HTMLElement | null
      const item = element?.closest('.ant-dropdown-menu-item') as HTMLElement | null
      return {
        text: item?.textContent?.trim() ?? null,
        visibleMenus: document.querySelectorAll('.ant-dropdown-menu').length
      }
    }, point)
    if (hit.text && label.test(hit.text)) break
    await page.waitForTimeout(120)
  }
  if (!hit.text || !label.test(hit.text)) {
    console.log(`[E2E] ordering entry hit mismatch ${JSON.stringify({ point, hit })}`)
    return false
  }
  await page.mouse.click(point.x, point.y)
  // The product effect, not the popup chrome, decides whether the click landed.
  for (let wait = 0; wait < 40; wait += 1) {
    if (await applied()) return true
    await page.waitForTimeout(250)
  }
  return false
}
/**
 * Real right-click + ordering-entry click, retried from a fresh menu when the
 * expected product effect did not appear (a real menu interaction can be lost to
 * popup re-layout, and a repeated selection is idempotent).
 */
async function chooseSortMode(
  page: Page,
  topicId: string,
  label: RegExp,
  applied: () => Promise<boolean>
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await openTopicMenu(page, topicId)
    await openSortSubmenu(page)
    if (await tryClickSortEntry(page, label, applied)) return
    console.log(`[E2E] ordering entry click attempt ${attempt + 1} did not land; reopening the menu`)
  }
  throw new Error(`the ordering entry ${label} could not be activated for ${topicId}`)
}

// ---------------------------- Main-authority seed ---------------------------

interface SeedMessage {
  key: string
  role: 'user' | 'assistant'
  at: string
}

interface SeedTopic {
  topicId: string
  name: string
  createdAt?: string
  updatedAt?: string
  pinned?: boolean
  /** false = the row already exists in the projection (the fresh profile topic). */
  project?: boolean
  /** Main-route messages, in authority order. */
  messages?: SeedMessage[]
  /** One unopened branch whose tip can be NEWER than the main route. */
  branch?: { name: string; anchorKey: string; messages: SeedMessage[] }
}

/**
 * Seeds topics through the approved product/Main surfaces only: the
 * `assistants/addTopic` projection + `chatDb.ensureTopic/appendMessage/
 * createBranch`. Instants come from the plan, so Main's authoritative
 * "latest message instant" is fully controlled.
 */
async function seedTopics(page: Page, assistantId: string, plan: SeedTopic[]): Promise<void> {
  const result = await page.evaluate(
    async ({ assistantId: aid, topics }: { assistantId: string; topics: unknown }) => {
      try {
        const store = (window as any).store
        const api = (window as any).api.chatDb
        type AppendOutcome = { ok: true; id: string } | { ok: false; err: string }
        const put = async (
          topicId: string,
          key: string,
          message: Record<string, unknown>,
          branchId?: string | null
        ): Promise<AppendOutcome> => {
          const id = `${topicId}-${key}`
          const body: Record<string, unknown> = {
            topicId,
            message: { id, topicId, ...message },
            blocks: [
              {
                id: `${id}-main`,
                messageId: id,
                type: 'main_text',
                content: message.content,
                status: 'success',
                createdAt: message.createdAt
              }
            ]
          }
          if (branchId) body.branchId = branchId
          const res = await api.appendMessage(body)
          if (res && res.ok === true) return { ok: true, id }
          return { ok: false, err: `append ${key}: ${JSON.stringify(res)}` }
        }
        for (const topic of topics as Array<any>) {
          if (topic.project === false) continue
          store.dispatch({
            type: 'assistants/addTopic',
            payload: {
              assistantId: aid,
              topic: {
                id: topic.topicId,
                assistantId: aid,
                name: topic.name,
                createdAt: topic.createdAt,
                updatedAt: topic.updatedAt,
                ...(topic.pinned ? { pinned: true } : {})
              }
            }
          })
        }
        for (const topic of topics as Array<any>) {
          const ensured = await api.ensureTopic({ topicId: topic.topicId, assistantId: aid, name: topic.name })
          if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
          let anchorId: string | null = null
          for (const message of topic.messages ?? []) {
            const outcome = await put(
              topic.topicId,
              message.key,
              {
                role: message.role,
                content: `${message.key}`,
                status: 'success',
                createdAt: message.at,
                updatedAt: message.at
              },
              null
            )
            if (!outcome.ok) return { ok: false, err: outcome.err }
            if (!anchorId) anchorId = outcome.id
          }
          if (topic.branch) {
            const created = await api.createBranch({
              topicId: topic.topicId,
              anchorMessageId: anchorId,
              name: topic.branch.name
            })
            if (!created || created.ok !== true) return { ok: false, err: `createBranch ${JSON.stringify(created)}` }
            const branchId = (created.value as any).branch.id as string
            for (const message of topic.branch.messages) {
              const outcome = await put(
                topic.topicId,
                message.key,
                {
                  role: message.role,
                  content: `${message.key}`,
                  status: 'success',
                  createdAt: message.at,
                  updatedAt: message.at
                },
                branchId
              )
              if (!outcome.ok) return { ok: false, err: outcome.err }
            }
          }
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, err: error instanceof Error ? error.message : String(error) }
      }
    },
    { assistantId, topics: plan }
  )
  expect(result.ok, `Main-authority seed failed: ${JSON.stringify(result)}`).toBe(true)
}

/** The fresh profile's own first topic: exists in Main and in the projection. */
async function seedExistingTopic(
  page: Page,
  assistantId: string,
  topicId: string,
  messages: SeedMessage[]
): Promise<void> {
  const name = (await findTopicRedux(page, topicId))?.name as string
  await seedTopics(page, assistantId, [{ topicId, name, project: false, messages }])
}

// ------------------------------- Sending ----------------------------------

async function activateTopic(page: Page, topicId: string): Promise<void> {
  await dismissMenus(page)
  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await item.scrollIntoViewIfNeeded()
  await expect(item).toBeVisible({ timeout: 15000 })
  await item.click()
  await page.waitForFunction(
    (id: string) => {
      const s = (window as any).store.getState()
      return s.runtime?.chat?.activeTopic?.id === id
    },
    topicId,
    { timeout: 20000 }
  )
}

async function assistantCount(page: Page, topicId: string): Promise<number> {
  return page.evaluate((id: string) => {
    const s = (window as any).store.getState()
    const ids: string[] = s.messages?.messageIdsByTopic?.[id] ?? []
    let count = 0
    for (const messageId of ids) {
      const message = s.messages.entities?.[messageId]
      if (message?.role === 'assistant') count++
    }
    return count
  }, topicId)
}

/** Real textarea fill + Enter through the production inputbar send path. */
async function uiSendMessage(page: Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()
  await page.evaluate(
    ({ selector, value }: { selector: string; value: string }) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement | null
      if (!el) throw new Error('Textarea not found')
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSetter) throw new Error('No native textarea setter')
      nativeSetter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { selector: '.inputbar textarea, textarea[placeholder]', value: text }
  )
  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
}

/** Waits for a NEW assistant reply in the topic to reach a terminal state. */
async function waitForReply(page: Page, topicId: string, previousAssistantCount: number): Promise<void> {
  await page.waitForFunction(
    ({ topicId: id, previousCount }: { topicId: string; previousCount: number }) => {
      const s = (window as any).store?.getState()
      if (!s || s.messages?.loadingByTopic?.[id]) return false
      const ids: string[] = s.messages?.messageIdsByTopic?.[id] ?? []
      let latestAssistantId: string | null = null
      let count = 0
      for (const messageId of ids) {
        const message = s.messages.entities?.[messageId]
        if (message?.role === 'assistant') {
          count++
          latestAssistantId = messageId
        }
      }
      if (count <= previousCount || !latestAssistantId) return false
      const latest = s.messages.entities[latestAssistantId]
      if (!['success', 'error'].includes(latest.status)) return false
      const blocks: string[] = latest.blocks ?? []
      if (blocks.length === 0) return false
      return blocks.every((blockId) => {
        const block = s.messageBlocks?.entities?.[blockId]
        return Boolean(block) && ['success', 'error'].includes(block.status)
      })
    },
    { topicId, previousCount: previousAssistantCount },
    { timeout: 60000 }
  )
}

/** One real send in the topic; asserts the mock provider really served it. */
async function realSend(page: Page, topicId: string, text: string): Promise<void> {
  const previousCount = await assistantCount(page, topicId)
  clearRequestLog()
  const sequence = getRequestSequence()
  await uiSendMessage(page, text)
  await waitForReply(page, topicId, previousCount)
  const request = findProductRequestAfter(sequence)
  expect(request, 'mock provider must have received the real product request').not.toBeNull()
  expect(request!.parsed).toEqual(expect.objectContaining({ model: 'mock-model', stream: true }))
}

// ------------------- Main-authority message-time read ----------------------

/**
 * Main-authoritative latest message instant per topic, read over the WHOLE
 * logical topic (every route included) — never the loaded projection. Read-only
 * capability; the ordering comparison of these tests uses it as the oracle.
 */
async function mainTopicMessageTimes(page: Page, topicIds: string[]): Promise<Record<string, string | null>> {
  const result = await page.evaluate(async (ids: string[]) => {
    const api = (window as any).api.chatDb
    const read = await api.fetchTopicMessageTimes({ topicIds: ids })
    if (!read || read.ok !== true) return { ok: false as const, error: JSON.stringify(read) }
    const map: Record<string, string | null> = {}
    for (const entry of (read.value?.topics ?? []) as Array<{ topicId: string; latestMessageAt: string | null }>) {
      map[entry.topicId] = entry.latestMessageAt
    }
    return { ok: true as const, map }
  }, topicIds)
  expect(result.ok, `Main topic message-time read failed: ${JSON.stringify(result)}`).toBe(true)
  return (result as { ok: true; map: Record<string, string | null> }).map
}

/** Redux view of one message: its own instants plus the first block's content. */
async function messageState(
  page: Page,
  messageId: string
): Promise<{ createdAt: string | null; updatedAt: string | null; content: string | null } | null> {
  return page.evaluate((id: string) => {
    const s = (window as any).store.getState()
    const message = s.messages?.entities?.[id]
    if (!message) return null
    const blockId = (message.blocks ?? [])[0]
    const block = blockId ? s.messageBlocks?.entities?.[blockId] : null
    return {
      createdAt: (message.createdAt as string | undefined) ?? null,
      updatedAt: (message.updatedAt as string | undefined) ?? null,
      content: (block?.content as string | undefined) ?? null
    }
  }, messageId)
}

/** The last loaded user message of a topic — the turn a real send just created. */
async function lastLoadedUserMessageId(page: Page, topicId: string): Promise<string | null> {
  return page.evaluate((tid: string) => {
    const s = (window as any).store.getState()
    const ids: string[] | undefined = s.messages?.messageIdsByTopic?.[tid]
    if (!Array.isArray(ids)) return null
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const message = s.messages?.entities?.[ids[index]]
      if (message?.role === 'user') return ids[index] as string
    }
    return null
  }, topicId)
}

// ----------------------- Real message mutation UI --------------------------

/**
 * Real inline message edit through the production MessageEditor: hover the
 * message row, open the editor, replace the draft through the CodeMirror
 * onChange path and save (the editor closes only after the authority write
 * succeeded).
 */
async function editMessageContent(page: Page, messageId: string, text: string): Promise<void> {
  const container = page.locator(`[data-message-id="${messageId}"]`).first()
  await container.scrollIntoViewIfNeeded()
  await expect(container, `message ${messageId} must be rendered to be edited`).toBeVisible({ timeout: 15000 })
  await container.hover()
  const editButton = container.locator('[data-testid="msg-edit-btn"]')
  await editButton.waitFor({ state: 'visible', timeout: 10000 })
  await editButton.click()
  const editorArea = container.locator('.message-editor-area')
  await expect(editorArea).toBeVisible({ timeout: 5000 })
  const editor = cmContent(editorArea)
  await replaceEditorContent(page, editorArea, text)
  await expect(editor).toContainText(text, { timeout: 5000 })
  const saveButton = editorArea.locator('.message-editor-save-btn')
  await expect(saveButton).toBeVisible()
  await saveButton.click()
  await expect(editorArea).not.toBeVisible({ timeout: 10000 })
}

/**
 * Real menubar delete of one message: the confirmation setting is turned off
 * through its own product action (no ordering seam is touched), then ONE click
 * on the message's delete button performs the semantic delete. No retry loop,
 * so a wrong outcome can never be masked.
 */
async function deleteMessageThroughUi(page: Page, messageId: string): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).store.dispatch({ type: 'settings/setConfirmDeleteMessage', payload: false })
  })
  const container = page.locator(`[data-message-id="${messageId}"]`).first()
  await container.scrollIntoViewIfNeeded()
  await expect(container, `message ${messageId} must be rendered to be deleted`).toBeVisible({ timeout: 15000 })
  try {
    await container.hover({ timeout: 8000 })
  } catch {
    // The menubar buttons stay reachable without a settled hover in most layouts.
  }
  const deleteButton = container.locator('[data-testid="message-delete-button"]')
  await expect(deleteButton, 'locale-independent delete button must be attached').toBeAttached({ timeout: 10000 })
  await deleteButton.click({ timeout: 10000 })
}

// ------------------------- MAIN-side dialog stub ---------------------------

async function installMainOpenFile(electronApp: any, filePath: string): Promise<void> {
  await electronApp.evaluate(({ dialog }: typeof import('electron'), target: string) => {
    const d = dialog as any
    if (!d.__e2eTopicOrderOrigOpen) d.__e2eTopicOrderOrigOpen = d.showOpenDialog.bind(d)
    d.__e2eTopicOrderOpenCalls = 0
    d.__e2eTopicOrderOpenPath = target
    d.showOpenDialog = async () => {
      d.__e2eTopicOrderOpenCalls += 1
      return { canceled: false, filePaths: [d.__e2eTopicOrderOpenPath] }
    }
  }, filePath)
}

async function mainOpenCalls(electronApp: any): Promise<number> {
  return electronApp.evaluate(({ dialog }: typeof import('electron')) => {
    const d = dialog as any
    return (d.__e2eTopicOrderOpenCalls ?? 0) as number
  })
}

async function restoreMainDialogs(electronApp: any): Promise<void> {
  await electronApp.evaluate(({ dialog }: typeof import('electron')) => {
    const d = dialog as any
    if (d.__e2eTopicOrderOrigOpen) {
      d.showOpenDialog = d.__e2eTopicOrderOrigOpen
      delete d.__e2eTopicOrderOrigOpen
    }
  })
}

async function clickHeaderImport(page: Page): Promise<void> {
  const button = page.getByTestId('topic-import-btn')
  await expect(button).toBeVisible({ timeout: 10000 })
  await button.click()
}

async function waitForNewTopic(page: Page, knownIds: string[], timeout = 30000): Promise<string> {
  await page.waitForFunction(
    (known: string[]) => {
      const s = (window as any).store.getState()
      const ids = (s.assistants.assistants.flatMap((assistant: any) =>
        (assistant.topics ?? []).map((topic: any) => topic.id)
      ) ?? []) as string[]
      return ids.some((id) => !known.includes(id))
    },
    knownIds,
    { timeout }
  )
  return page.evaluate((known: string[]) => {
    const s = (window as any).store.getState()
    const ids = (s.assistants.assistants.flatMap((assistant: any) =>
      (assistant.topics ?? []).map((topic: any) => topic.id)
    ) ?? []) as string[]
    return ids.find((id) => !known.includes(id)) as string
  }, knownIds)
}

// --------------------------- Pointer drag ---------------------------------

/**
 * Real pointer drag of one topic row onto another row's center. `@hello-pangea/dnd`
 * activates on the `draggable-content` handle after a small pointer move, so the
 * path starts with a short activating move and then travels in steps.
 */
async function dragTopicOnto(page: Page, sourceId: string, targetId: string): Promise<void> {
  await dismissMenus(page)
  const source = page.locator(`[data-testid="topic-item"][data-topic-id="${sourceId}"]`)
  const target = page.locator(`[data-testid="topic-item"][data-topic-id="${targetId}"]`)
  await source.scrollIntoViewIfNeeded()
  await target.scrollIntoViewIfNeeded()
  await expect(source).toBeVisible({ timeout: 15000 })
  await expect(target).toBeVisible({ timeout: 15000 })
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  const startX = sourceBox!.x + sourceBox!.width / 2
  const startY = sourceBox!.y + sourceBox!.height / 2
  const targetY = targetBox!.y + targetBox!.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.waitForTimeout(150)
  await page.mouse.move(startX + 1, startY + 12, { steps: 4 })
  await page.waitForTimeout(80)
  await page.mouse.move(startX + 1, targetY, { steps: 18 })
  await page.waitForTimeout(150)
  await page.mouse.up()
}

/** Drag & drop must be finished, not still animating, before order reads. */
async function settleDrag(page: Page): Promise<void> {
  await page.waitForTimeout(300)
}

// ------------------------------ Renaming ----------------------------------

/** Real context-menu rename through the production PromptPopup. */
async function renameTopic(page: Page, topicId: string, newName: string): Promise<void> {
  await openTopicMenu(page, topicId)
  const entry = page
    .locator('.ant-dropdown-menu:visible .ant-dropdown-menu-item')
    .filter({ hasText: RENAME_ITEM })
    .first()
  await expect(entry).toBeVisible({ timeout: 10000 })
  await entry.click()
  const modal = page.locator('.ant-modal:visible')
  await expect(modal).toHaveCount(1, { timeout: 10000 })
  await modal.locator('textarea').fill(newName)
  await modal.locator('.ant-btn-primary').click()
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 10000 })
  await expect.poll(async () => (await findTopicRedux(page, topicId))?.name, { timeout: 15000 }).toBe(newName)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('topic list ordering', () => {
  test.setTimeout(300000)

  test('A: default by-update-time ordering follows the full-route message instant, ignores metadata, and admits an imported topic', async ({
    electronApp,
    mainWindow,
    ownedTmpRoot
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'A INTEGRATED: fresh assistant default (updated) + real menu selection, one real Sort by update time click sorts non-pinned topics by the full-route latest message instant (unopened branch tip, no-message createdAt fallback, contradicting 2030 metadata), and a real header-imported topic with null timestamps joins the authoritative position instead of the head.'
    })
    const page = mainWindow
    const assistantId = await liveAssistantId(page)

    const defaultTopicId =
      await test.step('fresh assistant is on the default order and the menu reports it', async () => {
        expect(await topicOrderMode(page, assistantId)).toBe('updated')
        const topics = await reduxTopicIds(page, assistantId)
        expect(topics.length).toBe(1)
        const id = topics[0]
        await openTopicMenu(page, id)
        await openSortSubmenu(page)
        await expectSelectedSort(page, BY_UPDATED)
        await dismissMenus(page)
        console.log('[E2E] A default order = updated and the menu reports by-update-time')
        return id
      })

    const seeded = await test.step('seed topics whose metadata contradicts their message instants', async () => {
      const ids = {
        first: newId('ord-first'),
        mid: newId('ord-mid'),
        empty: newId('ord-empty'),
        branch: newId('ord-branch'),
        pinned: newId('ord-pinned')
      }
      await seedTopics(
        page,
        assistantId,
        // Deliberately NOT in authoritative order: `addTopic` prepends, so the
        // projection must differ from the sorted order.
        [
          {
            topicId: ids.first,
            name: 'ord-first',
            createdAt: AT.conflictingMetadata,
            updatedAt: AT.conflictingMetadata,
            messages: [
              { key: 'f-u1', role: 'user', at: AT.firstUser },
              { key: 'f-a1', role: 'assistant', at: AT.firstReply }
            ]
          },
          { topicId: ids.empty, name: 'ord-empty', createdAt: AT.emptyCreatedAt, updatedAt: AT.emptyCreatedAt },
          {
            topicId: ids.pinned,
            name: 'ord-pinned',
            // Oldest metadata: only the pin can put it first.
            createdAt: AT.old,
            updatedAt: AT.old,
            pinned: true,
            messages: [{ key: 'p-u1', role: 'user', at: AT.pinned }]
          },
          {
            topicId: ids.mid,
            name: 'ord-mid',
            createdAt: AT.conflictingMetadata,
            updatedAt: AT.conflictingMetadata,
            messages: [{ key: 'm-u1', role: 'user', at: AT.mid }]
          },
          {
            topicId: ids.branch,
            name: 'ord-branch',
            createdAt: AT.conflictingMetadata,
            updatedAt: AT.conflictingMetadata,
            messages: [{ key: 'b-u1', role: 'user', at: AT.branchMain }],
            branch: { name: 'L1', anchorKey: 'b-u1', messages: [{ key: 'b-u2', role: 'user', at: AT.branchTip }] }
          }
        ]
      )
      // The fresh profile's own topic keeps its real createdAt and owns the
      // oldest instant, so it can never be a message-time head.
      await seedExistingTopic(page, assistantId, defaultTopicId, [{ key: 'd-u1', role: 'user', at: AT.old }])
      const projection = await reduxTopicIds(page, assistantId)
      const expected = [ids.pinned, ids.branch, ids.empty, ids.mid, ids.first, defaultTopicId]
      expect(projection).not.toEqual(expected)
      return { ...ids, projection, expected }
    })

    await test.step('one real Sort by update time click re-sorts by message instant', async () => {
      await openTopicMenu(page, seeded.pinned)
      await openSortSubmenu(page)
      await expectSelectedSort(page, BY_UPDATED)
      await chooseSortMode(page, seeded.pinned, BY_UPDATED, orderMatches(page, seeded.expected, assistantId))
      await expectTopicOrder(page, seeded.expected, assistantId)
      await expectDomTopicOrder(page, seeded.expected)
      expect(await topicOrderMode(page, assistantId)).toBe('updated')
      console.log(
        `[E2E] A authoritative order = ${JSON.stringify(seeded.expected)} (branch tip, empty fallback, metadata ignored)`
      )
    })

    let importedTopicId = ''
    await test.step('a real header import joins by its own message instants', async () => {
      const payload = {
        format: 'cherry-chat-topic-data',
        version: 1,
        exportedAt: new Date().toISOString(),
        // Null timestamps: only the imported messages carry time.
        topic: { name: 'ord-imported', createdAt: null, updatedAt: null },
        messages: [
          {
            id: 'imp-u1',
            branchId: null,
            role: 'user',
            content: 'ord-imported',
            status: 'success',
            createdAt: AT.imported,
            updatedAt: AT.imported,
            sortOrder: 0
          }
        ],
        blocks: [
          {
            id: 'imp-u1-main',
            messageId: 'imp-u1',
            type: 'main_text',
            content: 'ord-imported',
            status: 'success',
            createdAt: AT.imported,
            sortOrder: 0
          }
        ],
        branches: [],
        segments: [],
        fileReferences: []
      }
      const importFile = path.join(ownedTmpRoot, 'topic-ordering-import.json')
      fs.writeFileSync(importFile, JSON.stringify(payload, null, 2), 'utf-8')
      await installMainOpenFile(electronApp, importFile)
      const known = await reduxTopicIds(page, assistantId)
      await clickHeaderImport(page)
      await expect(page.locator('.ant-message')).toContainText(/(话题已导入|Topic imported)/, { timeout: 20000 })
      expect(
        await mainOpenCalls(electronApp),
        'MAIN showOpenDialog must have served the import'
      ).toBeGreaterThanOrEqual(1)
      importedTopicId = await waitForNewTopic(page, known)
      // The projection prepends the import; it therefore starts at the head and
      // must be re-positioned by its message instant.
      expect((await reduxTopicIds(page, assistantId))[0]).toBe(importedTopicId)
      console.log(`[E2E] A import ok topic=${importedTopicId} (head before re-sort)`)
    })

    await test.step('re-activating by update time places the imported topic by message time', async () => {
      const expected = [
        seeded.pinned,
        seeded.branch,
        seeded.empty,
        importedTopicId,
        seeded.mid,
        seeded.first,
        defaultTopicId
      ]
      await chooseSortMode(page, seeded.pinned, BY_UPDATED, orderMatches(page, expected, assistantId))
      await expectTopicOrder(page, expected, assistantId)
      await expectDomTopicOrder(page, expected)
      expect(await topicOrderMode(page, assistantId)).toBe('updated')
      await restoreMainDialogs(electronApp)
      console.log(`[E2E] A imported topic placed by message instant at index 3: ${JSON.stringify(expected)}`)
    })
  })

  // -------------------------------------------------------------------------
  // B — the continuous policy under real user actions
  // -------------------------------------------------------------------------

  test('B: a real drag, metadata writes and a topic switch never move anything; one real send moves only its topic and a real message edit of that turn moves nothing', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'B INTEGRATED: under updated, a REAL pointer drag of a topic row reorders the list freely and keeps the policy; a real context-menu rename through PromptPopup and a real topic switch leave the order byte-identical; one real textarea/Enter send moves ONLY the written topic to the ordinary head (others keep their relative order) with the mock provider serving the request; a real drag then leaves that topic off the head, and a real inline edit of the just-sent turn (message updatedAt advanced, createdAt and the Main-authority latest instant unchanged, order byte-identical) cannot be satisfied by an implementation that promotes on a message write.'
    })
    const page = mainWindow
    const assistantId = await liveAssistantId(page)
    const defaultTopicId = (await reduxTopicIds(page, assistantId))[0]

    const ids = await test.step('seed five ordinary topics with staggered instants', async () => {
      const seeded = [
        { topicId: newId('ordb-1'), name: 'ordb-1', at: '2024-01-01T00:00:00.000Z' },
        { topicId: newId('ordb-2'), name: 'ordb-2', at: '2024-02-01T00:00:00.000Z' },
        { topicId: newId('ordb-3'), name: 'ordb-3', at: '2024-03-01T00:00:00.000Z' },
        { topicId: newId('ordb-4'), name: 'ordb-4', at: '2024-04-01T00:00:00.000Z' },
        { topicId: newId('ordb-5'), name: 'ordb-5', at: '2024-05-01T00:00:00.000Z' }
      ]
      // Deliberately seeded out of authoritative order (`addTopic` prepends).
      const plan: SeedTopic[] = [
        {
          topicId: seeded[2].topicId,
          name: 'ordb-3',
          createdAt: AT.conflictingMetadata,
          updatedAt: AT.conflictingMetadata,
          messages: [{ key: 'ordb-3-u1', role: 'user', at: seeded[2].at }]
        },
        {
          topicId: seeded[0].topicId,
          name: 'ordb-1',
          createdAt: AT.conflictingMetadata,
          updatedAt: AT.conflictingMetadata,
          messages: [{ key: 'ordb-1-u1', role: 'user', at: seeded[0].at }]
        },
        {
          topicId: seeded[4].topicId,
          name: 'ordb-5',
          createdAt: AT.conflictingMetadata,
          updatedAt: AT.conflictingMetadata,
          messages: [{ key: 'ordb-5-u1', role: 'user', at: seeded[4].at }]
        },
        {
          topicId: seeded[1].topicId,
          name: 'ordb-2',
          createdAt: AT.conflictingMetadata,
          updatedAt: AT.conflictingMetadata,
          messages: [{ key: 'ordb-2-u1', role: 'user', at: seeded[1].at }]
        },
        {
          topicId: seeded[3].topicId,
          name: 'ordb-4',
          createdAt: AT.conflictingMetadata,
          updatedAt: AT.conflictingMetadata,
          messages: [{ key: 'ordb-4-u1', role: 'user', at: seeded[3].at }]
        }
      ]
      await seedTopics(page, assistantId, plan)
      // The fresh profile topic owns the oldest instant.
      await seedExistingTopic(page, assistantId, defaultTopicId, [{ key: 'ordb-0-u1', role: 'user', at: AT.old }])
      return {
        t1: seeded[0].topicId,
        t2: seeded[1].topicId,
        t3: seeded[2].topicId,
        t4: seeded[3].topicId,
        t5: seeded[4].topicId
      }
    })

    await test.step('one real Sort by update time click orders them newest-first', async () => {
      const expected = [ids.t5, ids.t4, ids.t3, ids.t2, ids.t1, defaultTopicId]
      await chooseSortMode(page, ids.t1, BY_UPDATED, orderMatches(page, expected, assistantId))
      await expectTopicOrder(page, expected, assistantId)
      await expectDomTopicOrder(page, expected)
      expect(await topicOrderMode(page, assistantId)).toBe('updated')
      console.log(`[E2E] B seeded order = ${JSON.stringify(expected)}`)
    })

    await test.step('a real pointer drag reorders freely and keeps the policy', async () => {
      const before = await reduxTopicIds(page, assistantId)
      await dragTopicOnto(page, ids.t5, ids.t2)
      await settleDrag(page)
      await expect.poll(() => reduxTopicIds(page, assistantId), { timeout: 8000 }).not.toEqual(before)
      const settled = await reduxTopicIds(page, assistantId)
      expect(settled.length).toBe(before.length)
      expect(new Set(settled)).toEqual(new Set(before))
      expect(settled[0]).not.toBe(before[0])
      expect(settled.indexOf(before[0])).toBeGreaterThan(0)
      expect(settled.filter((id) => id !== before[0])).toEqual(before.filter((id) => id !== before[0]))
      expect(await topicOrderMode(page, assistantId)).toBe('updated')
      console.log(`[E2E] B real drag moved ${before[0]} to index ${settled.indexOf(before[0])} and kept mode=updated`)
    })

    await test.step('a real metadata write (rename) never moves a topic', async () => {
      const before = await reduxTopicIds(page, assistantId)
      await renameTopic(page, ids.t3, 'ordb-3-renamed')
      await page.waitForTimeout(500)
      expect(await reduxTopicIds(page, assistantId)).toEqual(before)
      expect(await topicOrderMode(page, assistantId)).toBe('updated')
      console.log('[E2E] B rename kept the order byte-identical')
    })

    await test.step('a real topic switch never moves a topic', async () => {
      const before = await reduxTopicIds(page, assistantId)
      await activateTopic(page, ids.t1)
      await page.waitForTimeout(500)
      expect(await reduxTopicIds(page, assistantId)).toEqual(before)
      const active = await page.evaluate(() => (window as any).store.getState().runtime?.chat?.activeTopic?.id ?? null)
      expect(active).toBe(ids.t1)
    })

    await test.step('one real send moves only the written topic to the ordinary head', async () => {
      const before = await reduxTopicIds(page, assistantId)
      const sent = ids.t1
      expect(before[0]).not.toBe(sent)
      expect(before.indexOf(sent)).toBeGreaterThan(0)
      await realSend(page, sent, `ordb-send-${Date.now()}`)
      const expected = [sent, ...before.filter((id) => id !== sent)]
      await expectTopicOrder(page, expected, assistantId)
      await expectDomTopicOrder(page, expected)
      expect(await topicOrderMode(page, assistantId)).toBe('updated')
      console.log(`[E2E] B send moved only its topic: ${JSON.stringify(expected)}`)
    })

    await test.step('a real drag leaves the just-written topic off the head', async () => {
      const before = await reduxTopicIds(page, assistantId)
      expect(before[0]).toBe(ids.t1)
      await dragTopicOnto(page, ids.t1, ids.t2)
      await settleDrag(page)
      await expect.poll(() => reduxTopicIds(page, assistantId), { timeout: 8000 }).not.toEqual(before)
      const settled = await reduxTopicIds(page, assistantId)
      expect(settled.length).toBe(before.length)
      expect(new Set(settled)).toEqual(new Set(before))
      expect(settled[0]).not.toBe(ids.t1)
      expect(settled.indexOf(ids.t1)).toBeGreaterThan(0)
      expect(settled.filter((id) => id !== ids.t1)).toEqual(before.filter((id) => id !== ids.t1))
      expect(await topicOrderMode(page, assistantId)).toBe('updated')
      // The edited turn must stay on screen; re-opening its topic is an inert switch.
      await activateTopic(page, ids.t1)
      console.log(`[E2E] B drag moved the written topic to index ${settled.indexOf(ids.t1)} and kept mode=updated`)
    })

    await test.step('a real inline message edit of the just-sent turn keeps createdAt, the authority maximum and the order', async () => {
      const editedMessageId = await lastLoadedUserMessageId(page, ids.t1)
      expect(editedMessageId, 'the real send must have produced a loaded user message').not.toBeNull()
      const before = await reduxTopicIds(page, assistantId)
      // The edited topic is deliberately NOT the head: an implementation that
      // promoted on a message write would move it and fail this step.
      expect(before[0]).not.toBe(ids.t1)
      expect(before.indexOf(ids.t1)).toBeGreaterThan(0)
      const beforeMessage = await messageState(page, editedMessageId!)
      expect(beforeMessage, 'the just-sent user message must be loaded').not.toBeNull()
      const beforeTopicUpdatedAt = (await findTopicRedux(page, ids.t1))?.updatedAt
      const beforeTimes = await mainTopicMessageTimes(page, [ids.t1])
      expect(beforeTimes[ids.t1], 'Main latest instant of the sent topic').not.toBe('2024-01-01T00:00:00.000Z')

      const editedText = `ordb-1-edited-${Date.now()}`
      await editMessageContent(page, editedMessageId!, editedText)
      await expect
        .poll(async () => (await messageState(page, editedMessageId!))?.content, { timeout: 15000 })
        .toBe(editedText)

      const afterMessage = await messageState(page, editedMessageId!)
      // The real edit advanced the message write clock and the topic's own
      // `updatedAt`, and left the ordering key and the authority maximum alone.
      expect(afterMessage!.createdAt).toBe(beforeMessage!.createdAt)
      expect(afterMessage!.updatedAt).not.toBe(beforeMessage!.updatedAt)
      expect((await findTopicRedux(page, ids.t1))?.updatedAt).not.toBe(beforeTopicUpdatedAt)
      const afterTimes = await mainTopicMessageTimes(page, [ids.t1])
      expect(afterTimes[ids.t1]).toBe(beforeTimes[ids.t1])
      // Nothing moved — byte-identical Redux and DOM order, same policy.
      expect(await reduxTopicIds(page, assistantId)).toEqual(before)
      await expectDomTopicOrder(page, before)
      expect(await topicOrderMode(page, assistantId)).toBe('updated')
      console.log('[E2E] B message edit advanced its updatedAt, kept createdAt and the Main maximum, and moved nothing')
    })
  })

  // -------------------------------------------------------------------------
  // C — "by creation time" is a one-shot explicit manual order
  // -------------------------------------------------------------------------

  test('C: by creation time reorders once into manual, a send never moves, by update time restores continuity, and deleting the new turn drops only that topic', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'C INTEGRATED: a real Sort by creation time click applies a full createdAt-desc reorder of the non-pinned topics (pinned first), persists the explicit manual order and the menu reports it; a real send while manual leaves the order byte-identical; a real Sort by update time click restores the continuous policy and the next real send in a low topic moves it to the ordinary head; deleting that just-sent turn through the real menubar delete drops ONLY that topic to its real previous instant (Main maximum falls back, every other topic and the pin keep their relative order).'
    })
    const page = mainWindow
    const assistantId = await liveAssistantId(page)
    const defaultTopicId = (await reduxTopicIds(page, assistantId))[0]

    const ids = await test.step('seed topics whose createdAt order is opposite to their message instants', async () => {
      const seeded = {
        c1: newId('ordc-1'),
        c2: newId('ordc-2'),
        c3: newId('ordc-3'),
        c4: newId('ordc-4'),
        pinned: newId('ordc-pinned')
      }
      await seedTopics(page, assistantId, [
        {
          topicId: seeded.c1,
          name: 'ordc-1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          messages: [{ key: 'c1-u1', role: 'user', at: '2024-05-01T00:00:00.000Z' }]
        },
        {
          topicId: seeded.c2,
          name: 'ordc-2',
          createdAt: '2024-02-01T00:00:00.000Z',
          updatedAt: '2024-02-01T00:00:00.000Z',
          messages: [{ key: 'c2-u1', role: 'user', at: '2024-04-01T00:00:00.000Z' }]
        },
        {
          topicId: seeded.c3,
          name: 'ordc-3',
          createdAt: '2024-03-01T00:00:00.000Z',
          updatedAt: '2024-03-01T00:00:00.000Z',
          messages: [{ key: 'c3-u1', role: 'user', at: '2024-02-01T00:00:00.000Z' }]
        },
        {
          topicId: seeded.c4,
          name: 'ordc-4',
          createdAt: '2024-04-01T00:00:00.000Z',
          updatedAt: '2024-04-01T00:00:00.000Z',
          messages: [{ key: 'c4-u1', role: 'user', at: '2024-01-01T00:00:00.000Z' }]
        },
        {
          topicId: seeded.pinned,
          name: 'ordc-pinned',
          createdAt: '2023-06-01T00:00:00.000Z',
          updatedAt: '2023-06-01T00:00:00.000Z',
          pinned: true,
          messages: [{ key: 'cp-u1', role: 'user', at: '2024-06-01T00:00:00.000Z' }]
        }
      ])
      // The fresh profile topic carries the real (newest) createdAt and the
      // oldest message instant, so creation order and message order disagree.
      await seedExistingTopic(page, assistantId, defaultTopicId, [{ key: 'ordc-0-u1', role: 'user', at: AT.old }])
      return seeded
    })

    await test.step('real Sort by creation time applies a full createdAt-desc order and leaves continuous mode', async () => {
      const expected = [ids.pinned, defaultTopicId, ids.c4, ids.c3, ids.c2, ids.c1]
      await chooseSortMode(page, ids.pinned, BY_CREATED, orderMatches(page, expected, assistantId))
      await expectTopicOrder(page, expected, assistantId)
      await expectDomTopicOrder(page, expected)
      expect(await topicOrderMode(page, assistantId)).toBe('manual')
      // The menu now reports the creation-time view it just applied.
      await openTopicMenu(page, ids.pinned)
      await openSortSubmenu(page)
      await expectSelectedSort(page, BY_CREATED)
      await dismissMenus(page)
      console.log(`[E2E] C creation order = ${JSON.stringify(expected)} mode=manual`)
    })

    const manualOrder = await reduxTopicIds(page, assistantId)

    await test.step('a real send while manual never moves a topic', async () => {
      await activateTopic(page, ids.c1)
      await realSend(page, ids.c1, `ordc-manual-send-${Date.now()}`)
      await page.waitForTimeout(500)
      expect(await reduxTopicIds(page, assistantId)).toEqual(manualOrder)
      expect(await topicOrderMode(page, assistantId)).toBe('manual')
      console.log('[E2E] C send under manual kept the order byte-identical')
    })

    await test.step('by update time restores continuity for the next real send', async () => {
      // c1 was the topic just written, so its newest instant is the head now.
      const restored = [ids.pinned, ids.c1, ids.c2, ids.c3, ids.c4, defaultTopicId]
      await chooseSortMode(page, ids.pinned, BY_UPDATED, orderMatches(page, restored, assistantId))
      await expectTopicOrder(page, restored, assistantId)
      expect(await topicOrderMode(page, assistantId)).toBe('updated')
      await openTopicMenu(page, ids.pinned)
      await openSortSubmenu(page)
      await expectSelectedSort(page, BY_UPDATED)
      await dismissMenus(page)

      await activateTopic(page, ids.c4)
      await realSend(page, ids.c4, `ordc-updated-send-${Date.now()}`)
      const expected = [ids.pinned, ids.c4, ids.c1, ids.c2, ids.c3, defaultTopicId]
      await expectTopicOrder(page, expected, assistantId)
      await expectDomTopicOrder(page, expected)
      expect(await topicOrderMode(page, assistantId)).toBe('updated')
      console.log(`[E2E] C restored continuity: ${JSON.stringify(expected)}`)
    })

    await test.step('deleting the just-sent turn drops only that topic to its real previous instant', async () => {
      const before = await reduxTopicIds(page, assistantId)
      expect(before).toEqual([ids.pinned, ids.c4, ids.c1, ids.c2, ids.c3, defaultTopicId])
      // The just-sent turn: every message of the active topic except its seed.
      const seedMessageId = `${ids.c4}-c4-u1`
      const sentTurn = await page.evaluate(
        ({ topicId, seed }: { topicId: string; seed: string }) => {
          const s = (window as any).store.getState()
          const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
          return ids
            .filter((id) => id !== seed)
            .map((id) => ({ id, role: s.messages.entities?.[id]?.role as string | undefined }))
        },
        { topicId: ids.c4, seed: seedMessageId }
      )
      expect(sentTurn.length, 'the real send must have produced a user+assistant turn').toBe(2)
      expect(sentTurn.filter((entry) => entry.role === 'user').length).toBe(1)
      expect(sentTurn.filter((entry) => entry.role === 'assistant').length).toBe(1)
      const deletedRoot = sentTurn.find((entry) => entry.role === 'user')!.id

      // The turn owns the topic's real maximum; the seed instant is below the
      // c3/c2 neighbours, so a fallback must move the topic DOWN.
      const seededInstant = '2024-01-01T00:00:00.000Z'
      const beforeTimes = await mainTopicMessageTimes(page, [ids.c4, ids.c2, ids.c3])
      expect(beforeTimes[ids.c4], 'the sent turn must be the topic maximum').not.toBe(seededInstant)
      expect(Date.parse(seededInstant)).toBeLessThan(Date.parse(beforeTimes[ids.c3]!))
      expect(Date.parse(seededInstant)).toBeLessThan(Date.parse(beforeTimes[ids.c2]!))

      // Real menubar delete of the user message: its assistant reply goes with it.
      await deleteMessageThroughUi(page, deletedRoot)
      await page.waitForFunction(
        ({ topicId, gone }: { topicId: string; gone: string[] }) => {
          const s = (window as any).store.getState()
          const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
          return gone.every((id) => !ids.includes(id))
        },
        { topicId: ids.c4, gone: sentTurn.map((entry) => entry.id) },
        { timeout: 30000 }
      )

      // The authority maximum really fell back (the turn is gone from Main).
      const afterTimes = await mainTopicMessageTimes(page, [ids.c4, ids.c2, ids.c3])
      expect(afterTimes[ids.c4], 'Main maximum must fall back to the seed instant').toBe(seededInstant)
      expect(afterTimes[ids.c2]).toBe(beforeTimes[ids.c2])
      expect(afterTimes[ids.c3]).toBe(beforeTimes[ids.c3])

      // Only the deleted topic moved: the pin and every other relative order
      // are byte-identical, and the policy is still continuous.
      const expected = [ids.pinned, ids.c1, ids.c2, ids.c3, ids.c4, defaultTopicId]
      await expectTopicOrder(page, expected, assistantId)
      await expectDomTopicOrder(page, expected)
      expect(before.filter((id) => id !== ids.c4)).toEqual(expected.filter((id) => id !== ids.c4))
      expect(before.indexOf(ids.c4)).toBeLessThan(expected.indexOf(ids.c4))
      expect(await topicOrderMode(page, assistantId)).toBe('updated')
      console.log(`[E2E] C delete fell back to the seed instant and only c4 moved: ${JSON.stringify(expected)}`)
    })
  })
})
