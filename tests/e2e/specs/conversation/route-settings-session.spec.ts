/**
 * Implicit route browsing session continuity across Chat→Settings→Chat.
 *
 * FOCUSED E2E (real UI, real IPC, real SQLite, shared fixture, disposable
 * profile, mock provider, fresh build):
 * - Seed one topic (30 msgs) + one branch route with distinct exclusive
 *   anchors/snapshots on main vs branch (BEFORE settings, distinguishable).
 * - Chat→Settings→Chat roundtrip through the production Sidebar (Activity
 *   hidden boundary): the Chat DOM session persists hidden, no remount.
 * - AFTER the roundtrip: >=2 ordinary top-selector route cycles restore each
 *   target's last legal stable messageId+offset (never outgoing geometry).
 * - User wheel to a NEW stable location on the branch, switch away/back:
 *   the new location restores (scroll/save/restore keep working).
 * - Leaving during an in-flight restore: rapid TOP A→B→A synchronized ONLY
 *   on the selected-route change (never B projection settle) keeps the exact
 *   A anchor+snapshot with only the newest completion; a committed B switch
 *   restores B independently.
 * - Divider explicit continue-here: from main, a flat divider peer switch to
 *   the branch preserves the current shared-anchor offset even though the
 *   branch historic snapshot points at a different exclusive anchor (never
 *   the target snapshot/bottom).
 *
 * Reuses branch-route-setup helpers + the top-cross-route-provenance wheel /
 * anchor / snapshot patterns. No real data, no live APIs.
 */
import { expect, test } from '../../fixtures/electron.fixture'
import { SidebarPage } from '../../pages/sidebar.page'
import { waitForAppReady, waitForChatReady, waitForSettingsLoad } from '../../utils/wait-helpers'
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

test.describe('Implicit route session — Settings roundtrip + ordinary cycles + wheel + in-flight + divider', () => {
  test.skip(process.platform !== 'darwin', 'requires macOS disposable-profile Electron lane')

  test('settings roundtrip retains session; >=2 cycles restore; wheel relocates; rapid keeps newest; divider keeps offset', async ({
    mainWindow
  }) => {
    test.setTimeout(600000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'ROUTE SETTINGS SESSION: distinct main/branch anchors before Settings; Chat->Settings->Chat preserves the DOM session; >=2 ordinary top cycles after restore exact anchors; wheel to a new branch location restores after away/back; rapid A→B→A keeps only the newest completion; flat divider peer switch preserves the current shared-anchor offset despite a different historic branch snapshot.'
    })
    const page = mainWindow
    await waitForAppReady(page)
    await waitForChatReady(page)
    const sidebarPage = new SidebarPage(page)
    const assistantId = await prepareAssistant(page, TOTAL)
    const topicId = `route-sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `RouteSess ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => uuidLike(i),
      contentPrefix: 'route-sess-'
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

    // Branch-exclusive suffix so main/branch anchors are route-exclusive.
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
    const settled = async (): Promise<{ id: string; offset: number }> => {
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
      // Robust failure: a settle timeout must fail loudly so an unsettled
      // viewport can never pass as a stable restore.
      throw new Error(`viewport failed to settle within 10s (last=${cur ? `${cur.id}@${cur.offset}` : 'null'})`)
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
    const reportSnapTimeout = async (bid: string | null, allowed: string[]): Promise<void> => {
      const ctx = await page
        .evaluate(
          ({ tid, b, ok }: { tid: string; b: string | null; ok: string[] }) => {
            const out: Record<string, unknown> = { route: b ?? 'main' }
            try {
              const key = `scroll:topic-${tid}::${b ?? 'main'}`
              let rawVal: unknown = null
              try {
                rawVal = (window as any).keyv?.get?.(key) ?? null
              } catch (e) {
                rawVal = `err:${e instanceof Error ? e.message : String(e)}`
              }
              out.snapRaw =
                rawVal && typeof rawVal === 'object'
                  ? JSON.stringify(rawVal).slice(0, 400)
                  : String(rawVal ?? '(missing)')
              const raw = rawVal as Record<string, unknown> | null
              const sid =
                raw && typeof raw === 'object'
                  ? typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
                    ? (raw.messageId as string)
                    : typeof raw.anchorId === 'string'
                      ? (raw.anchorId as string)
                      : ''
                  : ''
              out.snapId = sid || '(none-in-allowed)'
              out.snapInAllowed = sid ? (ok as string[]).includes(sid) : false
              const container = document.querySelector('#messages') as HTMLElement | null
              const c = container?.getBoundingClientRect() ?? null
              const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
              let testAnchor = '(none)'
              if (c && rows.length > 0) {
                const cands = rows
                  .map((row) => {
                    const r = row.getBoundingClientRect()
                    return { id: row.getAttribute('data-message-id') as string, top: r.top, bottom: r.bottom }
                  })
                  .filter((x) => x.id)
                const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
                const picked =
                  crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
                testAnchor = `${picked.id}@${Math.round((picked.top - c.top) * 10) / 10}`
              }
              out.testAnchor = testAnchor
              out.testInAllowed = testAnchor.split('@')[0] ? (ok as string[]).includes(testAnchor.split('@')[0]) : false
              let prodAnchor = '(none)'
              try {
                if (container && c) {
                  const els = Array.from(
                    container.querySelectorAll('[id^="message-"]:not([id^="message-group-"])')
                  ) as HTMLElement[]
                  const pc: { id: string; top: number; bottom: number }[] = []
                  for (const el of els) {
                    const cs = getComputedStyle(el)
                    if (cs.display === 'none') continue
                    const r = el.getBoundingClientRect()
                    if (r.height === 0) continue
                    if (!(Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) > 0)) continue
                    const id = el.id.replace(/^message-/, '')
                    if (id) pc.push({ id, top: r.top, bottom: r.bottom })
                  }
                  if (pc.length > 0) {
                    let cross: { id: string; top: number; bottom: number } | null = null
                    for (const cd of pc) {
                      if (cd.top <= c.top && cd.bottom > c.top && (!cross || cd.top < cross.top)) cross = cd
                    }
                    const picked = cross ?? pc.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? pc[0]
                    prodAnchor = `${picked.id}@${Math.round((picked.top - c.top) * 10) / 10}`
                  }
                }
              } catch {
                prodAnchor = '(err)'
              }
              out.prodAnchor = prodAnchor
              out.phase = container?.getAttribute('data-viewport-phase') ?? '(no-container)'
              const st = (window as any).store?.getState?.() as Record<string, any> | undefined
              out.currentTopic = st?.messages?.currentTopicId ?? '(unknown)'
              out.selectedRoute = st?.topicBranch?.activeBranchIdByTopic?.[tid] ?? '(unknown)'
              const loaded: string[] = Array.isArray(st?.messages?.messageIdsByTopic?.[tid])
                ? (st.messages.messageIdsByTopic[tid] as string[])
                : []
              out.loadedLen = loaded.length
              out.loadedHead = loaded.slice(0, 3)
              out.loadedTail = loaded.slice(-3)
              const domIds = rows.map((r) => r.getAttribute('data-message-id') as string)
              out.domLen = domIds.length
              out.domHead = domIds.slice(0, 3)
              out.domTail = domIds.slice(-3)
              const focusId = testAnchor.split('@')[0]
              let idx = domIds.indexOf(focusId)
              if (idx < 0) idx = 0
              const picks = new Set<number>()
              for (let i = 0; i < Math.min(4, domIds.length); i++) picks.add(i)
              for (let d = -2; d <= 2; d++) {
                const j = idx + d
                if (j >= 0 && j < domIds.length) picks.add(j)
              }
              if (domIds.length > 0) picks.add(domIds.length - 1)
              const geom: string[] = []
              for (const j of Array.from(picks).sort((a, b) => a - b)) {
                const row = rows[j]
                if (!row) continue
                const r = row.getBoundingClientRect()
                geom.push(`${domIds[j]} t=${Math.round(r.top)} b=${Math.round(r.bottom)}`)
              }
              out.geom = geom
              out.allowedLen = (ok as string[]).length
            } catch (e) {
              out.error = e instanceof Error ? e.message : String(e)
            }
            return out
          },
          { tid: topicId, b: bid, ok: allowed }
        )
        .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }))
      const summary =
        `routeSnapTimeout route=${String((ctx as Record<string, unknown>).route)} snapId=${String((ctx as Record<string, unknown>).snapId)} snapInAllowed=${String((ctx as Record<string, unknown>).snapInAllowed)} allowedLen=${String((ctx as Record<string, unknown>).allowedLen)} ` +
        `testAnchor=${String((ctx as Record<string, unknown>).testAnchor)} testInAllowed=${String((ctx as Record<string, unknown>).testInAllowed)} ` +
        `prodAnchor=${String((ctx as Record<string, unknown>).prodAnchor)} phase=${String((ctx as Record<string, unknown>).phase)} ` +
        `current=${String((ctx as Record<string, unknown>).currentTopic)} selected=${JSON.stringify((ctx as Record<string, unknown>).selectedRoute)} ` +
        `loadedLen=${String((ctx as Record<string, unknown>).loadedLen)} domLen=${String((ctx as Record<string, unknown>).domLen)} ` +
        `snapRaw=${String((ctx as Record<string, unknown>).snapRaw).slice(0, 400)} geom=[${(((ctx as Record<string, unknown>).geom as string[] | undefined) ?? []).join(' | ').slice(0, 800)}]`
      try {
        // eslint-disable-next-line no-console
        console.log(`[E2E] ${summary}`)
      } catch {}
      test.info().annotations.push({ type: `route-snap-timeout-${bid ?? 'main'}`, description: summary.slice(0, 1900) })
    }
    const waitSnapMatchesLive = async (bid: string | null, allowed: string[]): Promise<void> => {
      try {
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
              const picked =
                crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
              return picked.id === sid
            } catch {
              return false
            }
          },
          { key: scrollKeyFor(bid), ok: allowed },
          { timeout: 30000 }
        )
      } catch (err) {
        await reportSnapTimeout(bid, allowed)
        throw err
      }
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
    const visualOffsetOf = async (messageId: string): Promise<number | null> =>
      page.evaluate((id: string) => {
        const container = document.querySelector('#messages') as HTMLElement | null
        const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
        const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
        if (!container || !el) return null
        return el.getBoundingClientRect().top - container.getBoundingClientRect().top
      }, messageId)

    // BEFORE settings: distinguishable main/branch anchors + snapshots.
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
    expect(aAnchor, 'branch must expose a stable exclusive anchor via real wheel').not.toBeNull()
    aAnchor = await settled()
    await waitViewportVisible()
    await waitSnapMatchesLive(branchId, branchSuffix)
    const aIdBefore = aAnchor?.id ?? ''
    const aOffsetBefore = aAnchor?.offset ?? 0
    const aSnapBefore = await readSnapId(branchId)
    expect(aSnapBefore).toBe(aIdBefore)

    await topTo(null)
    await waitActive(null)
    await page.waitForFunction(() => document.querySelectorAll('#messages [data-message-id]').length >= 1, undefined, {
      timeout: 30000
    })
    let bAnchor = await wheelSeekExclusive(mainExclusives)
    expect(bAnchor, 'main must expose a stable exclusive anchor via real wheel').not.toBeNull()
    bAnchor = await settled()
    await waitViewportVisible()
    await waitSnapMatchesLive(null, mainExclusives)
    const bIdBefore = bAnchor?.id ?? ''
    const bOffsetBefore = bAnchor?.offset ?? 0
    const bSnapBefore = await readSnapId(null)
    expect(bSnapBefore).toBe(bIdBefore)
    expect(aIdBefore).not.toBe(bIdBefore)

    // Settings roundtrip through the production Sidebar (Activity boundary).
    const homeHandle = await page.locator('#home-page').elementHandle()
    expect(homeHandle).not.toBeNull()
    await sidebarPage.goToSettings()
    await waitForSettingsLoad(page)
    expect(page.url()).toContain('/settings')
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('#home-page')).toBeHidden({ timeout: 10000 })
    await sidebarPage.goToHome()
    await waitForChatReady(page)
    await expect(page.locator('#home-page')).toBeVisible({ timeout: 15000 })
    expect(await homeHandle!.evaluate((node: Node) => node.isConnected)).toBe(true)

    // CG1: immediate same-route reconnect restores BEFORE any topTo. The
    // detached lifetime renews with a fresh guarded own-target activation on
    // return: live id/offset plus the persisted snapshot must already equal
    // the pre-detour main baseline with no intervening route switch.
    await waitViewportVisible()
    const immediateBack = await settled()
    expect(immediateBack, 'immediate reconnect must leave a measurable anchor').not.toBeNull()
    expect(immediateBack?.id, 'immediate reconnect restores main own anchor').toBe(bIdBefore)
    expect(
      Math.abs((immediateBack?.offset ?? 0) - bOffsetBefore),
      'immediate reconnect main offset'
    ).toBeLessThanOrEqual(12)
    expect(await readSnapId(null), 'immediate reconnect main snapshot intact').toBe(bSnapBefore)

    // AFTER: >=2 ordinary route cycles restore each target's last stable anchor.
    for (let round = 0; round < 2; round++) {
      await topTo(branchId)
      await waitActive(branchId)
      await page.waitForFunction(
        (min: number) => document.querySelectorAll('#messages [data-message-id]').length >= min,
        1,
        { timeout: 30000 }
      )
      await waitViewportVisible()
      const aBack = await settled()
      expect(aBack?.id, `round ${round}: branch restores its own anchor`).toBe(aIdBefore)
      expect(Math.abs((aBack?.offset ?? 0) - aOffsetBefore), `round ${round}: branch offset`).toBeLessThanOrEqual(12)
      expect(await readSnapId(branchId), `round ${round}: branch snapshot intact`).toBe(aSnapBefore)

      await topTo(null)
      await waitActive(null)
      await page.waitForFunction(
        (min: number) => document.querySelectorAll('#messages [data-message-id]').length >= min,
        1,
        { timeout: 30000 }
      )
      await waitViewportVisible()
      const bBack = await settled()
      expect(bBack?.id, `round ${round}: main restores its own anchor`).toBe(bIdBefore)
      expect(Math.abs((bBack?.offset ?? 0) - bOffsetBefore), `round ${round}: main offset`).toBeLessThanOrEqual(12)
      expect(await readSnapId(null), `round ${round}: main snapshot intact`).toBe(bSnapBefore)
    }

    // User wheel to a NEW stable branch location; switch away/back restores it.
    await topTo(branchId)
    await waitActive(branchId)
    await page.waitForFunction(() => document.querySelectorAll('#messages [data-message-id]').length >= 1, undefined, {
      timeout: 30000
    })
    await waitViewportVisible()
    const otherBranchTargets = branchSuffix.filter((id) => id !== aIdBefore)
    expect(otherBranchTargets.length).toBeGreaterThan(0)
    let aNew = await wheelSeekExclusive(otherBranchTargets)
    expect(aNew, 'wheel must reach a different branch exclusive').not.toBeNull()
    expect(aNew?.id).not.toBe(aIdBefore)
    aNew = await settled()
    await waitViewportVisible()
    await waitSnapMatchesLive(branchId, branchSuffix)
    const aNewId = aNew?.id ?? ''
    const aNewOffset = aNew?.offset ?? 0
    const aNewSnap = await readSnapId(branchId)
    expect(aNewSnap).toBe(aNewId)
    await topTo(null)
    await waitActive(null)
    await page.waitForFunction(() => document.querySelectorAll('#messages [data-message-id]').length >= 1, undefined, {
      timeout: 30000
    })
    await waitViewportVisible()
    await topTo(branchId)
    await waitActive(branchId)
    await page.waitForFunction(() => document.querySelectorAll('#messages [data-message-id]').length >= 1, undefined, {
      timeout: 30000
    })
    await waitViewportVisible()
    const aRelocated = await settled()
    expect(aRelocated?.id, 'relocated branch anchor restores after away/back').toBe(aNewId)
    expect(Math.abs((aRelocated?.offset ?? 0) - aNewOffset), 'relocated branch offset').toBeLessThanOrEqual(12)

    // CG2a truthful rapid A→B→A: the intermediate B leg synchronizes ONLY on
    // the selected-route change (waitActive) — never B projection settle,
    // never waitViewportVisible/settled on B. The return to A fires immediately
    // after B is selected, so only the newest (A) completion may win.
    for (let round = 0; round < 2; round++) {
      await topTo(null)
      await waitActive(null)
      // No B settle here by construction (no waitViewportVisible/settled).
      await topTo(branchId)
      await waitActive(branchId)
      await page.waitForFunction(
        (min: number) => document.querySelectorAll('#messages [data-message-id]').length >= min,
        1,
        { timeout: 30000 }
      )
      await waitViewportVisible()
      const aRapid = await settled()
      expect(aRapid?.id, `rapid round ${round}: newest A wins`).toBe(aNewId)
      expect(Math.abs((aRapid?.offset ?? 0) - aNewOffset), `rapid round ${round}: offset`).toBeLessThanOrEqual(12)
      expect(await readSnapId(branchId), `rapid round ${round}: A snapshot unchanged`).toBe(aNewSnap)
    }
    // CG2b true in-flight Settings detour: hold the target window provider via
    // the existing safe store.dispatch gate (contextBridge freezes
    // window.api.chatDb, so dispatch is the closest faithful seam), start a
    // branch restore, then navigate to Settings WHILE its load is held
    // (deterministic held >=1, never settled). Detach cancels it; return
    // reactivates to the newest completion with no stale reveal/capture. The
    // late held resolution must void without publishing or mutating.
    // Baseline on main first WITHOUT the gate (the gate would hold this
    // re-establish); install only before the held branch restore below.
    await topTo(null)
    await waitActive(null)
    await page.waitForFunction(() => document.querySelectorAll('#messages [data-message-id]').length >= 1, undefined, {
      timeout: 30000
    })
    await waitViewportVisible()
    await waitSnapMatchesLive(null, mainExclusives)
    const gateKey = '__route_sess_inflight_gate'
    await installInFlightGate(page, gateKey, topicId)
    let gateRemoved = false
    try {
      // Arm holds thunk-function dispatches; start the branch restore.
      await topTo(branchId)
      await waitActive(branchId)
      await page.waitForFunction(
        (k: string) =>
          Boolean((window as unknown as Record<string, unknown>)[k]) &&
          ((window as unknown as Record<string, { held: unknown[] }>)[k] as { held: unknown[] }).held.length >= 1,
        gateKey,
        { timeout: 30000 }
      )
      // Disarm so the reactivation passes; the already-held branch load stays held.
      await disarmInFlightGate(page, gateKey)
      // Navigate while the restore is genuinely in-flight (held, never settled).
      await sidebarPage.goToSettings()
      await waitForSettingsLoad(page)
      await expect(page.locator('#home-page')).toBeHidden({ timeout: 10000 })
      await sidebarPage.goToHome()
      await waitForChatReady(page)
      await expect(page.locator('#home-page')).toBeVisible({ timeout: 15000 })
      // Reactivation is the newest completion: branch own anchor + snapshot.
      await waitViewportVisible()
      const inflightBack = await settled()
      expect(inflightBack, 'in-flight detour must still restore the newest branch anchor').not.toBeNull()
      expect(inflightBack?.id, 'in-flight detour newest completion wins').toBe(aNewId)
      expect(Math.abs((inflightBack?.offset ?? 0) - aNewOffset), 'in-flight detour offset').toBeLessThanOrEqual(12)
      expect(await readSnapId(branchId), 'in-flight detour branch snapshot').toBe(aNewSnap)
      expect(await readSnapId(null), 'in-flight detour must not pollute main snapshot').toBe(bSnapBefore)
      const domBeforeRelease: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
          (r) => r.getAttribute('data-message-id') as string
        )
      )
      const anchorBeforeRelease = await settled()
      const release = await releaseInFlightGate(page, gateKey)
      expect(release.total, 'late release must flush the held restore').toBeGreaterThanOrEqual(1)
      expect(release.errors, 'late restore must resolve without transport error').toEqual([])
      expect(release.voided, 'late stale restore must void via production guards').toBeGreaterThanOrEqual(1)
      await waitViewportVisible()
      const domAfterRelease: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
          (r) => r.getAttribute('data-message-id') as string
        )
      )
      // Same-route held rebase may legitimately reconcile window quota (trim
      // oldest shared prefix) while the stable anchor/snapshot stay — the
      // stale-proof invariants are anchor id/offset + snapshots + exclusives,
      // not exact DOM identity (cross-route held loads void with zero DOM
      // effect; same-route held loads rebase the selected route). Record the
      // delta for diagnosis, assert no stale reveal/capture below.
      test.info().annotations.push({
        type: 'inflight-dom-delta',
        description: `before=${domBeforeRelease.length} after=${domAfterRelease.length} dropped=${domBeforeRelease.filter((id) => !domAfterRelease.includes(id)).join(',')}`
      })
      const anchorAfterRelease = await settled()
      expect(anchorAfterRelease?.id, 'late stale completion must not move anchor').toBe(anchorBeforeRelease?.id)
      expect(
        Math.abs((anchorAfterRelease?.offset ?? 0) - (anchorBeforeRelease?.offset ?? 0)),
        'late stale completion must not drift offset'
      ).toBeLessThanOrEqual(12)
      expect(await readSnapId(branchId), 'late stale completion must not touch branch snapshot').toBe(aNewSnap)
      expect(await readSnapId(null), 'late stale completion must not touch main snapshot').toBe(bSnapBefore)
      const branchPresentAfter = domAfterRelease.filter((mid) => branchSuffix.includes(mid))
      expect(branchPresentAfter.length, 'branch exclusives must stay present after late release').toBeGreaterThan(0)
      for (const mid of mainExclusives) {
        const count: number = await page.evaluate(
          (id: string) => document.querySelectorAll(`#messages [data-message-id="${id}"]`).length,
          mid
        )
        expect(count, 'main exclusives must stay absent on branch after late release').toBe(0)
      }
    } finally {
      gateRemoved = await removeInFlightGate(page, gateKey)
    }
    expect(gateRemoved, 'in-flight gate must restore store.dispatch exactly').toBe(true)
    await topTo(null)
    await waitActive(null)
    await page.waitForFunction(() => document.querySelectorAll('#messages [data-message-id]').length >= 1, undefined, {
      timeout: 30000
    })
    await waitViewportVisible()
    await waitSnapMatchesLive(null, mainExclusives)
    expect(await readSnapId(null)).toBe(bSnapBefore)

    // Divider explicit continue-here: current offset wins over historic target snapshot.
    // Deterministic prep via real wheel only (never direct scrollTop): coarse sweep
    // until the shared fork row is visible, then fine-center with a probed wheel
    // sign (column-reverse safe, smallest adaptation of true-branch
    // vcWheelPositionDivider). The restored main-exclusive position (msg16..29)
    // never shows the fork, so this prep must wheel first; the click offset is
    // captured explicitly from the live fork row afterwards.
    const forkVisible = async (): Promise<boolean> =>
      page.evaluate((id: string) => {
        const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
        const container = document.querySelector('#messages') as HTMLElement | null
        const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
        if (!container || !el) return false
        const c = container.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        return r.bottom > c.top && r.top < c.bottom
      }, anchorId)
    let forkVis = await forkVisible()
    for (let i = 0; i < 24 && !forkVis; i++) {
      await wheel(-560)
      forkVis = await forkVisible()
    }
    for (let i = 0; i < 24 && !forkVis; i++) {
      await wheel(560)
      forkVis = await forkVisible()
    }
    expect(forkVis, 'fork row must be reachable via real wheel for divider prep').toBe(true)
    const forkTargetOf = async (): Promise<number> =>
      page.evaluate(() => document.querySelector('#messages')?.getBoundingClientRect().height ?? 0).then((h) => h / 2)
    const forkOff0 = await visualOffsetOf(anchorId)
    await wheel(140)
    await settled()
    const forkOff1 = await visualOffsetOf(anchorId)
    let forkSign = 1
    if (forkOff0 !== null && forkOff1 !== null) {
      const t = await forkTargetOf()
      if (Math.abs(forkOff1 - t) >= Math.abs(forkOff0 - t)) forkSign = -1
    }
    let forkLastErr: number | null = null
    let forkStale = 0
    for (let i = 0; i < 18; i++) {
      const off = await visualOffsetOf(anchorId)
      if (off === null) break
      const target = await forkTargetOf()
      const err = Math.abs(off - target)
      if (err <= 90) break
      if (forkLastErr !== null && err >= forkLastErr) {
        forkStale += 1
        if (forkStale >= 2) break
      } else {
        forkStale = 0
      }
      forkLastErr = err
      await wheel(forkSign * 140)
      await settled()
    }
    await settled()
    await waitViewportVisible()
    expect(await forkVisible(), 'fork must stay visible after wheel positioning').toBe(true)
    const offsetBefore = await visualOffsetOf(anchorId)
    expect(offsetBefore, 'shared anchor measurable before divider switch').not.toBeNull()
    const branchSnapHistoric = await readSnapId(branchId)
    expect(branchSnapHistoric, 'branch historic snapshot is a different exclusive anchor').not.toBe('')
    expect(branchSuffix).toContain(branchSnapHistoric)
    // Deliberately retained override proof: main history (pre-prep exclusive)
    // and the branch historic target point at different exclusive anchors, and
    // neither is the shared fork — so preserving the live fork offset below
    // proves an explicit divider continue-here, never the target snapshot.
    expect(branchSnapHistoric, 'branch historic must differ from main history to prove explicit override').not.toBe(
      bSnapBefore
    )
    expect(branchSnapHistoric, 'branch historic must not be the shared fork anchor').not.toBe(anchorId)
    const toggle = page.locator(`[data-testid="branch-fork-toggle-${anchorId}"]`).first()
    await expect(toggle, 'main untaken fork must be visible').toBeVisible({ timeout: 30000 })
    await toggle.click()
    const peerList = page.locator(`[data-testid="branch-fork-list-${anchorId}"]`).first()
    await expect(peerList, 'divider popup must open').toBeVisible({ timeout: 15000 })
    const branchItem = peerList.locator(`[data-testid="branch-fork-item-${branchId}"]`).first()
    await expect(branchItem, 'branch must be offered on the divider').toBeVisible({ timeout: 15000 })
    await branchItem.click()
    await waitActive(branchId)
    await page.waitForFunction(
      () => {
        const el = document.getElementById('messages')
        const phase = el?.getAttribute('data-viewport-phase')
        return phase === 'revealed' || phase === 'idle'
      },
      undefined,
      { timeout: 30000 }
    )
    const offsetAfter = await visualOffsetOf(anchorId)
    expect(offsetAfter, 'shared anchor measurable after divider switch').not.toBeNull()
    expect(
      Math.abs((offsetAfter as number) - (offsetBefore as number)),
      'divider continue-here preserves the current offset despite historic target snapshot'
    ).toBeLessThanOrEqual(12)
  })
})

// Deterministic in-flight hold (test-owned, temporary): wraps
// window.store.dispatch to HOLD thunk-function dispatches while armed.
// contextBridge freezes window.api.chatDb, so the IPC read itself cannot be
// wrapped — the dispatch seam is the closest faithful point. The held restore
// thunk is released late; production's own guards (epoch/route) decide discard
// — the test only observes the void return and the absence of stale
// reveal/capture. Everything is removed in finally.
async function installInFlightGate(page: any, key: string, topicId: string): Promise<void> {
  await page.evaluate(
    ({ k, tid }: { k: string; tid: string }) => {
      const w = window as any
      if (w[k]) throw new Error('in-flight gate already installed')
      const store = w.store
      if (!store || typeof store.dispatch !== 'function') throw new Error('store.dispatch unavailable for gate')
      const orig = store.dispatch.bind(store)
      const gate = {
        armed: true,
        tid,
        held: [] as Array<{ action: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void }>,
        orig
      }
      const wrapped = function (action: unknown, ...rest: unknown[]): unknown {
        const g = (window as any)[k] as typeof gate | undefined
        if (g && g.armed && typeof action === 'function') {
          return new Promise<unknown>((resolve, reject) => {
            g.held.push({ action, resolve, reject })
          })
        }
        return (g?.orig ?? orig)(action, ...rest)
      }
      ;(wrapped as unknown as Record<string, unknown>).__route_sess_gate = true
      w[k] = gate
      store.dispatch = wrapped
    },
    { k: key, tid: topicId }
  )
  const installed = await page.evaluate(
    (k: string) => (window as any).store?.dispatch?.__route_sess_gate === true && Boolean((window as any)[k]?.armed),
    key
  )
  expect(installed, 'in-flight gate must wrap store.dispatch while armed').toBe(true)
}

async function disarmInFlightGate(page: any, key: string): Promise<void> {
  await page.evaluate((k: string) => {
    const g = (window as any)[k]
    if (!g) throw new Error('in-flight gate missing at disarm')
    g.armed = false
  }, key)
}

async function releaseInFlightGate(
  page: any,
  key: string
): Promise<{ total: number; voided: number; errors: string[] }> {
  return await page.evaluate(async (k: string) => {
    const g = (window as any)[k] as
      | {
          armed: boolean
          held: Array<{ action: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void }>
          orig: (action: unknown) => Promise<unknown>
        }
      | undefined
    if (!g) throw new Error('in-flight gate missing at release')
    g.armed = false
    const queue = g.held.splice(0)
    let voided = 0
    const errors: string[] = []
    for (const h of queue) {
      try {
        const value = await g.orig(h.action)
        if (value === undefined) voided += 1
        h.resolve(value)
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
        h.reject(e)
      }
    }
    return { total: queue.length, voided, errors }
  }, key)
}

async function removeInFlightGate(page: any, key: string): Promise<boolean> {
  return await page.evaluate(async (k: string) => {
    const g = (window as any)[k] as
      | {
          armed: boolean
          held: Array<{ action: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void }>
          orig: (...args: unknown[]) => unknown
        }
      | undefined
    try {
      if (g) {
        g.armed = false
        const queue = g.held.splice(0)
        for (const h of queue) {
          try {
            const value = await g.orig(h.action)
            h.resolve(value)
          } catch (e) {
            h.reject(e)
          }
        }
        try {
          const store = (window as any).store
          if (store && (store.dispatch as unknown as Record<string, unknown>).__route_sess_gate) {
            store.dispatch = g.orig
          }
        } catch {}
      }
    } finally {
      delete (window as any)[k]
    }
    const store = (window as any).store
    return (
      !(window as any)[k] && !(store?.dispatch as unknown as Record<string, unknown> | undefined)?.__route_sess_gate
    )
  }, key)
}
