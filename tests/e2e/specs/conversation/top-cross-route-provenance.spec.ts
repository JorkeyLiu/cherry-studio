/**
 * Top-selector cross-route anchor provenance — FOCUSED E2E (real UI, real IPC, real SQLite).
 *
 * Proven deterministic bug (controller + Messages top effect):
 * - A displayed/stable with anchor a1/cache A.
 * - request(top B, saved b1) does not advance displayed but sets the
 *   route-B-qualified active anchor to b1 (B provenance).
 * - request(top A, saved a1) before B commit corrupted cache A with b1 and
 *   let the retained b1 beat the fresh a1.
 * The structural fix tracks the route provenance of the live anchor
 * explicitly; the Messages top effect reads only the route-qualified anchor
 * for the incoming target, so a foreign live anchor can never substitute the
 * target's own persisted snapshot.
 *
 * This spec proves the user-visible consequence through the real TOP
 * selector (never IPC route changes):
 * - Seed one topic (30 msgs) + one branch route; both routes get distinct
 *   exclusive anchors and distinct persisted snapshots.
 * - Establish A (branch) at a distinct non-bottom anchor with its snapshot.
 * - Rapid TOP A→B→A without waiting for the B commit (synchronize ONLY on
 *   the selected-route change, deliberately NOT on B projection settle);
 *   assert A restores its exact anchor id + offset ≤12px with its snapshot
 *   unchanged. Repeated deterministically.
 * - An ordinary committed B switch restores B independently (B snapshot intact).
 *
 * Uses the shared disposable-profile Electron fixture (fresh build, mock
 * provider). No arbitrary sleep is the trigger for the rapid return — the
 * return fires on the observed selected-route change to B.
 */
import { expect, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'
import {
  activateTopic,
  clickToolbarBranch,
  listBranches,
  prepareAssistant,
  seedSourceTopic,
  uuidLike
} from '../../utils/branch-route-setup'

const TOTAL = 30
const ANCHOR_IDX = 15

test.describe('Top-selector cross-route anchor provenance', () => {
  test.skip(process.platform !== 'darwin', 'requires macOS disposable-profile Electron lane')

  test('rapid TOP A→B→A without B commit keeps A exact anchor+snapshot; committed B restores independently', async ({
    mainWindow
  }) => {
    test.setTimeout(600000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'TOP CROSS-ROUTE PROVENANCE: branch A and main B carry distinct exclusive anchors/snapshots; rapid TOP A→B→A synchronized only on the selected-route change (never B projection settle) restores the exact A anchor id + offset ≤12px with the A snapshot unchanged; a later ordinary committed B switch restores B independently.'
    })
    const page = mainWindow
    await waitForAppReady(page)
    const assistantId = await prepareAssistant(page, TOTAL)
    const topicId = `top-prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Production-realistic digit-leading UUIDs (not letter-leading synthetic).
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `TopProv ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => uuidLike(i),
      contentPrefix: 'top-prov-'
    })
    const anchorId = ids[ANCHOR_IDX]
    await activateTopic(page, topicId, TOTAL)
    await clickToolbarBranch(page, anchorId)
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const s = (window as any).store.getState()
        return Array.isArray(s.messages?.messageIdsByTopic?.[tid]) && s.messages.messageIdsByTopic[tid].length === len
      },
      { tid: topicId, len: ANCHOR_IDX + 1 },
      { timeout: 30000 }
    )
    const branches = await listBranches(page, topicId)
    expect(branches).toHaveLength(1)
    const branchId = branches[0].id as string

    // Branch-exclusive suffix so A/B anchors are route-exclusive.
    // Production-realistic digit-leading UUIDs on both routes: any wheel-chosen
    // exclusive anchor exercises the raw-`getElementById` contract.
    const SUFFIX = 12
    const branchSuffix: string[] = []
    let after: string = anchorId
    for (let i = 0; i < SUFFIX; i++) {
      const mid = uuidLike(1000 + i)
      branchSuffix.push(mid)
      const r: any = await page.evaluate(
        async ({ tid, bid, afterId, m, asst, idx }: any) =>
          await (window as any).api.chatDb.insertMessagesAfterAnchor({
            topicId: tid,
            branchId: bid,
            afterMessageId: afterId,
            entries: [
              {
                message: {
                  id: m,
                  topicId: tid,
                  role: idx % 2 === 0 ? 'user' : 'assistant',
                  assistantId: asst,
                  status: 'success',
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-01-01T00:00:00.000Z'
                },
                blocks: []
              }
            ]
          }),
        { tid: topicId, bid: branchId, afterId: after, m: mid, asst: assistantId, idx: i }
      )
      expect(r?.ok, `suffix seed ${mid} failed: ${JSON.stringify(r)}`).toBe(true)
      after = mid
    }
    const mainExclusives = ids.slice(ANCHOR_IDX + 1)
    expect(mainExclusives.length).toBeGreaterThan(0)
    for (const bId of branchSuffix) expect(mainExclusives).not.toContain(bId)

    const scrollKeyFor = (bid: string | null): string => `scroll:topic-${topicId}::${bid ?? 'main'}`
    const waitActive = async (bid: string | null): Promise<void> => {
      await page.waitForFunction(
        ({ tid, b }: { tid: string; b: string | null }) => {
          const s = (window as any).store.getState()
          return (s.topicBranch?.activeBranchIdByTopic?.[tid] ?? null) === b
        },
        { tid: topicId, b: bid },
        { timeout: 30000 }
      )
    }
    const readAnchor = (): Promise<{ id: string; offset: number } | null> =>
      page.evaluate(() => {
        const container = document.querySelector('#messages') as HTMLElement | null
        if (!container) return null
        const c = container.getBoundingClientRect()
        const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
        const cands: { id: string; top: number; bottom: number }[] = []
        for (const row of rows) {
          const r = row.getBoundingClientRect()
          const id = row.getAttribute('data-message-id')
          if (id) cands.push({ id, top: r.top, bottom: r.bottom })
        }
        if (cands.length === 0) return null
        const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
        const picked = crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
        return { id: picked.id, offset: picked.top - c.top }
      })
    const readSnapId = async (bid: string | null): Promise<string> =>
      page.evaluate((key: string) => {
        try {
          const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
          if (!raw || typeof raw !== 'object') return ''
          const mid = typeof raw.messageId === 'string' ? raw.messageId : ''
          if (mid.length > 0) return mid
          return typeof raw.anchorId === 'string' ? raw.anchorId : ''
        } catch {
          return ''
        }
      }, scrollKeyFor(bid))
    const waitViewportVisible = async (): Promise<void> => {
      await page.waitForFunction(
        () => {
          const el = document.getElementById('messages')
          const phase = el?.getAttribute('data-viewport-phase')
          return phase === 'revealed' || phase === 'idle'
        },
        undefined,
        { timeout: 30000 }
      )
    }
    const focusMessages = async (): Promise<void> => {
      const box = await page.locator('#messages').first().boundingBox()
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    }
    const wheel = async (dy: number): Promise<void> => {
      await focusMessages()
      await page.mouse.wheel(0, dy)
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      await page.waitForTimeout(220)
    }
    const settled = async (): Promise<{ id: string; offset: number } | null> => {
      let prev: { id: string; offset: number } | null = null
      let stable = 0
      const start = Date.now()
      let cur: { id: string; offset: number } | null = null
      while (Date.now() - start < 10000) {
        cur = await readAnchor()
        if (cur && prev && cur.id === prev.id && Math.abs(cur.offset - prev.offset) <= 2) {
          stable += 1
          if (stable >= 2) return cur
        } else stable = 0
        prev = cur
        await page.waitForTimeout(140)
      }
      return cur
    }
    const wheelSeekExclusive = async (allowed: string[]): Promise<{ id: string; offset: number } | null> => {
      for (let i = 0; i < 4; i++) await wheel(-560)
      let s = await settled()
      if (s && allowed.includes(s.id)) return s
      for (let i = 0; i < 30; i++) {
        await wheel(560)
        s = await settled()
        if (s && allowed.includes(s.id)) return s
      }
      for (let i = 0; i < 30; i++) {
        await wheel(-560)
        s = await settled()
        if (s && allowed.includes(s.id)) return s
      }
      return await settled()
    }
    const waitSnapMatchesLive = async (bid: string | null, allowed: string[]): Promise<void> => {
      await page.waitForFunction(
        ({ key, ok }: any) => {
          try {
            const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
            if (!raw || typeof raw !== 'object') return false
            const sid =
              typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
                ? (raw.messageId as string)
                : typeof raw.anchorId === 'string'
                  ? (raw.anchorId as string)
                  : ''
            if (!sid || !ok.includes(sid)) return false
            const container = document.querySelector('#messages') as HTMLElement | null
            if (!container) return false
            const c = container.getBoundingClientRect()
            const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
            const cands: { id: string; top: number; bottom: number }[] = []
            for (const row of rows) {
              const r = row.getBoundingClientRect()
              const id = row.getAttribute('data-message-id')
              if (id) cands.push({ id, top: r.top, bottom: r.bottom })
            }
            if (cands.length === 0) return false
            const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
            const picked = crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
            return picked.id === sid
          } catch {
            return false
          }
        },
        { key: scrollKeyFor(bid), ok: allowed },
        { timeout: 30000 }
      )
    }
    const topTo = async (bid: string | null): Promise<void> => {
      await page.locator('[data-testid="branch-selector-entry"]').first().click()
      await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
      if (bid === null) {
        await page.locator('[data-testid="branch-cascader-item-main"]').first().click()
      } else {
        await page.locator(`[data-testid="branch-cascader-item-${bid}"]`).first().click()
      }
    }

    // Establish A (branch) at a distinct non-bottom exclusive anchor.
    await waitActive(branchId)
    await topTo(null)
    await waitActive(null)
    await page.waitForFunction(() => document.querySelectorAll('#messages [data-message-id]').length >= 1, undefined, {
      timeout: 30000
    })
    await topTo(branchId)
    await waitActive(branchId)
    await page.waitForFunction(() => document.querySelectorAll('#messages [data-message-id]').length >= 1, undefined, {
      timeout: 30000
    })
    let aAnchor = await wheelSeekExclusive(branchSuffix)
    expect(aAnchor, 'A must expose a stable exclusive anchor via real wheel').not.toBeNull()
    expect(branchSuffix).toContain(aAnchor?.id)
    aAnchor = await settled()
    await waitViewportVisible()
    await waitSnapMatchesLive(branchId, branchSuffix)
    const aSnapEstablished = await readSnapId(branchId)
    expect(aSnapEstablished, 'A snapshot must equal the live exclusive anchor').toBe(aAnchor?.id)
    expect(aAnchor?.id, 'A anchor must be non-top').not.toBe(ids[0])

    // Establish B (main) at its own distinct exclusive anchor + snapshot.
    await topTo(null)
    await waitActive(null)
    await page.waitForFunction(() => document.querySelectorAll('#messages [data-message-id]').length >= 1, undefined, {
      timeout: 30000
    })
    let bAnchor = await wheelSeekExclusive(mainExclusives)
    expect(bAnchor, 'B must expose a stable exclusive anchor via real wheel').not.toBeNull()
    expect(mainExclusives).toContain(bAnchor?.id)
    expect(bAnchor?.id).not.toBe(aAnchor?.id)
    bAnchor = await settled()
    await waitViewportVisible()
    await waitSnapMatchesLive(null, mainExclusives)
    const bSnapEstablished = await readSnapId(null)
    expect(bSnapEstablished, 'B snapshot must equal the live exclusive anchor').toBe(bAnchor?.id)
    const bIdBaseline = bAnchor?.id ?? ''
    const bSnapBaseline = bSnapEstablished

    // Re-establish A baseline immediately before the rapid loop.
    await topTo(branchId)
    await waitActive(branchId)
    await page.waitForFunction(() => document.querySelectorAll('#messages [data-message-id]').length >= 1, undefined, {
      timeout: 30000
    })
    await waitViewportVisible()
    const aBaseline = await settled()
    expect(aBaseline, 'A baseline must be measurable before rapid loop').not.toBeNull()
    await waitSnapMatchesLive(branchId, branchSuffix)
    const aIdBaseline = aBaseline?.id ?? ''
    const aOffsetBaseline = aBaseline?.offset ?? 0
    const aSnapBaseline = await readSnapId(branchId)
    expect(aSnapBaseline, 'A baseline snapshot must track the live anchor').toBe(aIdBaseline)
    expect(branchSuffix).toContain(aIdBaseline)
    expect(aIdBaseline).not.toBe(bIdBaseline)
    // Realistic-ID guard: both planned restore anchors must be digit-leading
    // UUID shapes where CSS.escape differs, so the old escaped getElementById
    // would miss while raw connects. No fixed waits; exact id+offset below.
    for (const [label, id] of [
      ['A', aIdBaseline],
      ['B', bIdBaseline]
    ] as const) {
      expect(/^[0-9]/.test(id), `${label} anchor must be digit-leading`).toBe(true)
      const escapeDiffers = await page.evaluate((mid: string) => {
        try {
          return (CSS as any).escape(mid) !== mid
        } catch {
          return false
        }
      }, id)
      expect(escapeDiffers, `${label} anchor must differ under CSS.escape`).toBe(true)
    }

    // Rapid TOP A→B→A WITHOUT waiting for the B commit. The return fires on
    // the observed selected-route change to B (waitActive(null)) —
    // deliberately never on B projection settle / viewport visible. Repeat
    // deterministically.
    for (let round = 0; round < 3; round++) {
      await topTo(null)
      // Selected-route change observed; B projection explicitly NOT awaited.
      await waitActive(null)
      await topTo(branchId)
      await waitActive(branchId)
      await page.waitForFunction(
        (min: number) => document.querySelectorAll('#messages [data-message-id]').length >= min,
        1,
        { timeout: 30000 }
      )
      await waitViewportVisible()
      const aBack = await settled()
      expect(aBack, `round ${round}: A anchor must be measurable after rapid return`).not.toBeNull()
      expect(aBack?.id, `round ${round}: rapid return must restore the exact A anchor (never B contamination)`).toBe(
        aIdBaseline
      )
      expect(
        Math.abs((aBack?.offset ?? 0) - aOffsetBaseline),
        `round ${round}: A offset must stay within 12px`
      ).toBeLessThanOrEqual(12)
      const aSnapNow = await readSnapId(branchId)
      expect(aSnapNow, `round ${round}: A snapshot must stay unchanged`).toBe(aSnapBaseline)
      expect(aSnapNow).not.toBe(bIdBaseline)
    }

    // Ordinary committed B switch restores B independently.
    await topTo(null)
    await waitActive(null)
    await page.waitForFunction(() => document.querySelectorAll('#messages [data-message-id]').length >= 1, undefined, {
      timeout: 30000
    })
    await waitViewportVisible()
    const bBack = await settled()
    expect(bBack, 'committed B switch must leave a measurable anchor').not.toBeNull()
    await waitSnapMatchesLive(null, mainExclusives)
    const bSnapNow = await readSnapId(null)
    expect(bSnapNow, 'committed B switch must restore the B snapshot independently').toBe(bSnapBaseline)
    expect(mainExclusives).toContain(bSnapNow)
    expect(bSnapNow).not.toBe(aIdBaseline)
  })
})
