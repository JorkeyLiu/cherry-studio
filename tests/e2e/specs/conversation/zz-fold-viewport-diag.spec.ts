/**
 * TEMPORARY diagnostic (deleted after use): where does the unfold viewport
 * delta actually come from, and which element is the real baseline?
 *
 * It reproduces the observer scenario's phase 07 exactly (collapse → expand →
 * block menu unfold) but triggers the block menu with POINTER COORDINATES
 * inside the scrollport, so no Playwright actionability scroll can enter the
 * measurement, and it records every mounted row's geometry over time.
 */
import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

const SEED_TURNS = 6
const CONTEXT_COUNT = 10

function turnIds(topicId: string, turn: number): { user: string; assistant: string } {
  const pad = String(turn).padStart(5, '0')
  return { user: `${topicId}-msg-${pad}`, assistant: `${topicId}-msg-${pad}-a` }
}

function buildSeedEntries(topicId: string, assistantId: string) {
  const entries: Array<Record<string, unknown>> = []
  for (let turn = 1; turn <= SEED_TURNS; turn++) {
    const ids = turnIds(topicId, turn)
    entries.push({
      id: ids.user,
      topicId,
      role: 'user',
      content: `diag user ${turn}`,
      createdAt: `2026-01-01T00:0${turn}:00.000Z`,
      updatedAt: `2026-01-01T00:0${turn}:00.000Z`,
      status: 'success'
    })
    entries.push({
      id: ids.assistant,
      topicId,
      role: 'assistant',
      content: `diag assistant ${turn}`,
      askId: ids.user,
      model: { id: 'mock', name: 'Mock' },
      modelId: 'mock',
      assistantId,
      createdAt: `2026-01-01T00:0${turn}:30.000Z`,
      updatedAt: `2026-01-01T00:0${turn}:30.000Z`,
      status: 'success'
    })
  }
  return entries
}

async function seed(page: Page, assistantId: string, topicId: string, groupTurns: readonly number[]) {
  await page.evaluate(
    ({ topicId, assistantId }: Record<string, string>) => {
      ;(window as any).store.dispatch({
        type: 'assistants/addTopic',
        payload: {
          assistantId,
          topic: {
            id: topicId,
            assistantId,
            name: `diag ${topicId}`,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        }
      })
    },
    { topicId, assistantId }
  )
  const segmentId = `${topicId}-seg-fold`
  const memberIds = groupTurns.flatMap((turn) => [turnIds(topicId, turn).user, turnIds(topicId, turn).assistant])
  const persisted = await page.evaluate(
    async ({ topicId, assistantId, name, entries, segmentId, memberIds }: Record<string, any>) => {
      const api: any = (window as any).api.chatDb
      const ensured = await api.ensureTopic({ topicId, assistantId, name })
      if (ensured?.ok !== true) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
      const pasted = await api.pasteMessagesToTopic({ topicId, entries })
      if (pasted?.ok !== true) return { ok: false, err: `paste ${JSON.stringify(pasted)}` }
      const upserted = await api.upsertSegment({
        segmentId,
        topicId,
        name: 'Diag Group',
        messageIds: memberIds,
        branchId: null
      })
      if (upserted?.ok !== true) return { ok: false, err: `upsert ${JSON.stringify(upserted)}` }
      return { ok: true }
    },
    {
      topicId,
      assistantId,
      name: `diag topic ${topicId}`,
      entries: buildSeedEntries(topicId, assistantId),
      segmentId,
      memberIds
    }
  )
  expect(persisted.ok, `seed failed: ${(persisted as any).err}`).toBe(true)
}

async function activate(page: Page, topicId: string, expected: number) {
  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await item.waitFor({ state: 'attached', timeout: 15000 })
  await item.scrollIntoViewIfNeeded()
  await item.click()
  await page.waitForFunction(
    ({ topicId, expected }: { topicId: string; expected: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      return Array.isArray(ids) && ids.length >= expected && s.messages?.loadingByTopic?.[topicId] !== true
    },
    { topicId, expected },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (min: number) => document.querySelectorAll('#messages [data-message-id]').length >= min,
    expected,
    { timeout: 30000 }
  )
}

/** Every mounted row + block chrome, in viewport coordinates. */
async function readState(page: Page, label: string) {
  return page.evaluate((label: string) => {
    const container = document.querySelector('#messages') as HTMLElement | null
    const rect = (el: Element | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), height: +r.height.toFixed(2) }
    }
    const rows: Array<{ id: string; top: number; bottom: number }> = []
    for (const el of Array.from(document.querySelectorAll('#messages [data-message-id]'))) {
      if (!(el instanceof HTMLElement)) continue
      if (el.getAttribute('data-testid') === 'answer-group-selector') continue
      const id = el.getAttribute('data-message-id')
      if (!id) continue
      const r = el.getBoundingClientRect()
      rows.push({ id, top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2) })
    }
    const containerRect = container ? container.getBoundingClientRect() : null
    return {
      label,
      scrollTop: container?.scrollTop ?? null,
      scrollHeight: container?.scrollHeight ?? null,
      clientHeight: container?.clientHeight ?? null,
      containerRect: containerRect
        ? { top: +containerRect.top.toFixed(2), bottom: +containerRect.bottom.toFixed(2) }
        : null,
      block: rect(
        document.querySelector('[data-testid="folded-section-collapsed"], [data-testid="folded-section-expanded"]')
      ),
      summary: rect(document.querySelector('[data-testid="folded-section-summary"]')),
      expandedHeader: rect(document.querySelector('[data-testid="folded-section-header"]')),
      groupHeader: rect(document.querySelector('[data-testid="topic-segment-group"]')),
      rows
    }
  }, label)
}

const COLLAPSED = '[data-testid="folded-section-collapsed"]'
const EXPANDED = '[data-testid="folded-section-expanded"]'

test.describe('TEMP diagnostic — unfold viewport baseline', () => {
  test('unfold with a pointer-coordinate trigger (no harness scroll)', async ({ mainWindow }) => {
    test.setTimeout(420000)
    const page = mainWindow
    await waitForAppReady(page)

    const assistantId = await page.evaluate(
      () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
    )
    expect(assistantId, 'a seeded assistant must exist').toBeTruthy()
    await page.evaluate(
      ({ assistantId, contextCount }: Record<string, any>) => {
        ;(window as any).store.dispatch({
          type: 'assistants/updateAssistant',
          payload: { id: assistantId, contextCount }
        })
      },
      { assistantId, contextCount: CONTEXT_COUNT }
    )

    const topicId = `diagfold-${Date.now()}`
    await seed(page, assistantId as string, topicId, [2, 3, 4, 5])
    await activate(page, topicId, SEED_TURNS * 2)

    // ── fold turns 3+4 through the store-level fold command, then reload ────
    // (The fold GESTURE is covered by the real spec; this diagnostic only needs
    // the folded shape, so it writes the authority fact directly.)
    const foldWrites = await page.evaluate(
      async ({ topicId, ids }: Record<string, any>) => {
        const api: any = (window as any).api.chatDb
        return api.setTurnFolds({ topicId, selectedGroupIds: ids, folded: true })
      },
      { topicId, ids: [turnIds(topicId, 3).user, turnIds(topicId, 4).user] }
    )
    expect(foldWrites?.folded, `fold command failed: ${JSON.stringify(foldWrites)}`).toBe(true)
    await page.reload()
    await waitForAppReady(page)
    await activate(page, topicId, SEED_TURNS * 2)
    await page.locator(COLLAPSED).first().waitFor({ state: 'visible', timeout: 30000 })

    const log: unknown[] = []
    await page.locator(COLLAPSED).first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    log.push(await readState(page, 'A-collapsed-visible'))

    // ── expand through the real summary button (already in view) ───────────
    await page.locator(`${COLLAPSED} [data-testid="folded-section-expand-btn"]`).click()
    await page.locator(EXPANDED).first().waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(600)
    log.push(await readState(page, 'B-after-expand'))

    // ── right-click the block's own rail at a POINT inside the scrollport ──
    const point = await page.evaluate(() => {
      const container = document.querySelector('#messages') as HTMLElement
      const rail = document.querySelector('[data-testid="folded-section-gutter-rail"]') as HTMLElement
      if (!container || !rail) return null
      const c = container.getBoundingClientRect()
      const r = rail.getBoundingClientRect()
      const lo = Math.max(c.top, r.top) + 24
      const hi = Math.min(c.bottom, r.bottom) - 24
      const y = lo + Math.max(0, Math.min(hi - lo, (hi - lo) / 2))
      return { x: r.left + 8, y }
    })
    expect(point, 'the block rail must be measurable').not.toBeNull()
    await page.mouse.move(point!.x, point!.y)
    await page.mouse.click(point!.x, point!.y, { button: 'right' })
    const unfold = page.getByRole('menuitem', { name: /^(取消折叠|Unfold)$/ })
    await unfold.waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(200)
    log.push(await readState(page, 'C-menu-open-before-click'))

    // ── click the item and sample the transition ──────────────────────────
    const scrollTopBefore = await page.evaluate(() => (document.querySelector('#messages') as HTMLElement).scrollTop)
    await unfold.click()
    for (const wait of [0, 60, 200, 600, 1500]) {
      if (wait > 0) await page.waitForTimeout(wait)
      log.push(await readState(page, `D+${wait}`))
    }
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="folded-section-collapsed"], [data-testid="folded-section-expanded"]')
          .length === 0,
      null,
      { timeout: 30000 }
    )
    log.push(await readState(page, 'E-unfolded'))

    // eslint-disable-next-line no-console
    console.log('[DIAG] scrollTopBeforeMenuClick=' + scrollTopBefore)
    // eslint-disable-next-line no-console
    console.log('[DIAG] states=' + JSON.stringify(log, null, 1))
    expect(scrollTopBefore).toBeDefined()
  })
})
