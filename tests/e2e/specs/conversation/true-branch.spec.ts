/**
 * Topic-internal branches — INTEGRATED E2E (real UI, real IPC, real SQLite).
 *
 * Final model: exactly ONE sidebar topic throughout. Branches are internal
 * route nodes (`topic_branches`), addressed by activeBranchId + logical
 * activeTopic. No child topics, no sidebar branch rows.
 *
 * Workflow (single test, disposable profile, mock provider, fresh build):
 * 1. Seed an ordinary source topic (30 msgs) via IPC + Redux addTopic.
 * 2. Real assistant-message toolbar click (msg-true-branch-btn) forks L1 at
 *    a mid anchor: same topicId, one branch row, effective route of stable
 *    IDs, top breadcrumb shows `Topic / <default name>`, sidebar stays one.
 *    Nested-cascader depth/hover/focus behavior is covered by
 *    src/renderer/src/pages/home/components/ChatNavBar/ChatNavbarContent/__tests__/TopicContent.branch.test.tsx;
 *    this journey uses flat divider peer
 *    navigation for every L1↔L2 and L1→main switch, keeping only a small
 *    top-selector smoke (open, initial col/breadcrumb, col-0 subtree
 *    delete, post-delete absence).
 * 3. Real top-selector rename (branch-rename-btn-*) renames DB-first; the
 *    divider + breadcrumb show the new name; the topic name is untouched.
 * 4. Bounded nested fork (parent = L1): an IPC createBranch on an
 *    INHERITED message rejects (parent-owned anchors only, including the
 *    parent fork anchor itself); an IPC createBranch on the L1-owned suffix
 *    succeeds and includes the parent-owned prefix. The inherited toolbar
 *    true-branch button stays hidden (no UI fork from inherited).
 * 5. Windowed parent restore: flat divider peer navigation only (no top
 *    cascader). L1→L2→L1 through the l2Anchor divider
 *    (branch-fork-toggle/selected-*, branch-fork-list-*, branch-fork-item-*
 *    scoped to the list), then the original-anchor divider switch
 *    (branch-fork-selected-*) to the parent/original route reloads main
 *    around the shared fork anchor (older 10 / newer 19 groups →
 *    deterministic 25-resident window, authoritative hasMoreBefore=true);
 *    the shared anchor stays in the SAME vicinity — never bottom — then a
 *    real oldest-edge scroll pages the remaining head on demand until the
 *    resident converges to full length.
 * 6. Flat divider switch back to L2 (main→L1 via the original-anchor
 *    divider, L1→L2 via the l2Anchor divider) — breadcrumb updates, no jump.
 * 7. Same-profile relaunch: catalog, names, active route, and dividers
 *    persist (in-app reload proof).
 * 8. Real top-selector Delete removes the L1 subtree (L1+L2) through col-0;
 *    the topic is indistinguishable from never-branched (no selector, no
 *    dividers).
 * 9. Post-exit SQLite (durable proof): no branch rows, 30 main-route rows
 *    with NULL branch_id, no extra topics, no duplicated prefix rows.
 *
 * The legacy overflow Copy Topic proof lives in
 * s62-answer-branch-insert.spec.ts (real prefix-cloned new topic).
 */
import * as fs from 'fs'
import { expect, test } from '../../fixtures/electron.fixture'
import {
  getChatDbPath,
  getUserDataDir,
  queryChatDbViaElectron,
  queryChatDbViaElectronWithRetry
} from '../../fixtures/electron.fixture'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { relaunchSameProfile } from '../../utils/restart-electron-profile'
import { waitForAppReady } from '../../utils/wait-helpers'
import {
  activateTopic,
  clickToolbarBranch,
  letterMessageId,
  listBranches,
  pad,
  prepareAssistant,
  seedSmallTopic,
  seedSourceTopic
} from '../../utils/branch-route-setup'

const TOTAL = 30
const ANCHOR_IDX = 15
const INHERITED_ANCHOR_IDX = 5

const esc = (v: string): string => v.replace(/'/g, "''")

async function visualOffsetOfMessage(page: any, messageId: string): Promise<number | null> {
  return page.evaluate((id: string) => {
    const container = document.querySelector('#messages') as HTMLElement | null
    const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
    if (!container || !el) return null
    return el.getBoundingClientRect().top - container.getBoundingClientRect().top
  }, messageId)
}

async function sidebarTopicIds(page: any): Promise<string[]> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    return s.assistants.assistants.flatMap((a: any) => (a.topics ?? []).map((t: any) => t.id)).sort()
  })
}

async function scrollMetrics(page: any): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('#messages') as HTMLElement | null
    if (!el) return { scrollTop: -1, scrollHeight: -1, clientHeight: -1 }
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  })
}

async function isVisibleInMessagesViewport(page: any, messageId: string): Promise<boolean> {
  return page.evaluate((id: string) => {
    const container = document.querySelector('#messages') as HTMLElement | null
    const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
    if (!container || !el) return false
    const c = container.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return r.bottom > c.top && r.top < c.bottom
  }, messageId)
}

/**
 * Same-profile relaunch race guards (poll-based, never fixed-sleep-gated).
 *
 * Production close path (existing contract): window `close` runs the
 * Main ↔ renderer save-data handshake — Main sends `App_SaveData` with a
 * `requestId`, the renderer runs `handleSaveData` → `persistor.flush()`
 * and ALWAYS acks (`App_SaveDataAck`, success or failure), and Main
 * destroys the window only after the ack settles (bounded timeout /
 * crash degrade, never an infinite block). The E2E correctness guarantee
 * is therefore an OBSERVED persist completion before close plus OBSERVED
 * rehydration after relaunch:
 *
 * - Pre-close: `persist:cherry-studio` localStorage wire (the exact
 *   redux-persist wire representation already observed in
 *   `reasoning-effort.spec.ts`) must carry
 *   `topicBranch.activeBranchIdByTopic[topicId] === branch2Id` AND the
 *   catalog `branchesByTopic[topicId]` must contain both branch ids. Polling
 *   the wire proves the redux-persist writer flushed the active route to the
 *   disposable profile's own storage (never live user data). The wire poll
 *   stays as a diagnostic observation; the close-completion contract is
 *   that window close finishes only after the ack settled.
 * - Post-relaunch: `renderer.persistRehydrate` via the existing
 *   `__startupStageRead` seam (fallback: wire `_persist.rehydrated === true`)
 *   plus rehydrated `activeBranchIdByTopic` + catalog, all before clicking.
 *
 * Persisted contract under test (pinned, not redefined here):
 * `topicBranch` stays persisted (absent from the `blacklist` in
 * `src/renderer/src/store/index.ts`, pinned by
 * `topicBranch.restore.test.ts`); the rehydrated selection is validated
 * against the Main-authoritative catalog on first load (`branchesReceived`
 * prunes stale ids to main; `useTopic.ts` keeps the stored branch and
 * `loadTopicMessagesThunk` resolves the route at read time).
 */
const PERSIST_WIRE_KEY = 'persist:cherry-studio'

async function waitPersistWireFlushed(page: any, topicId: string, branch1Id: string, branch2Id: string): Promise<void> {
  await page.waitForFunction(
    ({ tid, b1, b2, key }: { tid: string; b1: string; b2: string; key: string }) => {
      try {
        const wire = localStorage.getItem(key)
        if (!wire) return false
        const outer = JSON.parse(wire)
        if (typeof outer.topicBranch !== 'string') return false
        const slice = JSON.parse(outer.topicBranch) as {
          branchesByTopic?: Record<string, Array<{ id: string }>>
          activeBranchIdByTopic?: Record<string, string | null>
        }
        if ((slice.activeBranchIdByTopic?.[tid] ?? null) !== b2) return false
        const ids = (slice.branchesByTopic?.[tid] ?? []).map((b) => b.id)
        return ids.includes(b1) && ids.includes(b2)
      } catch {
        return false
      }
    },
    { tid: topicId, b1: branch1Id, b2: branch2Id, key: PERSIST_WIRE_KEY },
    { timeout: 30000 }
  )
}

async function waitPersistRehydrated(page: any): Promise<void> {
  await page.waitForFunction(
    (key: string) => {
      try {
        const read = (globalThis as any).__startupStageRead
        if (typeof read === 'function') {
          const st = read()
          if (
            st &&
            st.enabled === true &&
            Array.isArray(st.records) &&
            st.records.some((r: any) => r.stage === 'renderer.persistRehydrate')
          ) {
            return true
          }
        }
      } catch {
        // Fall through to the wire fallback below.
      }
      try {
        const wire = localStorage.getItem(key)
        if (!wire) return false
        const outer = JSON.parse(wire)
        const meta = typeof outer._persist === 'string' ? JSON.parse(outer._persist) : null
        return !!meta && meta.rehydrated === true
      } catch {
        return false
      }
    },
    PERSIST_WIRE_KEY,
    { timeout: 60000 }
  )
}

async function waitRehydratedBranchState(
  page: any,
  topicId: string,
  branch1Id: string,
  branch2Id: string
): Promise<void> {
  try {
    await page.waitForFunction(
      ({ tid, b1, b2 }: { tid: string; b1: string; b2: string }) => {
        const s = (window as any).store.getState()
        if ((s.topicBranch?.activeBranchIdByTopic?.[tid] ?? null) !== b2) return false
        const ids = (s.topicBranch?.branchesByTopic?.[tid] ?? []).map((b: any) => b.id)
        return ids.includes(b1) && ids.includes(b2)
      },
      { tid: topicId, b1: branch1Id, b2: branch2Id },
      { timeout: 60000 }
    )
  } catch (err) {
    // Timeout-only diagnostic: one-shot state snapshot (branch metadata + ids
    // only, never message content/paths/credentials), then rethrow. The
    // success path performs no extra wait or behavior.
    try {
      const snapshot = await page.evaluate(
        async ({ tid, b1, b2, key }: { tid: string; b1: string; b2: string; key: string }) => {
          const pickBranch = (
            b: any
          ): { id: string; parentBranchId: string | null; anchorMessageId: string; name: string | null } => ({
            id: typeof b?.id === 'string' ? b.id : '',
            parentBranchId: (b?.parentBranchId ?? null) as string | null,
            anchorMessageId: typeof b?.anchorMessageId === 'string' ? b.anchorMessageId : '',
            name: typeof b?.name === 'string' || b?.name === null ? (b.name as string | null) : null
          })
          const live = (() => {
            try {
              const tb = (window as any).store.getState()?.topicBranch
              const catalog = Array.isArray(tb?.branchesByTopic?.[tid]) ? tb.branchesByTopic[tid].map(pickBranch) : []
              return {
                activeBranchId: (tb?.activeBranchIdByTopic?.[tid] ?? null) as string | null,
                catalog,
                catalogIds: catalog.map((b) => b.id),
                routeGeneration: (tb?.routeGenerationByTopic?.[tid] ?? null) as number | null
              }
            } catch (e) {
              return { error: e instanceof Error ? e.message : String(e) }
            }
          })()
          const persistWire = (() => {
            try {
              const wire = localStorage.getItem(key)
              if (!wire) return { present: false }
              const outer = JSON.parse(wire)
              const slice = typeof outer.topicBranch === 'string' ? JSON.parse(outer.topicBranch) : null
              const catalog = Array.isArray(slice?.branchesByTopic?.[tid])
                ? (slice.branchesByTopic[tid] as any[]).map(pickBranch)
                : []
              const persistMeta = typeof outer._persist === 'string' ? JSON.parse(outer._persist) : null
              return {
                present: true,
                activeBranchId: (slice?.activeBranchIdByTopic?.[tid] ?? null) as string | null,
                catalog,
                catalogIds: catalog.map((b) => b.id),
                rehydrated: persistMeta?.rehydrated ?? null,
                version: persistMeta?.version ?? null
              }
            } catch (e) {
              return { present: false, error: e instanceof Error ? e.message : String(e) }
            }
          })()
          const db = await (async () => {
            try {
              const res: any = await (window as any).api.chatDb.listBranches({ topicId: tid })
              if (!res || res.ok !== true) return { ok: false, error: JSON.stringify(res ?? null).slice(0, 500) }
              const branches = Array.isArray(res.value?.branches) ? (res.value.branches as any[]).map(pickBranch) : []
              return {
                ok: true,
                branches,
                ids: branches.map((b: { id: string }) => b.id),
                names: branches.map((b: { name: string | null }) => b.name)
              }
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : String(e) }
            }
          })()
          return { expected: { topicId: tid, branch1Id: b1, branch2Id: b2 }, live, persistWire, db }
        },
        { tid: topicId, b1: branch1Id, b2: branch2Id, key: PERSIST_WIRE_KEY }
      )
      await test.info().attach('rehydrated-branch-state-timeout', {
        body: JSON.stringify(snapshot, null, 2),
        contentType: 'application/json'
      })
    } catch {
      // Best-effort diagnostic only; never masks the original timeout.
    }
    throw err
  }
}

async function waitActiveRouteWindowStable(page: any, topicId: string, len: number): Promise<void> {
  await page.waitForFunction(
    ({ tid, n }: { tid: string; n: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[tid]
      return Array.isArray(ids) && ids.length === n && s.messages?.loadingByTopic?.[tid] !== true
    },
    { tid: topicId, n: len },
    { timeout: 30000 }
  )
  await page.waitForFunction((n: number) => document.querySelectorAll('#messages [data-message-id]').length >= n, len, {
    timeout: 30000
  })
}

test.describe('Topic-internal branches end-to-end', () => {
  test.skip(process.platform !== 'darwin', 'requires macOS disposable-profile Electron lane')

  test('create L1/L2 → breadcrumb → windowed parent restore → reload → subtree delete → pre-branch UI', async ({
    mainWindow,
    electronApp,
    mockPort,
    ownedTmpRoot
  }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'TRUE-BRANCH INTEGRATED UI: one sidebar topic throughout; toolbar forks local-only route nodes (no prefix clone, no topics); breadcrumb + flat fork-divider peer switching without bottom jump; same-profile relaunch persistence; subtree delete restores pre-branch UI; post-exit SQLite proves branch/row/topic integrity.'
    })
    const userDataDir = getUserDataDir()
    await waitForAppReady(mainWindow)
    const page = mainWindow
    const assistantId = await prepareAssistant(page, TOTAL)
    const sourceTopicId = `intbranch-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const topicName = `IntBranch ${sourceTopicId}`
    const sourceIds = await seedSourceTopic(page, {
      assistantId,
      topicId: sourceTopicId,
      name: topicName,
      total: TOTAL,
      messageIdForIndex: (i: number) => letterMessageId(sourceTopicId, i),
      contentPrefix: 'true-branch-'
    })
    const anchorId = sourceIds[ANCHOR_IDX]
    const inheritedAnchorId = sourceIds[INHERITED_ANCHOR_IDX]
    await test.step('seed + baseline sidebar', async () => {
      await activateTopic(page, sourceTopicId, TOTAL)
      // Baseline sidebar identity (the disposable profile may carry its own
      // default topics): no step may ever add or remove a logical topic.
      const topicsBeforeStep = await sidebarTopicIds(page)
      expect(topicsBeforeStep).toContain(sourceTopicId)
    })
    const topicsBefore = await sidebarTopicIds(page)

    // 2. Fork L1 at the mid assistant anchor via the real toolbar button.
    await test.step('fork L1 via toolbar', async () => {
      await clickToolbarBranch(page, anchorId)
      await page.waitForFunction(
        ({ tid, len }: { tid: string; len: number }) => {
          const s = (window as any).store.getState()
          const ids = s.messages?.messageIdsByTopic?.[tid]
          return Array.isArray(ids) && ids.length === len
        },
        { tid: sourceTopicId, len: ANCHOR_IDX + 1 },
        { timeout: 30000 }
      )
    })
    let branches = await listBranches(page, sourceTopicId)
    expect(branches).toHaveLength(1)
    expect(branches[0].topicId).toBe(sourceTopicId)
    expect(branches[0].parentBranchId).toBeNull()
    expect(branches[0].anchorMessageId).toBe(anchorId)
    const branch1Id = branches[0].id as string
    // Unified breadcrumb shows the branch path on the same logical topic.
    const crumb1 = await page.locator('[data-testid="branch-selector-breadcrumb"]').first().textContent()
    expect(crumb1).toContain(topicName)
    // Effective route: shared prefix through anchor with STABLE IDs (no clone).
    const routeIds: string[] = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
      sourceTopicId
    )
    expect(routeIds).toEqual(sourceIds.slice(0, ANCHOR_IDX + 1))

    // 3. Rename L1 via the top unified selector (rename/delete only).
    await test.step('rename L1 + nested fork L2', async () => {
      await page.locator('[data-testid="branch-selector-entry"]').first().click()
      await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
      await page.locator(`[data-testid="branch-rename-btn-${branch1Id}"]`).first().click()
      const renameInput = page.locator('[data-testid="branch-selector-rename-input"]').first()
      await expect(renameInput).toBeVisible({ timeout: 10000 })
      await renameInput.fill('E2E Renamed Branch')
      await renameInput.press('Enter')
      await expect(page.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
        'E2E Renamed Branch',
        { timeout: 30000 }
      )
    })
    // The logical topic name is untouched by branch rename.
    const topicNameAfter: string = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      return s.assistants.assistants.flatMap((a: any) => a.topics).find((t: any) => t.id === tid)?.name ?? ''
    }, sourceTopicId)
    expect(topicNameAfter).toBe(topicName)

    // 4. Bounded nested fork (BRANCH-7 owner-only, parent route = L1).
    // Setup-only IPC: one L1-owned suffix row through the fork-boundary
    // insert (branch anchor -> suffix start), so a parent-owned anchor exists.
    const l1SuffixId = `${sourceTopicId}-msg-l1suf`
    const l1SuffixSeed: any = await page.evaluate(
      async ({
        tid,
        bid,
        anchor,
        mid,
        asstId
      }: {
        tid: string
        bid: string
        anchor: string
        mid: string
        asstId: string
      }) =>
        await (window as any).api.chatDb.insertMessagesAfterAnchor({
          topicId: tid,
          branchId: bid,
          afterMessageId: anchor,
          entries: [
            {
              message: {
                id: mid,
                topicId: tid,
                role: 'user',
                assistantId: asstId,
                status: 'success',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              },
              blocks: []
            }
          ]
        }),
      { tid: sourceTopicId, bid: branch1Id, anchor: anchorId, mid: l1SuffixId, asstId: assistantId }
    )
    expect(l1SuffixSeed?.ok, `L1 suffix seed failed: ${JSON.stringify(l1SuffixSeed)}`).toBe(true)
    // Inherited references never fork: older ancestor + parent fork anchor.
    const nestedInherited: any = await page.evaluate(
      async ({ tid, bid, anchor }: { tid: string; bid: string; anchor: string }) =>
        await (window as any).api.chatDb.createBranch({ topicId: tid, parentBranchId: bid, anchorMessageId: anchor }),
      { tid: sourceTopicId, bid: branch1Id, anchor: inheritedAnchorId }
    )
    expect(nestedInherited?.ok, 'nested branch from inherited must reject').toBe(false)
    const nestedForkAnchor: any = await page.evaluate(
      async ({ tid, bid, anchor }: { tid: string; bid: string; anchor: string }) =>
        await (window as any).api.chatDb.createBranch({ topicId: tid, parentBranchId: bid, anchorMessageId: anchor }),
      { tid: sourceTopicId, bid: branch1Id, anchor: anchorId }
    )
    expect(nestedForkAnchor?.ok, 'nested branch from parent fork anchor must reject').toBe(false)
    branches = await listBranches(page, sourceTopicId)
    expect(branches).toHaveLength(1)
    // Parent-owned anchor succeeds and includes the parent-owned prefix.
    const nestedOwned: any = await page.evaluate(
      async ({ tid, bid, anchor }: { tid: string; bid: string; anchor: string }) =>
        await (window as any).api.chatDb.createBranch({ topicId: tid, parentBranchId: bid, anchorMessageId: anchor }),
      { tid: sourceTopicId, bid: branch1Id, anchor: l1SuffixId }
    )
    expect(nestedOwned?.ok, `nested branch from parent-owned failed: ${JSON.stringify(nestedOwned)}`).toBe(true)
    branches = await listBranches(page, sourceTopicId)
    expect(branches).toHaveLength(2)
    const branch2 = branches.find((b: any) => b.id !== branch1Id)
    expect(branch2.parentBranchId).toBe(branch1Id)
    expect(branch2.anchorMessageId).toBe(l1SuffixId)
    const branch2Id = branch2.id as string
    const l2AnchorId = l1SuffixId
    const l2ExpectedIds = [...sourceIds.slice(0, ANCHOR_IDX + 1), l1SuffixId]
    // UI fail-closed: the inherited toolbar true-branch button stays hidden
    // (no UI fork from inherited); the L1 fork anchor keeps no true-branch
    // button (inherited through L1) while its insert button stays visible
    // (sole fork-boundary exception). Older inherited refs show neither.
    const inheritedSel = `[id="message-${inheritedAnchorId}"][data-message-id="${inheritedAnchorId}"]`
    const inheritedContainer = page.locator(inheritedSel).first()
    await expect(inheritedContainer, 'inherited container must be visible on L1').toBeVisible({ timeout: 15000 })
    try {
      await inheritedContainer.hover({ timeout: 8000 })
    } catch {}
    await expect(
      inheritedContainer.locator('[data-testid="msg-true-branch-btn"]'),
      'true-branch must hide on inherited messages'
    ).toHaveCount(0, { timeout: 10000 })
    await expect(
      inheritedContainer.locator('[data-testid="msg-insert-btn"]'),
      'insert must hide on older inherited refs'
    ).toHaveCount(0, { timeout: 10000 })

    // 5. Flat divider peer navigation only (no top cascader): the bounded
    // IPC seeds bypass the UI creation thunk, so the Redux catalog still
    // holds only L1 — publish the Main-authoritative list (setup-only, same
    // effect as fetchTopicBranchesThunk, no product change). The stale L1
    // resident (missing the owned suffix) has no l2Anchor divider yet, so
    // refresh it through a real-UI L1→main→L1 divider round-trip, then run
    // the durable L1→L2→L1 flat peer navigation at l2AnchorId, and finally
    // the measured L1→main windowed restore below (taken fork shows the
    // selected branch name; switching to the parent/original route lands on
    // the SAME shared anchor, never a bottom jump).
    await test.step('windowed parent restore via divider', async () => {
      await page.evaluate(async (tid: string) => {
        const res: any = await (window as any).api.chatDb.listBranches({ topicId: tid })
        if (!res || res.ok !== true) throw new Error('catalog refresh failed')
        ;(window as any).store.dispatch({
          type: 'topicBranch/branchesReceived',
          payload: { topicId: tid, branches: res.value.branches }
        })
      }, sourceTopicId)
      const waitRoute = async (branchId: string | null, mustContain: string[]): Promise<void> => {
        await page.waitForFunction(
          ({ tid, bid }: { tid: string; bid: string | null }) => {
            const s = (window as any).store.getState()
            return (
              (s.topicBranch?.activeBranchIdByTopic?.[tid] ?? null) === bid &&
              s.messages?.loadingByTopic?.[tid] !== true
            )
          },
          { tid: sourceTopicId, bid: branchId },
          { timeout: 30000 }
        )
        await page.waitForFunction(
          ({ tid, need }: { tid: string; need: string[] }) => {
            const s = (window as any).store.getState()
            const ids = s.messages?.messageIdsByTopic?.[tid]
            return (
              Array.isArray(ids) && need.every((id) => ids.includes(id)) && s.messages?.loadingByTopic?.[tid] !== true
            )
          },
          { tid: sourceTopicId, need: mustContain },
          { timeout: 30000 }
        )
      }
      // Stale L1 → main (unmeasured refresh hop through the original-anchor
      // flat divider peer list).
      const staleTaken = page.locator(`[data-testid="branch-fork-selected-${anchorId}"]`).first()
      await expect(staleTaken, 'stale L1 taken fork must be visible').toBeVisible({ timeout: 30000 })
      await staleTaken.click()
      const staleList = page.locator(`[data-testid="branch-fork-list-${anchorId}"]`).first()
      await expect(staleList, 'original-anchor divider popup must open').toBeVisible({ timeout: 15000 })
      await staleList.locator(`[data-testid="branch-fork-item-parent-${anchorId}"]`).first().click()
      await waitRoute(null, [anchorId])
      // Main → fresh L1 (unmeasured refresh hop; the reloaded L1 resident
      // carries the owned suffix, so the l2Anchor divider renders).
      const mainToggle = page.locator(`[data-testid="branch-fork-toggle-${anchorId}"]`).first()
      await expect(mainToggle, 'main untaken fork must be visible').toBeVisible({ timeout: 30000 })
      await mainToggle.click()
      const mainList = page.locator(`[data-testid="branch-fork-list-${anchorId}"]`).first()
      await expect(mainList, 'main divider popup must open').toBeVisible({ timeout: 15000 })
      const l1FromMain = mainList.locator(`[data-testid="branch-fork-item-${branch1Id}"]`).first()
      await expect(l1FromMain, 'L1 must be offered on the main divider').toBeVisible({ timeout: 15000 })
      await l1FromMain.click()
      await waitRoute(branch1Id, [anchorId, l2AnchorId])
      // Durable L1 → L2 through the l2Anchor flat divider peer list: the
      // parent L1 option and the child L2 option share the item namespace,
      // so both clicks are scoped to branch-fork-list-${l2AnchorId}.
      const l1Untaken = page.locator(`[data-testid="branch-fork-toggle-${l2AnchorId}"]`).first()
      await expect(l1Untaken, 'L1 untaken l2Anchor fork must be visible').toBeVisible({ timeout: 30000 })
      await l1Untaken.click()
      const l1PeerList = page.locator(`[data-testid="branch-fork-list-${l2AnchorId}"]`).first()
      await expect(l1PeerList, 'l2Anchor divider popup must open on L1').toBeVisible({ timeout: 15000 })
      const l2PeerItem = l1PeerList.locator(`[data-testid="branch-fork-item-${branch2Id}"]`).first()
      await expect(l2PeerItem, 'child L2 must be offered in the flat peer list').toBeVisible({ timeout: 15000 })
      await l2PeerItem.click()
      await waitRoute(branch2Id, [anchorId, l2AnchorId])
      // Durable L2 → L1 through the same flat divider at l2AnchorId.
      const l2Taken = page.locator(`[data-testid="branch-fork-selected-${l2AnchorId}"]`).first()
      await expect(l2Taken, 'L2 taken fork must be visible').toBeVisible({ timeout: 30000 })
      await l2Taken.click()
      const l2PeerList = page.locator(`[data-testid="branch-fork-list-${l2AnchorId}"]`).first()
      await expect(l2PeerList, 'l2Anchor divider popup must open on L2').toBeVisible({ timeout: 15000 })
      const l1PeerItem = l2PeerList.locator(`[data-testid="branch-fork-item-${branch1Id}"]`).first()
      await expect(l1PeerItem, 'parent L1 must be offered in the flat peer list').toBeVisible({ timeout: 15000 })
      await l1PeerItem.click()
      await waitRoute(branch1Id, [anchorId, l2AnchorId])
      await expect(page.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
        'E2E Renamed Branch',
        { timeout: 30000 }
      )
      const takenToggle = page.locator(`[data-testid="branch-fork-selected-${anchorId}"]`).first()
      await expect(takenToggle, 'taken fork must show the selected branch name').toBeVisible({ timeout: 30000 })
      await expect(takenToggle).toContainText('E2E Renamed Branch')
      await takenToggle.click()
      const forkList = page.locator(`[data-testid="branch-fork-list-${anchorId}"]`).first()
      await expect(forkList, 'divider popup must open as an overlay').toBeVisible({ timeout: 15000 })
      // No in-flow expansion: the popup overlays content and never pushes it —
      // the option list is NOT an in-flow child of the divider row, so closed
      // and open states occupy the same layout height.
      expect(
        await page
          .locator(`[data-testid="branch-fork-divider-${anchorId}"] [data-testid="branch-fork-list-${anchorId}"]`)
          .count(),
        'divider popup must not expand in-flow'
      ).toBe(0)
      // Visual reference before the switch: the shared anchor's viewport offset.
      const offsetBefore = await visualOffsetOfMessage(page, anchorId)
      expect(offsetBefore, 'shared anchor must be measurable before divider switch').not.toBeNull()
      const parentItem = page.locator(`[data-testid="branch-fork-item-parent-${anchorId}"]`).first()
      await expect(parentItem, 'parent/original route must be offered').toBeVisible({ timeout: 15000 })
      await parentItem.click()
      // Windowed parent restore (on-demand incremental contract): the parent
      // fork read is `around` the shared anchor with the production navigation
      // quotas (older 10 / newer 19 groups) — never a full-route fetch. All
      // messages here are singleton groups (alternating user/assistant with
      // distinct askIds), so the deterministic resident window is main[5..29]:
      // 25 messages with authoritative hasMoreBefore=true (msgs 0..4 remain
      // pageable on demand) and hasMoreAfter=false (window reaches the tail).
      const PARENT_RESTORE_BEFORE_GROUPS = 10
      const PARENT_RESTORE_AFTER_GROUPS = 19
      const PARENT_RESTORE_OLDEST_IDX = ANCHOR_IDX - PARENT_RESTORE_BEFORE_GROUPS // 5
      const PARENT_RESTORE_LEN = TOTAL - PARENT_RESTORE_OLDEST_IDX // 25
      const expectedParentIds = sourceIds.slice(PARENT_RESTORE_OLDEST_IDX, TOTAL)
      // Active route is back on main (branchId null) in the same logical topic.
      await page.waitForFunction(
        (tid: string) => {
          const s = (window as any).store.getState()
          return (s.topicBranch?.activeBranchIdByTopic?.[tid] ?? null) === null
        },
        sourceTopicId,
        { timeout: 30000 }
      )
      const activeAfterParent: string | null = await page.evaluate(
        (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
        sourceTopicId
      )
      expect(activeAfterParent, 'windowed parent restore must land the active route back on main').toBeNull()
      // Loaded resident is exactly the around window: anchor included, exact
      // IDs in route order (never a bare len>0 claim).
      await page.waitForFunction(
        ({ tid, len, anchor }: { tid: string; len: number; anchor: string }) => {
          const s = (window as any).store.getState()
          const ids = s.messages?.messageIdsByTopic?.[tid]
          return (
            Array.isArray(ids) &&
            ids.length === len &&
            ids.includes(anchor) &&
            s.messages?.loadingByTopic?.[tid] !== true
          )
        },
        { tid: sourceTopicId, len: PARENT_RESTORE_LEN, anchor: anchorId },
        { timeout: 30000 }
      )
      const parentResidentIds: string[] = await page.evaluate(
        (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
        sourceTopicId
      )
      expect(parentResidentIds, 'windowed parent restore resident must be exactly main[5..29]').toEqual(
        expectedParentIds
      )
      // Authoritative completeness oracle via the same Main contract the
      // production divider switch reads (around/fork-anchor, main route):
      // older history remains available on demand; nothing newer is missing.
      const parentProbe: any = await page.evaluate(
        async ({
          topicId,
          anchor,
          before,
          after
        }: {
          topicId: string
          anchor: string
          before: number
          after: number
        }) =>
          await (window as any).api.chatDb.fetchMessagesWindow({
            kind: 'around',
            topicId,
            branchId: null,
            anchorMessageId: anchor,
            before,
            after
          }),
        {
          topicId: sourceTopicId,
          anchor: anchorId,
          before: PARENT_RESTORE_BEFORE_GROUPS,
          after: PARENT_RESTORE_AFTER_GROUPS
        }
      )
      expect(parentProbe?.ok, `parent around probe failed: ${JSON.stringify(parentProbe)}`).toBe(true)
      const parentWindow: any = parentProbe.value.window
      expect(parentWindow.kind).toBe('around')
      expect(parentWindow.completeness).toBe('window')
      expect(parentWindow.anchorMessageId).toBe(anchorId)
      expect(parentWindow.requested?.before).toBe(PARENT_RESTORE_BEFORE_GROUPS)
      expect(parentWindow.requested?.after).toBe(PARENT_RESTORE_AFTER_GROUPS)
      expect(parentWindow.returnedCount).toBe(PARENT_RESTORE_LEN)
      expect(parentWindow.firstMessageId).toBe(expectedParentIds[0])
      expect(parentWindow.lastMessageId).toBe(expectedParentIds[expectedParentIds.length - 1])
      expect(parentProbe.value.messages.map((m: any) => m.id)).toEqual(expectedParentIds)
      expect(parentWindow.hasMoreBefore, 'older head (msgs 0..4) must remain pageable on demand').toBe(true)
      expect(parentWindow.hasMoreAfter, 'windowed parent restore must reach the tail').toBe(false)
      // The shared anchor stays in view (anchor-vicinity navigation, polled —
      // the pending NAVIGATE_TO_MESSAGE resolves asynchronously after load).
      await page.waitForFunction(
        (id: string) => {
          const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
          const container = document.querySelector('#messages') as HTMLElement | null
          const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
          if (!container || !el) return false
          const c = container.getBoundingClientRect()
          const r = el.getBoundingClientRect()
          return r.bottom > c.top && r.top < c.bottom
        },
        anchorId,
        { timeout: 30000 }
      )
      expect(await isVisibleInMessagesViewport(page, anchorId)).toBe(true)
      // Visual-anchor preservation: the shared anchor's viewport offset is
      // stable across the divider switch within deterministic tolerance.
      const offsetAfter = await visualOffsetOfMessage(page, anchorId)
      expect(offsetAfter, 'shared anchor must be measurable after divider switch').not.toBeNull()
      expect(
        Math.abs((offsetAfter as number) - (offsetBefore as number)),
        'divider switch must preserve the visual reference (viewport offset stable)'
      ).toBeLessThanOrEqual(12)
      // Atomic reveal: the target window commits hidden and is revealed only
      // after pre-paint first positioning, so the switch never paints the
      // target route at a wrong scroll position. The transition must settle to
      // a visible phase (never stuck positioning/hidden).
      await page.waitForFunction(
        () => {
          const el = document.getElementById('messages')
          const phase = el?.getAttribute('data-viewport-phase')
          return phase === 'revealed' || phase === 'idle'
        },
        undefined,
        { timeout: 30000 }
      )
      const viewportPhase = await page.evaluate(
        () => document.getElementById('messages')?.getAttribute('data-viewport-phase') ?? null
      )
      expect(
        viewportPhase === 'revealed' || viewportPhase === 'idle',
        `viewport must settle visible after divider switch (got ${viewportPhase})`
      ).toBe(true)
      const after = await scrollMetrics(page)
      if (after.scrollHeight > after.clientHeight + 200) {
        expect(
          after.scrollHeight - after.scrollTop - after.clientHeight,
          'divider switch must not jump to bottom'
        ).toBeGreaterThan(200)
      }
      // On-demand paging proof via genuine wheel only (keeper contract):
      // the oldest edge loads the remaining head (msgs 0..4) through the
      // production InfiniteScroll → around → merge path, including the
      // pending older-edge replay when `next` fires while the divider restore
      // still holds scroll ownership (navigation/anchoring). Programmatic
      // scrollTop writes carry no interaction token so the route stable keeper
      // compensates them; only genuine `page.mouse.wheel` over #messages owns
      // the viewport. Column-reverse sign: bottom/newest is scrollTop≈0, the
      // oldest edge is scrollTop≈clientHeight-scrollHeight (most negative), so
      // negative deltaY (scroll up) moves toward history. Bounded sweep with
      // live geometry/resident predicates — no force, no fixed multi-second
      // wait, no scrollTop assignment, no dispatched scroll event.
      const durableWheelFocus = async (): Promise<void> => {
        const box = await page.locator('#messages').first().boundingBox()
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        }
      }
      const durableWheelStep = async (deltaY: number): Promise<void> => {
        await durableWheelFocus()
        await page.mouse.wheel(0, deltaY)
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        )
        await page.waitForTimeout(220)
      }
      const durablePagingMetrics = async (): Promise<{
        scrollTop: number
        scrollHeight: number
        clientHeight: number
        targetTop: number
        oldestDistance: number
        residentLen: number
        headId: string | null
        loading: boolean
      }> =>
        page.evaluate((tid: string) => {
          const el = document.querySelector('#messages') as HTMLElement | null
          const s = (window as any).store.getState()
          const ids = (s.messages?.messageIdsByTopic?.[tid] ?? []) as string[]
          const st = el ? el.scrollTop : -999999
          const sh = el ? el.scrollHeight : -1
          const ch = el ? el.clientHeight : -1
          return {
            scrollTop: st,
            scrollHeight: sh,
            clientHeight: ch,
            targetTop: Math.min(0, ch - sh),
            oldestDistance: sh - Math.abs(st) - ch,
            residentLen: ids.length,
            headId: ids.length > 0 ? ids[0] : null,
            loading: s.messages?.loadingByTopic?.[tid] === true
          }
        }, sourceTopicId)
      const DURABLE_WHEEL_DELTA = -560
      const DURABLE_WHEEL_MAX = 24
      const DURABLE_OLDEST_EDGE_PX = 120
      let durableWheels = 0
      for (let i = 0; i < DURABLE_WHEEL_MAX; i++) {
        const before = await durablePagingMetrics()
        if (before.residentLen === TOTAL && before.headId === sourceIds[0]) break
        if (before.oldestDistance <= DURABLE_OLDEST_EDGE_PX && !before.loading) break
        await durableWheelStep(DURABLE_WHEEL_DELTA)
        durableWheels += 1
        const stepped = await durablePagingMetrics()
        if (stepped.residentLen === TOTAL && stepped.headId === sourceIds[0]) break
        if (stepped.oldestDistance <= DURABLE_OLDEST_EDGE_PX && !stepped.loading) break
      }
      const pagingSettled = await durablePagingMetrics()
      test.info().annotations.push({
        type: 'durable-paging-wheels',
        description: `wheels=${durableWheels} deltaY=${DURABLE_WHEEL_DELTA} scrollTop=${pagingSettled.scrollTop} targetTop=${pagingSettled.targetTop} oldestDistance=${pagingSettled.oldestDistance} residentLen=${pagingSettled.residentLen} head=${pagingSettled.headId}`
      })
      // Production replay convergence: bounded genuine wheels above, then
      // deterministic polling for data convergence proves the production
      // replay completes the resident to 30 (direct path when already idle,
      // replayed intent when the wheel lands during the divider stabilizer).
      await page.waitForFunction(
        ({ tid, len }: { tid: string; len: number }) => {
          const s = (window as any).store.getState()
          const ids = s.messages?.messageIdsByTopic?.[tid]
          return Array.isArray(ids) && ids.length === len
        },
        { tid: sourceTopicId, len: TOTAL },
        { timeout: 30000 }
      )
      const fullResidentIds: string[] = await page.evaluate(
        (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
        sourceTopicId
      )
      expect(fullResidentIds, 'on-demand paging must converge the resident to the full main route').toEqual(sourceIds)
      await page.waitForFunction(
        (len: number) => document.querySelectorAll('#messages [data-message-id]').length === len,
        TOTAL,
        { timeout: 30000 }
      )
    })

    // 5b. Mutation capability on the restored main route (Main-authoritative
    // mutableMessageIds, BRANCH-4/9 owner equality): the main route permanently
    // owns the messages it created, so the fork anchor and its pre-anchor
    // main-owned prefix stay mutable while live descendants exist — forking a
    // branch never shrinks the owner capability. The resident converged to the
    // full main route above, so the capability must be the exact owner set.
    // The L1 child-route probe carries only its owned suffix: ancestor refs
    // (including the fork anchor) stay immutable there.
    const restoredMutable: string[] = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.mutableMessageIdsByTopic?.[tid] ?? [],
      sourceTopicId
    )
    const restoredRoute: string | null | undefined = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.mutableRouteByTopic?.[tid] ?? null,
      sourceTopicId
    )
    expect(restoredRoute, 'restored parent capability must be bound to the main route').toBeNull()
    // Exact owner set (order-insensitive: Redux capability is a same-route
    // window union): every main-created message, including the fork anchor and
    // the pre-anchor prefix, stays mutable while L1/L2 descendants are live.
    expect(restoredMutable.length, 'restored main capability must be exactly the full owner set').toBe(TOTAL)
    expect(new Set(restoredMutable), 'restored main capability must equal the exact main owner IDs').toEqual(
      new Set(sourceIds)
    )
    expect(restoredMutable, 'fork anchor stays mutable on its owner main route (BRANCH-4/9)').toContain(anchorId)
    expect(restoredMutable, 'pre-anchor main-owned prefix stays mutable on the main route').toContain(sourceIds[0])
    for (const prefixId of sourceIds.slice(0, 5)) {
      expect(restoredMutable, `main-owned prefix ${prefixId} stays mutable on the main route`).toContain(prefixId)
    }
    const restoredTail = sourceIds[sourceIds.length - 1]
    expect(restoredMutable, 'post-anchor main message stays mutable').toContain(restoredTail)
    // Main-authoritative proof of the same contract (not just the Redux union):
    // a latest window over the main route carries the exact owner set.
    const mainCapProbe: any = await page.evaluate(
      async ({ topicId, limit }: { topicId: string; limit: number }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId, limit }),
      { topicId: sourceTopicId, limit: TOTAL }
    )
    expect(mainCapProbe?.ok, `main capability probe failed: ${JSON.stringify(mainCapProbe)}`).toBe(true)
    expect((mainCapProbe.value.messages as any[]).map((m: any) => m.id)).toEqual(sourceIds)
    expect(new Set(mainCapProbe.value.mutableMessageIds as string[])).toEqual(new Set(sourceIds))
    expect(
      (mainCapProbe.value.mutableMessageIds as string[]).includes(anchorId),
      'fork anchor must be carried in the main owner capability'
    ).toBe(true)
    const l1CapProbe: any = await page.evaluate(
      async ({ topicId, branchId }: { topicId: string; branchId: string }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId, branchId, limit: 10 }),
      { topicId: sourceTopicId, branchId: branch1Id }
    )
    expect(l1CapProbe?.ok, `L1 capability probe failed: ${JSON.stringify(l1CapProbe)}`).toBe(true)
    // L1 owns exactly the fork-boundary suffix; inherited main prefix remains
    // read-only; L2 creation does not mutate L1. Latest-10 over the 17-row L1
    // effective route (main[0..15] + suffix) is main[7..15] + suffix.
    const l1EffectiveIds = [...sourceIds.slice(0, ANCHOR_IDX + 1), l1SuffixId]
    const expectedL1LatestIds = l1EffectiveIds.slice(-10)
    expect(expectedL1LatestIds).toEqual([...sourceIds.slice(l1EffectiveIds.length - 10, ANCHOR_IDX + 1), l1SuffixId])
    expect((l1CapProbe.value.messages as any[]).map((m: any) => m.id)).toEqual(expectedL1LatestIds)
    expect(l1CapProbe.value.mutableMessageIds as string[]).toEqual([l1SuffixId])
    expect(
      (l1CapProbe.value.mutableMessageIds as string[]).includes(anchorId),
      'ancestor refs must be excluded from the L1 child capability'
    ).toBe(false)
    // DOM: the hovered owner anchor shows mutation controls on the main route.
    await page.evaluate((id: string) => {
      const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
      if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
    }, anchorId)
    const anchorSel = `[id="message-${anchorId}"][data-message-id="${anchorId}"]`
    const anchorContainer = page.locator(anchorSel).first()
    await expect(anchorContainer, 'owner anchor container must be visible').toBeVisible({ timeout: 15000 })
    try {
      await anchorContainer.hover({ timeout: 8000 })
    } catch {
      // Hover flakiness near edges: re-anchor into view and retry once — the
      // positive assertions below require the menubar to be revealed.
      await page.evaluate((id: string) => {
        const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
        const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
        if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
      }, anchorId)
      await anchorContainer.hover({ timeout: 8000 }).catch(() => {})
    }
    await expect(
      anchorContainer.locator('[data-testid="msg-edit-btn"], [data-testid="msg-assistant-edit-btn"]'),
      'owner anchor edit control must be shown on the main route'
    ).toHaveCount(1, { timeout: 15000 })
    await expect(
      anchorContainer.locator('[data-testid="message-delete-button"]'),
      'owner anchor delete control must be shown on the main route'
    ).toHaveCount(1, { timeout: 15000 })

    // 6. Flat divider switch back to L2 (no top cascader): main→L1 through
    // the original-anchor divider, then L1→L2 through the l2Anchor flat peer
    // list. Divider switches are windowed around the fork anchor, so the
    // route contract is active L2 + resident carrying the anchor and the
    // L1-owned suffix (stable IDs, no clone) + breadcrumb keeping the branch
    // path — never an exact full-length claim. The full L2 effective route
    // (l2ExpectedIds) is re-proven after the topic switch below and after
    // relaunch, which both load the latest window.
    await test.step('divider switch back to L2', async () => {
      const backMainToggle = page.locator(`[data-testid="branch-fork-toggle-${anchorId}"]`).first()
      await expect(backMainToggle, 'main untaken fork must be visible').toBeVisible({ timeout: 30000 })
      await backMainToggle.click()
      const backMainList = page.locator(`[data-testid="branch-fork-list-${anchorId}"]`).first()
      await expect(backMainList, 'main divider popup must open').toBeVisible({ timeout: 15000 })
      const backL1Item = backMainList.locator(`[data-testid="branch-fork-item-${branch1Id}"]`).first()
      await expect(backL1Item, 'L1 must be offered on the main divider').toBeVisible({ timeout: 15000 })
      await backL1Item.click()
      await page.waitForFunction(
        ({ tid, bid }: { tid: string; bid: string }) => {
          const s = (window as any).store.getState()
          return s.topicBranch?.activeBranchIdByTopic?.[tid] === bid && s.messages?.loadingByTopic?.[tid] !== true
        },
        { tid: sourceTopicId, bid: branch1Id },
        { timeout: 30000 }
      )
      const backL1Toggle = page.locator(`[data-testid="branch-fork-toggle-${l2AnchorId}"]`).first()
      await expect(backL1Toggle, 'L1 untaken l2Anchor fork must be visible').toBeVisible({ timeout: 30000 })
      await backL1Toggle.click()
      const backL2List = page.locator(`[data-testid="branch-fork-list-${l2AnchorId}"]`).first()
      await expect(backL2List, 'l2Anchor divider popup must open').toBeVisible({ timeout: 15000 })
      const backL2Item = backL2List.locator(`[data-testid="branch-fork-item-${branch2Id}"]`).first()
      await expect(backL2Item, 'child L2 must be offered in the flat peer list').toBeVisible({ timeout: 15000 })
      await backL2Item.click()
      await expect(page.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
        'E2E Renamed Branch',
        { timeout: 30000 }
      )
      await page.waitForFunction(
        ({ tid, bid, need }: { tid: string; bid: string; need: string[] }) => {
          const s = (window as any).store.getState()
          const ids = s.messages?.messageIdsByTopic?.[tid]
          return (
            s.topicBranch?.activeBranchIdByTopic?.[tid] === bid &&
            Array.isArray(ids) &&
            need.every((id) => ids.includes(id)) &&
            s.messages?.loadingByTopic?.[tid] !== true
          )
        },
        { tid: sourceTopicId, bid: branch2Id, need: [anchorId, l2AnchorId] },
        { timeout: 30000 }
      )
      const activeAfterL2: string | null = await page.evaluate(
        (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
        sourceTopicId
      )
      expect(activeAfterL2, 'divider switch must land the active route on L2').toBe(branch2Id)
      const l2ResidentIds: string[] = await page.evaluate(
        (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
        sourceTopicId
      )
      expect(l2ResidentIds, 'L2 resident must carry the shared anchor').toContain(anchorId)
      expect(l2ResidentIds, 'L2 resident must carry the L1-owned suffix').toContain(l2AnchorId)
      // Successful selected divider UI: the taken L2 divider is attached and
      // visible after the switch (center-divider geometry itself is covered
      // by the dedicated visual-contracts test).
      await expect(
        page.locator(`[data-testid="branch-fork-selected-${l2AnchorId}"]`).first(),
        'L2 taken l2Anchor divider must be visible after switch'
      ).toBeVisible({ timeout: 30000 })
    })

    // 6b. Topic switch away/back restores the logical topic's previously
    // active branch (no reset to main). Sidebar stays logical-topic-only.
    const otherTopicId = `intbranch-other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await seedSmallTopic(page, assistantId, otherTopicId, `Other ${otherTopicId}`)
    const topicsWithOther = await sidebarTopicIds(page)
    expect(topicsWithOther).toContain(sourceTopicId)
    expect(topicsWithOther).toContain(otherTopicId)
    expect(topicsWithOther).toEqual([...topicsBefore, otherTopicId].sort())
    await activateTopic(page, otherTopicId, 4)
    // Back to the source topic: the logical topic restores its previously
    // active branch (L2, not main). The pre-switch resident was a windowed
    // divider landing, so the contract is active-route identity + resident
    // carrying the L2 anchor — never an exact full-length claim. (Cascader
    // depth/hover/focus behavior is covered by
    // src/renderer/src/pages/home/components/ChatNavBar/ChatNavbarContent/__tests__/TopicContent.branch.test.tsx
    // and stays out of this durable journey.)
    await page.locator(`[data-testid="topic-item"][data-topic-id="${sourceTopicId}"]`).first().click()
    await page.waitForFunction(
      ({ tid, bid, need }: { tid: string; bid: string; need: string[] }) => {
        const s = (window as any).store.getState()
        const ids = s.messages?.messageIdsByTopic?.[tid]
        return (
          s.topicBranch?.activeBranchIdByTopic?.[tid] === bid &&
          Array.isArray(ids) &&
          need.every((id) => ids.includes(id)) &&
          s.messages?.loadingByTopic?.[tid] !== true
        )
      },
      { tid: sourceTopicId, bid: branch2Id, need: [l2AnchorId] },
      { timeout: 30000 }
    )
    await page.waitForFunction(
      (len: number) => document.querySelectorAll('#messages [data-message-id]').length >= 1,
      1,
      { timeout: 30000 }
    )
    // The L2 route is restored: stored active branch is L2 (not main).
    // Breadcrumb same-name text already proven at first rename + L2 switch +
    // relaunch; active-route identity is the retained contract here.
    const restoredBranchId: string | null = await page.evaluate(
      (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
      sourceTopicId
    )
    expect(restoredBranchId).toBe(branch2Id)

    // 7. Same-profile relaunch: catalog, names, active route, dividers persist.
    // Race guard (no fixed-sleep correctness gate): first prove the live Redux
    // active route is branch2, then prove the redux-persist writer flushed it
    // (wire-observed) before closing. Production close additionally runs the
    // save-data handshake (App_SaveData request → handleSaveData →
    // persistor.flush() → App_SaveDataAck), so window close completing means
    // the ack settled — the polls above plus close completion (not any
    // sleep) are the durability guarantee.
    await test.step('pre-relaunch persist flush', async () => {
      await page.waitForFunction(
        ({ tid, bid }: { tid: string; bid: string }) => {
          const s = (window as any).store.getState()
          return s.topicBranch?.activeBranchIdByTopic?.[tid] === bid
        },
        { tid: sourceTopicId, bid: branch2Id },
        { timeout: 30000 }
      )
      await waitPersistWireFlushed(page, sourceTopicId, branch1Id, branch2Id)
    })
    const chatDbPath = getChatDbPath()
    expect(chatDbPath).not.toBeNull()
    await electronApp.close()
    const relaunched = await relaunchSameProfile({ userDataDir, ownedTmpRoot, mockPort })
    try {
      const page2 = relaunched.page
      await waitForAppReady(page2)
      await page2.evaluate((limit: number) => {
        ;(window as any).store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
      }, TOTAL)
      // Rehydration gate BEFORE any topic click: persist boundary observed,
      // then the rehydrated selection + catalog must already carry L1/L2 with
      // L2 active. Only then is the click allowed to resolve the route.
      await waitPersistRehydrated(page2)
      await waitRehydratedBranchState(page2, sourceTopicId, branch1Id, branch2Id)
      // Still exactly one sidebar topic; the renamed branch persists.
      await expect(page2.locator(`[data-testid="topic-item"][data-topic-id="${sourceTopicId}"]`).first()).toBeVisible({
        timeout: 30000
      })
      const topicsAfterReload: string[] = await page2.evaluate(() => {
        const st = (window as any).store.getState()
        return st.assistants.assistants.flatMap((x: any) => (x.topics ?? []).map((t: any) => t.id)).sort()
      })
      expect(topicsAfterReload).toEqual(topicsWithOther)
      const branchesAfter: any[] = await page2.evaluate(
        async (tid: string) =>
          (window as any).api.chatDb.listBranches({ topicId: tid }).then((r: any) => r.value.branches),
        sourceTopicId
      )
      expect(branchesAfter).toHaveLength(2)
      expect(branchesAfter.find((b: any) => b.id === branch1Id)?.name).toBe('E2E Renamed Branch')
      // Same-profile relaunch restores the valid selected branch: opening
      // the topic lands back on the L2 route (breadcrumb keeps the branch
      // path), not on main. Catalog, names, and dividers persist.
      await page2.locator(`[data-testid="topic-item"][data-topic-id="${sourceTopicId}"]`).first().click()
      // Post-click route gate: active route + route window stable first, then
      // the breadcrumb/L2/divider assertions (never on a half-loaded route).
      await page2.waitForFunction(
        ({ tid, bid }: { tid: string; bid: string }) => {
          const s = (window as any).store.getState()
          return s.topicBranch?.activeBranchIdByTopic?.[tid] === bid
        },
        { tid: sourceTopicId, bid: branch2Id },
        { timeout: 30000 }
      )
      await waitActiveRouteWindowStable(page2, sourceTopicId, l2ExpectedIds.length)
      // Exact L2 effective route proof at the stable point: the stable gate
      // above already guarantees the full 17-row L2 window, so the resident
      // must be exactly the L2 effective route in order (stable IDs, no clone).
      const relaunchedL2Ids: string[] = await page2.evaluate(
        (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
        sourceTopicId
      )
      expect(relaunchedL2Ids, 'relaunched L2 resident must be exactly the L2 effective route').toEqual(l2ExpectedIds)
      await expect(page2.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
        'E2E Renamed Branch',
        { timeout: 30000 }
      )
      const relaunchedBranchId: string | null = await page2.evaluate(
        (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
        sourceTopicId
      )
      expect(relaunchedBranchId).toBe(branch2Id)
      // The L2 route's own taken fork (at its parent-owned anchor) is back as well.
      await expect(page2.locator(`[data-testid="branch-fork-selected-${l2AnchorId}"]`).first()).toBeVisible({
        timeout: 30000
      })

      // 8. Top-selector smoke kept to what the durable workflow genuinely
      // needs (cascader depth/hover/focus lives in
      // src/renderer/src/pages/home/components/ChatNavBar/ChatNavbarContent/__tests__/TopicContent.branch.test.tsx):
      // open the selector, prove the initial
      // column + breadcrumb, delete the L1 subtree through col-0, then prove
      // the post-delete selector absence. No child-column navigation here.
      await page2.locator('[data-testid="branch-selector-entry"]').first().click()
      await expect(page2.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
      await expect(page2.locator('[data-testid="branch-cascader-col-0"]').first()).toBeVisible({ timeout: 15000 })
      await expect(page2.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
        'E2E Renamed Branch',
        { timeout: 30000 }
      )
      await expect(page2.locator(`[data-testid="branch-cascader-item-${branch1Id}"]`).first()).toBeVisible({
        timeout: 15000
      })
      await page2.locator(`[data-testid="branch-delete-btn-${branch1Id}"]`).first().click()
      await page2.locator('.ant-popconfirm-buttons .ant-btn-primary').first().click()
      await page2.waitForFunction(
        ({ tid }: { tid: string }) => {
          const s = (window as any).store.getState()
          return (s.topicBranch?.branchesByTopic?.[tid] ?? []).length === 0
        },
        { tid: sourceTopicId },
        { timeout: 30000 }
      )
      // Never-branched state: no selector, no fork dividers, full main route, one topic.
      await expect(page2.locator('[data-testid="branch-selector-entry"]')).toHaveCount(0, { timeout: 15000 })
      await expect(page2.locator('[data-testid^="branch-fork-divider-"]')).toHaveCount(0)
      await page2.waitForFunction(
        ({ tid, len }: { tid: string; len: number }) => {
          const s = (window as any).store.getState()
          const ids = s.messages?.messageIdsByTopic?.[tid]
          return Array.isArray(ids) && ids.length === len
        },
        { tid: sourceTopicId, len: TOTAL },
        { timeout: 30000 }
      )
      const topicsAfterDelete: string[] = await page2.evaluate(() => {
        const st = (window as any).store.getState()
        return st.assistants.assistants.flatMap((x: any) => (x.topics ?? []).map((t: any) => t.id)).sort()
      })
      expect(topicsAfterDelete).toEqual(topicsWithOther)
      // Post-delete owner capability smoke (full exact set already proven at
      // windowed parent restore): removing the L1 subtree keeps/restores the
      // main owner set with no delete hole. Main-authoritative probe.
      const postDeleteCap: any = await page2.evaluate(
        async ({ topicId, limit }: { topicId: string; limit: number }) =>
          await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId, limit }),
        { topicId: sourceTopicId, limit: TOTAL }
      )
      expect(postDeleteCap?.ok, `post-delete capability probe failed: ${JSON.stringify(postDeleteCap)}`).toBe(true)
      expect((postDeleteCap.value.messages as any[]).map((m: any) => m.id)).toEqual(sourceIds)
      expect((postDeleteCap.value.mutableMessageIds as string[]).length).toBe(TOTAL)
      expect(new Set(postDeleteCap.value.mutableMessageIds as string[])).toEqual(new Set(sourceIds))
      expect(postDeleteCap.value.mutableMessageIds as string[]).toContain(anchorId)
    } finally {
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => relaunched.app.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      // Process-settle only (not a correctness gate): the SQLite durable proof
      // below reads the file via the Electron binary after exact cleanup.
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }

    // 9. Post-exit SQLite durable proof.
    expect(chatDbPath).not.toBeNull()
    expect(fs.existsSync(chatDbPath!)).toBe(true)
    const branchRowsGone = queryChatDbViaElectron(
      chatDbPath!,
      `SELECT COUNT(*) AS n FROM topic_branches WHERE topic_id = '${esc(sourceTopicId)}'`
    )
    expect(branchRowsGone?.ok).toBe(true)
    expect(((branchRowsGone as any).rows ?? [])[0]?.n).toBe(0)
    // All 30 rows are main-route (branch_id NULL); no duplicated prefix rows.
    const srcCount = queryChatDbViaElectron(
      chatDbPath!,
      `SELECT COUNT(*) AS n FROM messages WHERE topic_id = '${esc(sourceTopicId)}'`
    )
    expect(srcCount?.ok).toBe(true)
    expect(((srcCount as any).rows ?? [])[0]?.n).toBe(TOTAL)
    const branchedRows = queryChatDbViaElectron(
      chatDbPath!,
      `SELECT COUNT(*) AS n FROM messages WHERE topic_id = '${esc(sourceTopicId)}' AND branch_id IS NOT NULL`
    )
    expect(branchedRows?.ok).toBe(true)
    expect(((branchedRows as any).rows ?? [])[0]?.n).toBe(0)
    const srcOrder = queryChatDbViaElectron(
      chatDbPath!,
      `SELECT id FROM messages WHERE topic_id = '${esc(sourceTopicId)}' ORDER BY sort_order ASC, id ASC`
    )
    expect(srcOrder?.ok).toBe(true)
    expect(((srcOrder as any).rows ?? []).map((r: any) => r.id)).toEqual(sourceIds)
    // No extra message-owning topics were ever created by branching: every
    // committed message belongs to either the single branched logical topic
    // or the step-6b switch-restore peer topic (the disposable profile may
    // own its own empty default topic rows, which carry no messages).
    const otherCount = queryChatDbViaElectron(
      chatDbPath!,
      `SELECT COUNT(*) AS n FROM messages WHERE topic_id = '${esc(otherTopicId)}'`
    )
    expect(otherCount?.ok).toBe(true)
    expect(((otherCount as any).rows ?? [])[0]?.n).toBe(4)
    const msgOwners = queryChatDbViaElectron(chatDbPath!, `SELECT DISTINCT topic_id AS id FROM messages`)
    expect(msgOwners?.ok).toBe(true)
    expect((((msgOwners as any).rows ?? []) as any[]).map((r: any) => r.id).sort()).toEqual(
      [otherTopicId, sourceTopicId].sort()
    )
  })

  test('visual contracts: new branch lands bottom, divider offset stable at center, top A-B round-trip once', async ({
    mainWindow
  }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'VISUAL-CONTRACT E2E SMOKE: new true branch lands at latest/bottom; exclusive suffix topology/residency; route-local top A-B round-trip once with distinct real-wheel exclusive anchors (exact ID + <=12px, zero scrolling in measured loop); divider offset stable at ONE center position; visible-rebase minimal smoke (>=5 shared same-object, outgoing gone/incoming present, never empty/hidden/positioning). DOM-behavior matrix lives in dividerVisibleRebase.test.tsx behavior harness.'
    })
    const page = mainWindow
    await waitForAppReady(page)
    const assistantId = await prepareAssistant(page, TOTAL)
    const topicId = `visual-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `Visual ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => letterMessageId(topicId, i),
      contentPrefix: 'true-branch-'
    })
    const anchorId = ids[ANCHOR_IDX]
    await activateTopic(page, topicId, TOTAL)

    // New true branch lands at latest/bottom (tail vicinity, scroll pinned).
    await clickToolbarBranch(page, anchorId)
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const s = (window as any).store.getState()
        return Array.isArray(s.messages?.messageIdsByTopic?.[tid]) && s.messages.messageIdsByTopic[tid].length === len
      },
      { tid: topicId, len: ANCHOR_IDX + 1 },
      { timeout: 30000 }
    )
    // Column-reverse production synonym: bottom (newest) is scrollTop ≈ 0.
    // The oldest-edge formula (scrollHeight - |scrollTop| - clientHeight) must
    // never be used for a bottom assertion — it measures the opposite edge.
    const bottomMetrics = await scrollMetrics(page)
    expect(
      Math.abs(bottomMetrics.scrollTop),
      'new branch must land at latest/bottom (column-reverse scrollTop≈0)'
    ).toBeLessThanOrEqual(120)
    const visualBranches = await listBranches(page, topicId)
    expect(visualBranches).toHaveLength(1)
    const visualBranchId = visualBranches[0].id as string
    // Precise new-branch contract (never a bare len/bottom claim): the active
    // route is the new branch, the resident is exactly the latest prefix
    // main[0..anchor] with stable IDs, and the tail (fork anchor = newest of
    // the new route) is visible in the viewport.
    const visualActiveBranch: string | null = await page.evaluate(
      (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
      topicId
    )
    expect(visualActiveBranch, 'new branch must become the active route').toBe(visualBranchId)
    const visualResidentIds: string[] = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
      topicId
    )
    expect(visualResidentIds, 'new-branch resident must be exactly the latest prefix main[0..anchor]').toEqual(
      ids.slice(0, ANCHOR_IDX + 1)
    )
    expect(await isVisibleInMessagesViewport(page, anchorId), 'new-branch tail (fork anchor) must be visible').toBe(
      true
    )

    const rafSettle = (): Promise<void> =>
      page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
    const readActiveBranch = (): Promise<string | null> =>
      page.evaluate(
        (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
        topicId
      )
    const waitActiveBranch = async (branchId: string | null): Promise<void> => {
      await page.waitForFunction(
        ({ tid, bid }: { tid: string; bid: string | null }) => {
          const s = (window as any).store.getState()
          return (s.topicBranch?.activeBranchIdByTopic?.[tid] ?? null) === bid
        },
        { tid: topicId, bid: branchId },
        { timeout: 30000 }
      )
    }
    const waitRouteWindowStable = async (minDom: number): Promise<void> => {
      await page.waitForFunction(
        ({ tid }: { tid: string }) => {
          const s = (window as any).store.getState()
          const ids = s.messages?.messageIdsByTopic?.[tid]
          return Array.isArray(ids) && ids.length > 0 && s.messages?.loadingByTopic?.[tid] !== true
        },
        { tid: topicId },
        { timeout: 30000 }
      )
      await page.waitForFunction(
        (min: number) => document.querySelectorAll('#messages [data-message-id]').length >= min,
        minDom,
        { timeout: 30000 }
      )
      await rafSettle()
    }
    const openTopSelector = async (): Promise<void> => {
      await page.locator('[data-testid="branch-selector-entry"]').first().click()
      await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    }
    // Stable viewport-top anchor (crossing-first, same semantics as the
    // production finder): the row crossing the container top, else the first
    // row at/after it. Returns the canonical messageId + intra-row offset +
    // pixel offset so round-trips can assert identity and position.
    const readStableAnchor = (): Promise<{ id: string; intra: number; offset: number } | null> =>
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
        return { id: picked.id, intra: picked.top - c.top, offset: picked.top - c.top }
      })
    const measureDivider = (): Promise<number | null> =>
      page.evaluate((a: string) => {
        const container = document.querySelector('#messages') as HTMLElement | null
        const row = document.querySelector(`[data-testid="branch-fork-divider-${a}-main"]`) as HTMLElement | null
        if (!container || !row) return null
        return row.getBoundingClientRect().top - container.getBoundingClientRect().top
      }, anchorId)
    // NOTE (round-1): no programmatic divider pre-position helper remains.
    // The new single-model source auth leaves scrollIntoView/scrollTop writes
    // without a live interaction token, so the keeper compensates them and the
    // divider intent never observes the intended position. Per contract the
    // divider setup therefore takes the real-wheel path as well
    // (`vcWheelPositionDivider` below) — no production exception. The measured
    // divider round-trip legs themselves still perform zero scrolling.

    // Exclusive-suffix contract (replaces the obsolete shared-prefix proof):
    // the prior revision created main with 14 post-fork owned messages but
    // ZERO branch-owned post-fork messages, and both A/B anchors were
    // positions of the SAME shared fork anchor (`start` vs `center`) — that
    // proved only shared-prefix continuity and could pass with partial
    // windows/stale overlap. This contract seeds ≥12 owned suffix messages
    // on EACH route and pins each route's stable viewport to its OWN
    // exclusive suffix ID.
    const SUFFIX_COUNT = 12
    const branchSuffixIds: string[] = []
    let suffixAfter: string = anchorId
    for (let i = 0; i < SUFFIX_COUNT; i++) {
      const suffixId = `${topicId}-msg-bexcl-${pad(i, 5)}`
      branchSuffixIds.push(suffixId)
      const seedRes: any = await page.evaluate(
        async ({
          tid,
          bid,
          after,
          mid,
          asstId,
          idx
        }: {
          tid: string
          bid: string
          after: string
          mid: string
          asstId: string
          idx: number
        }) =>
          await (window as any).api.chatDb.insertMessagesAfterAnchor({
            topicId: tid,
            branchId: bid,
            afterMessageId: after,
            entries: [
              {
                message: {
                  id: mid,
                  topicId: tid,
                  role: idx % 2 === 0 ? 'user' : 'assistant',
                  assistantId: asstId,
                  status: 'success',
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-01-01T00:00:00.000Z'
                },
                blocks: []
              }
            ]
          }),
        { tid: topicId, bid: visualBranchId, after: suffixAfter, mid: suffixId, asstId: assistantId, idx: i }
      )
      expect(seedRes?.ok, `branch suffix seed ${suffixId} failed: ${JSON.stringify(seedRes)}`).toBe(true)
      suffixAfter = suffixId
    }
    // Main post-fork exclusives are the seeded tail (14 owned rows after the
    // fork anchor); branch exclusives are the 12 rows above. Pick interior
    // exclusives so around-windows (before 10 / after 19 groups) stay partial.
    const mainExclusiveId = ids[ANCHOR_IDX + 10]
    const mainExclusiveAltId = ids[ANCHOR_IDX + 5]
    // Main post-fork exclusive set: seeded tail after the fork anchor. By
    // construction this excludes the shared prefix (ids[0..ANCHOR_IDX]) and
    // the branch-owned suffix (branchSuffixIds) — asserted explicitly below.
    // Both interior exclusives below belong to that set (topology reference
    // only; viewport establishment uses real-wheel seeks over the full set,
    // never these fixed IDs).
    const mainPostForkExclusiveIds = ids.slice(ANCHOR_IDX + 1)
    expect(mainPostForkExclusiveIds, 'exclusive set must contain the interior topology references').toEqual(
      expect.arrayContaining([mainExclusiveId, mainExclusiveAltId])
    )
    const branchExclusiveId = branchSuffixIds[SUFFIX_COUNT - 3]
    expect(mainExclusiveId).not.toBe(branchExclusiveId)
    // Topology proof BEFORE any viewport assertion: each effective route
    // contains its own exclusive anchor and excludes the foreign exclusive.
    const mainTopo: any = await page.evaluate(
      async ({ topicId, limit }: { topicId: string; limit: number }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId, limit }),
      { topicId, limit: 100 }
    )
    expect(mainTopo?.ok, `main topology probe failed: ${JSON.stringify(mainTopo)}`).toBe(true)
    const mainTopoIds = (mainTopo.value.messages as any[]).map((m: any) => m.id) as string[]
    expect(mainTopoIds, 'main effective route must contain its exclusive anchor').toContain(mainExclusiveId)
    expect(mainTopoIds, 'main effective route must exclude the branch exclusive').not.toContain(branchExclusiveId)
    const branchTopo: any = await page.evaluate(
      async ({ topicId, branchId, limit }: { topicId: string; branchId: string; limit: number }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId, branchId, limit }),
      { topicId, branchId: visualBranchId, limit: 100 }
    )
    expect(branchTopo?.ok, `branch topology probe failed: ${JSON.stringify(branchTopo)}`).toBe(true)
    const branchTopoIds = (branchTopo.value.messages as any[]).map((m: any) => m.id) as string[]
    expect(branchTopoIds, 'branch effective route must contain its exclusive anchor').toContain(branchExclusiveId)
    expect(branchTopoIds, 'branch effective route must exclude the main post-fork exclusive').not.toContain(
      mainExclusiveId
    )
    expect(branchTopoIds, 'branch effective route must share the fork anchor').toContain(anchorId)
    const mainFullLen = mainTopoIds.length
    const branchFullLen = branchTopoIds.length
    expect(mainFullLen, 'main effective route must hold ≥12 post-fork owned rows').toBeGreaterThanOrEqual(
      ANCHOR_IDX + 1 + 12
    )
    expect(branchFullLen, 'branch effective route must hold prefix + ≥12 owned rows').toBeGreaterThanOrEqual(
      ANCHOR_IDX + 1 + SUFFIX_COUNT
    )

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
    const scrollKeyFor = (branchId: string | null): string => `scroll:topic-${topicId}::${branchId ?? 'main'}`
    const readRouteSnapshotId = async (branchId: string | null): Promise<string> =>
      page.evaluate((key: string) => {
        try {
          const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
          if (!raw || typeof raw !== 'object') return ''
          const mid = typeof raw.messageId === 'string' ? raw.messageId : ''
          if (mid.length > 0) return mid
          const aid = typeof raw.anchorId === 'string' ? raw.anchorId : ''
          return aid
        } catch {
          return ''
        }
      }, scrollKeyFor(branchId))
    // Post-hoc stable-persistence proof (never a pre-switch gate, never a
    // scroll-stop control): the route-keyed snapshot must carry a non-empty
    // exclusive ID that exactly equals the live crossing-first anchor. The
    // wheel seek below stops on LIVE geometry only; this waiter only proves
    // the production saver flushed that live anchor afterwards.
    const waitSnapshotMatchesLiveExclusive = async (branchId: string | null, exclusiveIds: string[]): Promise<void> => {
      await page.waitForFunction(
        ({ key, allowed }: { key: string; allowed: string[] }) => {
          try {
            const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
            if (!raw || typeof raw !== 'object') return false
            const snapId =
              typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
                ? (raw.messageId as string)
                : typeof raw.anchorId === 'string' && (raw.anchorId as string).length > 0
                  ? (raw.anchorId as string)
                  : ''
            if (!snapId || !allowed.includes(snapId)) return false
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
            return picked.id === snapId
          } catch {
            return false
          }
        },
        { key: scrollKeyFor(branchId), allowed: exclusiveIds },
        { timeout: 30000 }
      )
    }
    // Real-wheel establishment only (single-model snapshot sources):
    // `user-scroll` snapshots require a live interaction token (genuine
    // wheel/touch/pointer/key/scrollbar input); programmatic scrollIntoView /
    // scrollTop writes never commit. All route-exclusive initial positions
    // and the ordinary-scroll supplement below therefore use real
    // `page.mouse.wheel` with the mouse over #messages, then record the
    // settled live crossing-first anchor (same `pickViewportTopAnchor` core
    // as `readStableAnchor`). Keyv is read only as a post-hoc proof that the
    // saver flushed that live anchor — never to decide when to stop wheeling
    // and never as a pre-switch qualification.
    // `scrollAnchorTo` below is intentionally NOT a user-snapshot helper: it
    // program-matically sets the divider pre-switch viewport, and the divider
    // intent path freezes that live position synchronously at click time
    // (controller-owned freeze, not a user-scroll snapshot). It must never be
    // used for route-exclusive establishment.
    const vcFocus = async (): Promise<void> => {
      const box = await page.locator('#messages').first().boundingBox()
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      }
    }
    const vcWheel = async (deltaY: number): Promise<void> => {
      await vcFocus()
      await page.mouse.wheel(0, deltaY)
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      await page.waitForTimeout(220)
    }
    const vcSettled = async (): Promise<{ id: string; intra: number; offset: number } | null> => {
      let prev: { id: string; intra: number; offset: number } | null = null
      let stable = 0
      const start = Date.now()
      let cur: { id: string; intra: number; offset: number } | null = null
      while (Date.now() - start < 10000) {
        cur = await readStableAnchor()
        if (cur && prev && cur.id === prev.id && Math.abs(cur.offset - prev.offset) <= 2) {
          stable += 1
          if (stable >= 2) return cur
        } else {
          stable = 0
        }
        prev = cur
        await page.waitForTimeout(140)
      }
      return cur
    }
    const vcWheelSearchExclusive = async (
      exclusiveIds: string[],
      maxSteps = 30
    ): Promise<{ id: string; intra: number; offset: number } | null> => {
      // Wheel-assisted deterministic seek: always wheel first via real wheel
      // input, then record the settled crossing-first anchor. Stops on LIVE
      // geometry only (settled anchor in the exclusive set); never on keyv.
      for (let i = 0; i < 4; i++) {
        await vcWheel(-560)
      }
      let settled = await vcSettled()
      if (settled && exclusiveIds.includes(settled.id)) return settled
      for (let i = 0; i < maxSteps; i++) {
        await vcWheel(560)
        settled = await vcSettled()
        if (settled && exclusiveIds.includes(settled.id)) return settled
      }
      for (let i = 0; i < maxSteps; i++) {
        await vcWheel(-560)
        settled = await vcSettled()
        if (settled && exclusiveIds.includes(settled.id)) return settled
      }
      return await vcSettled()
    }
    const vcDividerVisible = async (): Promise<boolean> =>
      page.evaluate((a: string) => {
        const row =
          (document.querySelector(`[data-testid="branch-fork-divider-${a}-main"]`) as HTMLElement | null) ??
          (document.querySelector(`[data-testid="branch-fork-divider-${a}"]`) as HTMLElement | null)
        if (!row) return false
        const container = document.querySelector('#messages') as HTMLElement | null
        if (!container) return false
        const c = container.getBoundingClientRect()
        const r = row.getBoundingClientRect()
        return r.bottom > c.top && r.top < c.bottom
      }, anchorId)
    const vcForkOffset = async (): Promise<number | null> =>
      page.evaluate((id: string) => {
        const container = document.querySelector('#messages') as HTMLElement | null
        const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
        const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
        if (!container || !el) return null
        return el.getBoundingClientRect().top - container.getBoundingClientRect().top
      }, anchorId)
    // Divider pre-position via real wheel only (round-1 contract choice, see
    // NOTE above): coarse sweep until the divider row is visible, then small
    // real-wheel fine-tune toward the center using live geometry only
    // (never keyv, never a fixed scroll-direction assumption — the sign is
    // probed once). Center is the sole nominal position; its round-trip
    // asserts ≤12px offset stability with real divider clicks and zero
    // scrolling on the measured legs.
    const vcWheelPositionDivider = async (): Promise<void> => {
      let vis = await vcDividerVisible()
      for (let i = 0; i < 24 && !vis; i++) {
        await vcWheel(-560)
        vis = await vcDividerVisible()
      }
      for (let i = 0; i < 24 && !vis; i++) {
        await vcWheel(560)
        vis = await vcDividerVisible()
      }
      expect(vis, 'divider row must be reachable via real wheel at center').toBe(true)
      const targetOf = async (): Promise<number> => {
        const h = await page.evaluate(() => document.querySelector('#messages')?.getBoundingClientRect().height ?? 0)
        return h / 2
      }
      // Probe the wheel sign once (column-reverse safe): +140 then compare.
      const off0 = await vcForkOffset()
      await vcWheel(140)
      await vcSettled()
      const off1 = await vcForkOffset()
      let sign = 1
      if (off0 !== null && off1 !== null) {
        const t = await targetOf()
        if (Math.abs(off1 - t) >= Math.abs(off0 - t)) sign = -1
      }
      let lastErr: number | null = null
      let stale = 0
      for (let i = 0; i < 18; i++) {
        const off = await vcForkOffset()
        if (off === null) break
        const target = await targetOf()
        const err = Math.abs(off - target)
        if (err <= 90) break
        if (lastErr !== null && err >= lastErr) {
          stale += 1
          if (stale >= 2) break
        } else {
          stale = 0
        }
        lastErr = err
        await vcWheel(sign * 140)
        await vcSettled()
      }
      await vcSettled()
      await waitViewportVisible()
      expect(await vcDividerVisible(), 'divider must stay visible after wheel positioning at center').toBe(true)
    }
    const residentIds = async (): Promise<string[]> =>
      page.evaluate((tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [], topicId)
    const domCount = async (messageId: string): Promise<number> =>
      page.evaluate((id: string) => document.querySelectorAll(`#messages [data-message-id="${id}"]`).length, messageId)
    // Establish distinct route-local stable viewports on EXCLUSIVE suffix IDs
    // via real wheel only (explicit pre-loop positioning; establishment
    // scrolling happens here only): wheel-seek main (B) to its own post-fork
    // exclusive crossing-first, then wheel-seek branch (A) to its own owned
    // exclusive crossing-first. No specific fixture ID and no center/start
    // requirement — the core is a route-exclusive stable position. Afterwards
    // prove each route's stable snapshot flushed that live anchor (post-hoc).
    await waitActiveBranch(visualBranchId)
    await openTopSelector()
    await page.locator('[data-testid="branch-cascader-item-main"]').first().click()
    await waitActiveBranch(null)
    await waitRouteWindowStable(1)
    await waitViewportVisible()
    let mainBefore = await vcWheelSearchExclusive(mainPostForkExclusiveIds)
    expect(mainBefore, 'main route must expose a stable viewport-top anchor via real wheel').not.toBeNull()
    expect(mainBefore?.id, 'main stable anchor id must be non-empty').not.toBe('')
    expect(mainPostForkExclusiveIds, 'main stable viewport must pin its own post-fork exclusive ID').toContain(
      mainBefore?.id
    )
    expect(ids.slice(0, ANCHOR_IDX + 1), 'main stable viewport must exclude the shared prefix').not.toContain(
      mainBefore?.id
    )
    expect(branchSuffixIds, 'main stable viewport must exclude the branch suffix').not.toContain(mainBefore?.id)
    expect(await isVisibleInMessagesViewport(page, mainBefore?.id as string), 'main anchor must be visible').toBe(true)
    await waitViewportVisible()
    mainBefore = await vcSettled()
    expect(mainBefore, 'main live anchor must stay measurable after settle').not.toBeNull()
    expect(mainPostForkExclusiveIds, 'settled main anchor must stay main-exclusive').toContain(mainBefore?.id)
    await waitSnapshotMatchesLiveExclusive(null, mainPostForkExclusiveIds)
    expect(await readRouteSnapshotId(null), 'main stable snapshot must equal the live crossing-first anchor').toBe(
      mainBefore?.id
    )
    await openTopSelector()
    await page.locator(`[data-testid="branch-cascader-item-${visualBranchId}"]`).first().click()
    await waitActiveBranch(visualBranchId)
    await waitRouteWindowStable(1)
    await waitViewportVisible()
    let branchBefore = await vcWheelSearchExclusive(branchSuffixIds)
    expect(branchBefore, 'branch route must expose a stable viewport-top anchor via real wheel').not.toBeNull()
    expect(branchBefore?.id, 'branch stable anchor id must be non-empty').not.toBe('')
    expect(branchSuffixIds, 'branch stable viewport must pin its own route-exclusive suffix ID').toContain(
      branchBefore?.id
    )
    expect(await isVisibleInMessagesViewport(page, branchBefore?.id as string), 'branch anchor must be visible').toBe(
      true
    )
    await waitViewportVisible()
    branchBefore = await vcSettled()
    expect(branchBefore, 'branch live anchor must stay measurable after settle').not.toBeNull()
    expect(branchSuffixIds, 'settled branch anchor must stay branch-exclusive').toContain(branchBefore?.id)
    await waitSnapshotMatchesLiveExclusive(visualBranchId, branchSuffixIds)
    const branchSnapId = await readRouteSnapshotId(visualBranchId)
    expect(branchSnapId, 'branch stable snapshot messageId/anchorId must be non-empty').not.toBe('')
    expect(branchSuffixIds, 'branch stable snapshot must be route-exclusive').toContain(branchSnapId)
    expect(branchSnapId, 'branch stable snapshot must equal the live crossing-first anchor').toBe(branchBefore?.id)
    expect(await readActiveBranch(), 'established route must be the branch').toBe(visualBranchId)
    expect(mainBefore?.id !== branchBefore?.id, 'established A/B viewports must be distinct exclusive IDs').toBe(true)
    const assertAnchorRepeat = (
      label: string,
      before: { id: string; intra: number; offset: number } | null,
      after: { id: string; intra: number; offset: number } | null,
      threshold: number
    ): void => {
      expect(after, `${label}: stable anchor must be measurable after return`).not.toBeNull()
      expect(after?.id, `${label}: same stable message must anchor the viewport`).toBe(before?.id)
      expect(
        Math.abs((after?.intra ?? 0) - (before?.intra ?? 0)),
        `${label}: intra-row offset must repeat within pixels`
      ).toBeLessThanOrEqual(threshold)
      expect(
        Math.abs((after?.offset ?? 0) - (before?.offset ?? 0)),
        `${label}: pixel offset must repeat within threshold`
      ).toBeLessThanOrEqual(threshold)
    }
    const switchTopRoute = async (branchId: string | null, itemTestId: string, minDom: number): Promise<void> => {
      await openTopSelector()
      await page.locator(`[data-testid="${itemTestId}"]`).first().click()
      await waitActiveBranch(branchId)
      await waitRouteWindowStable(minDom)
      await waitViewportVisible()
    }
    const assertExclusiveResident = async (
      label: string,
      targetId: string,
      foreignId: string,
      fullLen: number
    ): Promise<void> => {
      // Partial windows are valid: require the requested exclusive anchor
      // covered, never the full effective route resident. Record both.
      const resident = await residentIds()
      expect(resident, `${label}: window must contain the target exclusive ID`).toContain(targetId)
      expect(resident, `${label}: window must exclude the foreign exclusive ID`).not.toContain(foreignId)
      expect(
        resident.length <= fullLen,
        `${label}: resident (${resident.length}) never exceeds the effective route (${fullLen})`
      ).toBe(true)
      expect(await domCount(targetId), `${label}: target exclusive must be attached`).toBeGreaterThan(0)
      expect(await domCount(foreignId), `${label}: foreign exclusive must be absent from DOM`).toBe(0)
      expect(await isVisibleInMessagesViewport(page, targetId), `${label}: target must be in viewport`).toBe(true)
    }
    // Measured A→B→A from here (currently on A; main is the concrete B):
    // smallest sufficient cycle proving both routes restore exact ID + ≤12px. Two returns suffice (one
    // per route); redundant 4-return loops removed. Route-local ordinary
    // scroll persistence is covered by top-cross provenance + three-route
    // journey, so the ordinary-scroll supplement is removed here. NO
    // scrolling of any kind in this loop — restores must place the viewport.
    await switchTopRoute(null, 'branch-cascader-item-main', 1)
    assertAnchorRepeat('B return 1', mainBefore, await readStableAnchor(), 12)
    await assertExclusiveResident('B return 1', mainBefore?.id as string, branchBefore?.id as string, mainFullLen)
    await switchTopRoute(visualBranchId, `branch-cascader-item-${visualBranchId}`, 1)
    assertAnchorRepeat('A return 1', branchBefore, await readStableAnchor(), 12)
    await assertExclusiveResident('A return 1', branchBefore?.id as string, mainBefore?.id as string, branchFullLen)

    // Second-scroll overwrite (exactly one minimal contract, branch cheapest:
    // already on branch after A return 1, no extra establishment switch).
    // Bounded ≤6 genuine small wheels to a DIFFERENT branch-exclusive
    // crossing-first anchor. Stops on LIVE geometry only (settled anchor in
    // the exclusive set, visible); keyv is post-hoc proof only, never a
    // search gate and never a pre-switch qualification beyond observable
    // settle. No 30+30 sweep, no fixed multi-second wait.
    const overwriteBase = branchBefore
    expect(overwriteBase, 'overwrite base must be measurable').not.toBeNull()
    let overwriteSecond: { id: string; intra: number; offset: number } | null = null
    let overwriteWheels = 0
    const overwriteDeltas = [280, 280, 280, -280, -280, -280]
    for (let i = 0; i < overwriteDeltas.length && !overwriteSecond; i++) {
      await vcWheel(overwriteDeltas[i])
      overwriteWheels += 1
      const settled = await vcSettled()
      if (
        settled &&
        settled.id !== overwriteBase?.id &&
        branchSuffixIds.includes(settled.id) &&
        (await isVisibleInMessagesViewport(page, settled.id))
      ) {
        overwriteSecond = settled
      }
    }
    expect(
      overwriteSecond,
      `second-scroll must reach a different branch-exclusive anchor within 6 small wheels (base=${overwriteBase?.id})`
    ).not.toBeNull()
    expect(overwriteSecond?.id, 'second anchor must differ from first').not.toBe(overwriteBase?.id)
    expect(branchSuffixIds, 'second anchor must stay branch-exclusive').toContain(overwriteSecond?.id)
    expect(
      await isVisibleInMessagesViewport(page, overwriteSecond?.id as string),
      'second anchor must stay visible'
    ).toBe(true)
    // Route-local overwrite proof: observable settle only, then post-hoc
    // keyv read must equal the second live anchor (no snapshot waiter as a
    // pre-switch gate).
    await waitViewportVisible()
    const overwriteLive = await vcSettled()
    expect(overwriteLive?.id, 'overwrite live anchor must stay at second after settle').toBe(overwriteSecond?.id)
    expect(await readRouteSnapshotId(visualBranchId), 'route snapshot must now match the second live anchor').toBe(
      overwriteSecond?.id
    )
    test.info().annotations.push({
      type: 'overwrite-wheels',
      description: `second-scroll wheels=${overwriteWheels} base=${overwriteBase?.id} second=${overwriteSecond?.id}`
    })
    // Single TOP away/back with zero scrolling in between; exact second ID +
    // ≤12px must restore, first must not return.
    await switchTopRoute(null, 'branch-cascader-item-main', 1)
    await switchTopRoute(visualBranchId, `branch-cascader-item-${visualBranchId}`, 1)
    const overwriteRestored = await readStableAnchor()
    assertAnchorRepeat('overwrite return', overwriteSecond, overwriteRestored, 12)
    expect(overwriteRestored?.id, 'first anchor must not be restored after overwrite').not.toBe(overwriteBase?.id)

    // Return the branch leg to a route-exclusive anchor for the divider
    // section below via real wheel (establishment scroll, outside the
    // measured loop). Divider pre-position below likewise uses real wheel
    // (`vcWheelPositionDivider`) — the divider intent then observes a genuine
    // user-established position.
    await switchTopRoute(visualBranchId, `branch-cascader-item-${visualBranchId}`, 1)
    await waitViewportVisible()
    const dividerPrepAnchor = await vcWheelSearchExclusive(branchSuffixIds)
    expect(dividerPrepAnchor, 'divider-prep branch anchor must be measurable via real wheel').not.toBeNull()
    expect(branchSuffixIds, 'divider-prep branch anchor must stay branch-exclusive').toContain(dividerPrepAnchor?.id)
    await waitRouteWindowStable(1)
    await waitViewportVisible()
    await waitSnapshotMatchesLiveExclusive(visualBranchId, branchSuffixIds)

    // Divider round-trip at ONE representative center position with real
    // clicks: measure the SAME logical divider row offset, switch to the
    // parent route via the divider popup, compare the row offset, then switch
    // back via the divider and compare again. Never a bare finite check.
    // The duplicate start-position loop is removed; center suffices.
    // Reusable single-probe helper (install/stop one probe, no global leak).
    const VRB_KEY = '__vrb_center'
    const installVrbProbe = async (sharedIds: string[]): Promise<void> => {
      await page.evaluate(
        ({ key, shared }: { key: string; shared: string[] }) => {
          if ((window as any)[key]) throw new Error('visible-rebase probe already installed')
          const container = document.querySelector('#messages') as HTMLElement | null
          if (!container) throw new Error('#messages not found for visible-rebase probe')
          const before = new Map<string, HTMLElement>()
          for (const mid of shared) {
            const el = container.querySelector(`[data-message-id="${mid}"]`) as HTMLElement | null
            if (!el) throw new Error(`shared node ${mid} missing for visible-rebase probe`)
            before.set(mid, el)
          }
          const t0 = performance.now()
          const events: Array<{ t: number; kind: string; detail: string }> = []
          const seen = { positioning: false, hidden: false, empty: false }
          const removed = new Set<string>()
          const sample = (why: string): void => {
            const t = Math.round((performance.now() - t0) * 10) / 10
            let phase: string | null = null
            try {
              phase = container.getAttribute('data-viewport-phase')
            } catch {
              phase = null
            }
            if (phase === 'positioning' && !seen.positioning) {
              seen.positioning = true
              events.push({ t, kind: 'positioning', detail: why })
            }
            let vis: string | null = null
            try {
              vis = getComputedStyle(container).visibility
            } catch {
              vis = null
            }
            if (vis === 'hidden' && !seen.hidden) {
              seen.hidden = true
              events.push({ t, kind: 'hidden', detail: why })
            }
            let count = -1
            try {
              count = container.querySelectorAll('[data-message-id]').length
            } catch {
              count = -1
            }
            if (count === 0 && !seen.empty) {
              seen.empty = true
              events.push({ t, kind: 'empty', detail: why })
            }
            for (const [mid, el] of before) {
              let connected = false
              try {
                connected = el.isConnected
              } catch {
                connected = false
              }
              if (!connected && !removed.has(mid)) {
                removed.add(mid)
                events.push({ t, kind: 'removal', detail: `${why}:${mid}` })
              }
            }
          }
          const obs = new MutationObserver(() => sample('mutation'))
          obs.observe(container, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-viewport-phase', 'style', 'class']
          })
          let raf = 0
          let running = true
          const tick = (): void => {
            if (!running) return
            sample('raf')
            raf = requestAnimationFrame(tick)
          }
          sample('install')
          raf = requestAnimationFrame(tick)
          ;(window as any)[key] = {
            before,
            events,
            t0,
            stop: () => {
              running = false
              try {
                cancelAnimationFrame(raf)
              } catch {
                // best effort
              }
              try {
                obs.disconnect()
              } catch {
                // best effort
              }
            }
          }
        },
        { key: VRB_KEY, shared: sharedIds }
      )
    }
    const collectVrbProbe = async (
      sharedIds: string[]
    ): Promise<{
      installed: boolean
      events: Array<{ t: number; kind: string; detail: string }>
      perId: Array<{ id: string; origConnected: boolean; curAttached: boolean; sameObject: boolean }>
      finalCount: number
      phaseNow: string | null
      cleaned: boolean
    } | null> => {
      try {
        return await page.evaluate(
          ({ key, shared }: { key: string; shared: string[] }) => {
            const probe = (window as any)[key] as
              | { before?: Map<string, HTMLElement>; events?: Array<{ t: number; kind: string; detail: string }> }
              | undefined
            const container = document.querySelector('#messages') as HTMLElement | null
            const result: {
              installed: boolean
              events: Array<{ t: number; kind: string; detail: string }>
              perId: Array<{ id: string; origConnected: boolean; curAttached: boolean; sameObject: boolean }>
              finalCount: number
              phaseNow: string | null
              cleaned: boolean
            } = { installed: !!probe, events: [], perId: [], finalCount: -1, phaseNow: null, cleaned: false }
            try {
              try {
                ;((window as any)[key] as { stop?: () => void } | undefined)?.stop?.()
              } catch {
                // best effort
              }
              result.events = Array.isArray(probe?.events)
                ? ([...(probe?.events as unknown[])] as typeof result.events)
                : []
              const before = probe?.before
              result.perId = shared.map((mid: string) => {
                const cur = container?.querySelector(`[data-message-id="${mid}"]`) as HTMLElement | null
                const orig = before?.get(mid) ?? null
                return {
                  id: mid,
                  origConnected: !!orig?.isConnected,
                  curAttached: !!cur?.isConnected,
                  sameObject: !!orig && !!cur && orig === cur
                }
              })
              try {
                result.finalCount = container?.querySelectorAll('[data-message-id]').length ?? -1
              } catch {
                result.finalCount = -1
              }
              try {
                result.phaseNow = container?.getAttribute('data-viewport-phase') ?? null
              } catch {
                result.phaseNow = null
              }
            } finally {
              delete (window as any)[key]
              result.cleaned = !(window as any)[key]
            }
            return result
          },
          { key: VRB_KEY, shared: sharedIds }
        )
      } finally {
        await page.evaluate((key: string) => {
          try {
            ;((window as any)[key] as { stop?: () => void } | undefined)?.stop?.()
          } catch {
            // best effort
          }
          delete (window as any)[key]
        }, VRB_KEY)
      }
    }
    {
      await waitActiveBranch(visualBranchId)
      await vcWheelPositionDivider()
      const dividerBefore = await measureDivider()
      expect(dividerBefore, 'divider must be measurable at center').not.toBeNull()
      const takenToggle = page.locator(`[data-testid="branch-fork-selected-${anchorId}"]`).first()
      await expect(takenToggle, 'taken fork must show the selected branch name').toBeVisible({ timeout: 30000 })
      await takenToggle.click()
      await expect(page.locator(`[data-testid="branch-fork-list-${anchorId}"]`).first()).toBeVisible({
        timeout: 15000
      })
      await page.locator(`[data-testid="branch-fork-item-parent-${anchorId}"]`).first().click()
      await waitActiveBranch(null)
      await waitRouteWindowStable(1)
      expect(await isVisibleInMessagesViewport(page, anchorId)).toBe(true)
      const dividerOnParent = await measureDivider()
      expect(dividerOnParent, 'divider row must survive the switch at center').not.toBeNull()
      expect(
        Math.abs((dividerOnParent as number) - (dividerBefore as number)),
        'divider row offset must be stable across the switch at center'
      ).toBeLessThanOrEqual(12)
      // Visible-rebase minimal smoke on the RETURN leg (main -> branch):
      // fork-aligned union keeps resident shared rows mounted while main
      // suffix leaves and branch suffix mounts. One probe, one switch.
      let vrbSharedIds: string[] = []
      let vrbOutgoingIds: string[] = []
      const vrbHandles: Array<{ id: string; handle: any }> = []
      await waitViewportVisible()
      await waitRouteWindowStable(1)
      expect(await page.evaluate(() => !(window as any).__vrb_center), 'probe must not leak').toBe(true)
      const vrbDomBefore: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
          (r) => r.getAttribute('data-message-id') as string
        )
      )
      const vrbSharedUniverse = ids.slice(0, ANCHOR_IDX + 1)
      const vrbResidentShared = vrbDomBefore
        .filter((mid) => vrbSharedUniverse.includes(mid))
        .sort((a, b) => vrbSharedUniverse.indexOf(a) - vrbSharedUniverse.indexOf(b))
      expect(
        vrbResidentShared.length,
        `visible-rebase needs >=5 resident shared prefix nodes (resident=${vrbResidentShared.length} dom=${vrbDomBefore.length})`
      ).toBeGreaterThanOrEqual(5)
      vrbSharedIds = vrbResidentShared.slice(-6)
      vrbOutgoingIds = vrbDomBefore.filter((mid) => mainPostForkExclusiveIds.includes(mid))
      expect(
        vrbOutgoingIds.length,
        `visible-rebase needs >=1 resident main-exclusive outgoing node (found=${vrbOutgoingIds.length})`
      ).toBeGreaterThanOrEqual(1)
      const vrbBeforeBranchExcl = vrbDomBefore.filter((mid) => branchSuffixIds.includes(mid))
      expect(vrbBeforeBranchExcl, 'branch-exclusives must all be absent before the main->branch return').toEqual([])
      for (const sid of vrbSharedIds) {
        const h = await page.locator(`#messages [data-message-id="${sid}"]`).first().elementHandle()
        expect(h, `shared prefix ${sid} ElementHandle must attach before switch`).not.toBeNull()
        vrbHandles.push({ id: sid, handle: h })
      }
      const parentToggle = page.locator(`[data-testid="branch-fork-toggle-${anchorId}"]`).first()
      await expect(parentToggle, 'parent route shows the untaken count form').toBeVisible({ timeout: 30000 })
      await parentToggle.click()
      await expect(page.locator(`[data-testid="branch-fork-list-${anchorId}"]`).first()).toBeVisible({
        timeout: 15000
      })
      // Single-probe install via reusable helper (one switch, no leak).
      await installVrbProbe(vrbSharedIds)
      await page.locator(`[data-testid="branch-fork-item-${visualBranchId}"]`).first().click()
      await waitActiveBranch(visualBranchId)
      // True-branch visual divider return: zero synthesized scrolling. The
      // windowed return commits the around window and the restore-owned
      // search finishes it: a resident divider is aligned to the captured
      // offset and committed; an absent one drives its own pages explicitly
      // until resident/aligned/quiet. A synthetic oldest-edge scroll here
      // would cancel a healthy in-flight align as user input, record the
      // edge as the stable snapshot, and drift by exactly the paged height —
      // so the leg only waits for the divider offset itself to settle and
      // then asserts the SAME divider row absolute offset repeating within
      // pixels. No `visualHeadId`/fork-anchor visibility assertion (resident
      // membership + DOM attached only).
      await waitRouteWindowStable(1)
      await rafSettle()
      // Settle with zero scrolling: the placed path already holds the
      // divider at the captured offset; the searching path drives its own
      // pages and aligns before committing. Poll the divider offset until
      // two consecutive reads agree within 2px (20s bound) — this converges
      // for both completions without ever teleporting the viewport.
      await waitViewportVisible()
      let prevDiv: number | null = null
      let stableDivReads = 0
      const divSettleStart = Date.now()
      while (Date.now() - divSettleStart < 20000) {
        const curDiv = await measureDivider()
        if (curDiv !== null && prevDiv !== null && Math.abs(curDiv - prevDiv) <= 2) {
          stableDivReads += 1
          if (stableDivReads >= 2) break
        } else {
          stableDivReads = 0
        }
        prevDiv = curDiv
        await page.waitForTimeout(150)
      }
      // The returned route keeps the fork anchor reachable (the around
      // window is the valid restore result; full-prefix convergence is owned
      // by restore-driven paging only when the anchor starts outside it).
      const pagedResident: string[] = await page.evaluate(
        (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
        topicId
      )
      expect(pagedResident, 'fork anchor must stay resident after return at center').toContain(anchorId)
      const dividerBack = await measureDivider()
      expect(dividerBack, 'divider row must be measurable after return at center').not.toBeNull()
      expect(
        Math.abs((dividerBack as number) - (dividerBefore as number)),
        'divider row offset must repeat after the round-trip at center'
      ).toBeLessThanOrEqual(12)
      // Single stop-collect-cleanup via reusable helper BEFORE any assertion.
      // Minimal real-runtime smoke: >=5 shared same-object, outgoing gone,
      // incoming present, container never empty, no hidden/positioning.
      const vrbProbe = await collectVrbProbe(vrbSharedIds)
      expect(vrbProbe, 'visible-rebase probe must collect exactly one switch').not.toBeNull()
      expect(vrbProbe?.installed, 'probe must have observed the return switch').toBe(true)
      const vrbKinds = (vrbProbe?.events ?? []).map((e) => e.kind)
      expect(
        vrbKinds.filter((k) => k === 'positioning'),
        'no positioning during visible rebase'
      ).toEqual([])
      expect(
        vrbKinds.filter((k) => k === 'hidden'),
        'visibility never hidden during visible rebase'
      ).toEqual([])
      expect(
        vrbKinds.filter((k) => k === 'empty'),
        'container never empty during visible rebase'
      ).toEqual([])
      expect(
        vrbKinds.filter((k) => k === 'removal'),
        'no shared removal during visible rebase'
      ).toEqual([])
      expect(
        vrbProbe?.phaseNow === 'revealed' || vrbProbe?.phaseNow === 'idle',
        'viewport must settle visible after divider switch'
      ).toBe(true)
      expect(vrbProbe?.perId.length).toBeGreaterThanOrEqual(5)
      for (const row of vrbProbe?.perId ?? []) {
        expect(row.origConnected, 'shared original node must stay connected').toBe(true)
        expect(row.curAttached, 'shared current node must stay attached').toBe(true)
        expect(row.sameObject, 'shared must be the exact same DOM object').toBe(true)
      }
      for (const entry of vrbHandles) {
        const same = await entry.handle.evaluate((node: Element, mid: string) => {
          const cur = document.querySelector('#messages [data-message-id="' + mid + '"]')
          return (node as HTMLElement).isConnected && node === cur
        }, entry.id)
        expect(same, 'ElementHandle shared must resolve to the same connected DOM object').toBe(true)
      }
      for (const oid of vrbOutgoingIds) {
        expect(await domCount(oid), 'outgoing main-exclusive must disappear after visible rebase').toBe(0)
      }
      const vrbDomAfter: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
          (r) => r.getAttribute('data-message-id') as string
        )
      )
      const vrbAfterBranchExcl = vrbDomAfter.filter((mid) => branchSuffixIds.includes(mid))
      expect(
        vrbAfterBranchExcl.length,
        'target branch-exclusive suffix must appear after visible rebase'
      ).toBeGreaterThan(0)
      expect(vrbProbe?.cleaned, 'probe cleanup must be exact').toBe(true)
      // Fork anchor stays attached after the return (resident membership +
      // DOM attached; pre-paging head survival is covered by the durable
      // on-demand paging proof, not duplicated here).
      expect(pagedResident, 'fork anchor must stay resident after return at center').toContain(anchorId)
      expect(
        await page.evaluate(
          (id: string) => document.querySelectorAll(`#messages [data-message-id="${id}"]`).length,
          anchorId
        ),
        'fork anchor must stay attached after return at center'
      ).toBeGreaterThan(0)
    }
  })

  test('three-route UI creation: wheel establishes A, real UI creates B, main/A/B top round-trip once', async ({
    mainWindow
  }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'THREE-ROUTE UI CREATION: real wheel establishes A-exclusive anchor; real message UI creates B (landing with fork anchor visible); one continuous main/A/B top round-trip with distinct exclusive anchors (exact ID + <=12px, zero scrolling between switches); one no-scroll transient supersession. Duplicate A/main round-trips and divider offset are covered by visual contracts/top-cross provenance, not repeated here.'
    })
    const page = mainWindow
    await waitForAppReady(page)
    const assistantId = await prepareAssistant(page, TOTAL)
    // Single resident window user interaction journey (displayCount=100 keeps
    // full routes in one resident window; fixture prep only). Windowed
    // pagination is covered by visual contracts/divider search tests. All
    // actual switches/scrolls/creations below are real UI (wheel/top/divider/
    // message-button); API only inserts owned suffix rows.
    await page.evaluate((limit: number) => {
      ;(window as any).store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
    }, 100)
    const topicId = `journey-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `Journey ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => letterMessageId(topicId, i),
      contentPrefix: 'true-branch-'
    })
    const anchorA = ids[ANCHOR_IDX]
    const anchorB = ids[ANCHOR_IDX + 6]
    await activateTopic(page, topicId, TOTAL)

    type BbAnchor = { id: string; offset: number }
    const bbAnchor = (): Promise<BbAnchor | null> =>
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
    const bbVisible = (messageId: string): Promise<boolean> =>
      page.evaluate((id: string) => {
        const container = document.querySelector('#messages') as HTMLElement | null
        const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
        const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
        if (!container || !el) return false
        const c = container.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        return r.bottom > c.top && r.top < c.bottom
      }, messageId)
    const bbCount = (messageId: string): Promise<number> =>
      page.evaluate((id: string) => document.querySelectorAll(`#messages [data-message-id="${id}"]`).length, messageId)
    const bbFocus = async (): Promise<void> => {
      const box = await page.locator('#messages').first().boundingBox()
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      }
    }
    // Real wheel only: production InfiniteScroll ownership stays with the
    // wheel input (no direct scrollTop/scrollIntoView/keyv/snapshot writes).
    const bbWheel = async (deltaY: number): Promise<void> => {
      await bbFocus()
      await page.mouse.wheel(0, deltaY)
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      await page.waitForTimeout(220)
    }
    const bbSettled = async (): Promise<BbAnchor | null> => {
      let prev: BbAnchor | null = null
      let stable = 0
      const start = Date.now()
      let cur: BbAnchor | null = null
      while (Date.now() - start < 10000) {
        cur = await bbAnchor()
        if (cur && prev && cur.id === prev.id && Math.abs(cur.offset - prev.offset) <= 2) {
          stable += 1
          if (stable >= 2) return cur
        } else {
          stable = 0
        }
        prev = cur
        await page.waitForTimeout(140)
      }
      return cur
    }
    // Ready sync only: data-viewport-phase gates route readiness (revealed/idle)
    // plus geometry settle; never a pass assertion — acceptance stays DOM
    // geometry (anchor identity + offset, attach/absence).
    const bbWaitDomRoute = async (): Promise<void> => {
      await page.waitForFunction(
        () => document.querySelectorAll('#messages [data-message-id]').length >= 1,
        undefined,
        { timeout: 30000 }
      )
      await page.waitForFunction(
        () => {
          const el = document.getElementById('messages')
          const phase = el?.getAttribute('data-viewport-phase')
          return phase === 'revealed' || phase === 'idle'
        },
        undefined,
        { timeout: 30000 }
      )
      await bbSettled()
    }
    const bbWheelUntilVisible = async (messageId: string, maxSteps = 28): Promise<boolean> => {
      if (await bbVisible(messageId)) return true
      for (let i = 0; i < maxSteps; i++) {
        await bbWheel(-620)
        if (await bbVisible(messageId)) return true
        await page.waitForTimeout(80)
      }
      for (let i = 0; i < maxSteps; i++) {
        await bbWheel(620)
        if (await bbVisible(messageId)) return true
        await page.waitForTimeout(80)
      }
      return await bbVisible(messageId)
    }
    const bbWheelSearchExclusive = async (exclusiveIds: string[], maxSteps = 30): Promise<BbAnchor | null> => {
      // Wheel-assisted deterministic seek: always wheel first via real wheel
      // input, then record the settled crossing-first anchor. Deterministic
      // seek helper, not a claim of fully natural free exploration.
      for (let i = 0; i < 4; i++) {
        await bbWheel(-560)
      }
      let settled = await bbSettled()
      if (settled && exclusiveIds.includes(settled.id)) return settled
      for (let i = 0; i < maxSteps; i++) {
        await bbWheel(560)
        settled = await bbSettled()
        if (settled && exclusiveIds.includes(settled.id)) return settled
      }
      for (let i = 0; i < maxSteps; i++) {
        await bbWheel(-560)
        settled = await bbSettled()
        if (settled && exclusiveIds.includes(settled.id)) return settled
      }
      return await bbSettled()
    }
    const bbTopTo = async (branchId: string | null): Promise<void> => {
      await page.locator('[data-testid="branch-selector-entry"]').first().click()
      await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
      if (branchId === null) {
        await page.locator('[data-testid="branch-cascader-item-main"]').first().click()
      } else {
        await page.locator(`[data-testid="branch-cascader-item-${branchId}"]`).first().click()
      }
      await bbWaitDomRoute()
    }
    const bbClickBranchBtn = async (messageId: string): Promise<void> => {
      const e = messageId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const sel = `[id="message-${e}"][data-message-id="${e}"]`
      const container = page.locator(sel).first()
      await expect(container, `message ${messageId} must be visible for creation`).toBeVisible({ timeout: 15000 })
      try {
        await container.hover({ timeout: 8000 })
      } catch {
        // Hover flakiness; click below uses force fallback.
      }
      const btn = container.locator('[data-testid="msg-true-branch-btn"]')
      await expect(btn, `branch button for ${messageId} must attach`).toBeAttached({ timeout: 15000 })
      try {
        await btn.click({ timeout: 8000 })
      } catch {
        await btn.click({ force: true } as any)
      }
    }
    const assertSameAnchor = (label: string, before: BbAnchor | null, after: BbAnchor | null): void => {
      expect(before, `${label}: baseline anchor must exist`).not.toBeNull()
      expect(after, `${label}: return anchor must exist`).not.toBeNull()
      expect(after?.id, `${label}: same message must anchor`).toBe(before?.id)
      expect(
        Math.abs((after?.offset ?? 0) - (before?.offset ?? 0)),
        `${label}: offset must repeat within 12px`
      ).toBeLessThanOrEqual(12)
    }
    const attachFailure = async (reason: string): Promise<void> => {
      try {
        const dump = await page.evaluate(
          async ({ tid }: { tid: string }) => {
            const pick = (b: any) => ({
              id: typeof b?.id === 'string' ? b.id : '',
              anchorMessageId: typeof b?.anchorMessageId === 'string' ? b.anchorMessageId : ''
            })
            let live: unknown = null
            try {
              const s = (window as any).store.getState()
              live = {
                active: s.topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
                catalog: ((s.topicBranch?.branchesByTopic?.[tid] ?? []) as any[]).map(pick)
              }
            } catch (e) {
              live = { error: e instanceof Error ? e.message : String(e) }
            }
            let dom: unknown = null
            try {
              const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
              const c = (document.querySelector('#messages') as HTMLElement | null)?.getBoundingClientRect() ?? null
              dom = {
                count: rows.length,
                ids: rows.map((r) => r.getAttribute('data-message-id')),
                tops: rows.slice(0, 8).map((r) => {
                  const rect = r.getBoundingClientRect()
                  return { id: r.getAttribute('data-message-id'), top: c ? rect.top - c.top : rect.top }
                })
              }
            } catch (e) {
              dom = { error: e instanceof Error ? e.message : String(e) }
            }
            return { reason, live, dom }
          },
          { tid: topicId }
        )
        await test.info().attach('user-journey-failure', {
          body: JSON.stringify(dump, null, 2),
          contentType: 'application/json'
        })
      } catch {
        // Best-effort only; never masks the original failure.
      }
    }

    try {
      // Setup: real main + branch A + exclusive suffixes (fixture prep via API).
      const foundA = await bbWheelUntilVisible(anchorA)
      expect(foundA, 'fork anchor A must be reachable via wheel').toBe(true)
      await bbClickBranchBtn(anchorA)
      await expect(page.locator('[data-testid="branch-selector-entry"]').first()).toBeVisible({ timeout: 30000 })
      let branches = await listBranches(page, topicId)
      expect(branches).toHaveLength(1)
      const branchAId = branches[0].id as string
      const A_SUFFIX = 12
      const aExcl: string[] = []
      let afterA: string = anchorA
      for (let i = 0; i < A_SUFFIX; i++) {
        const mid = `${topicId}-msg-aexcl-${pad(i, 5)}`
        aExcl.push(mid)
        const res: any = await page.evaluate(
          async ({
            tid,
            bid,
            after,
            m,
            asst,
            idx
          }: {
            tid: string
            bid: string
            after: string
            m: string
            asst: string
            idx: number
          }) =>
            await (window as any).api.chatDb.insertMessagesAfterAnchor({
              topicId: tid,
              branchId: bid,
              afterMessageId: after,
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
          { tid: topicId, bid: branchAId, after: afterA, m: mid, asst: assistantId, idx: i }
        )
        expect(res?.ok, `A suffix ${mid} must insert`).toBe(true)
        afterA = mid
      }
      // Setup topology proof (prep only, never a scroll-position claim).
      const mainTopo: any = await page.evaluate(
        async ({ tid }: { tid: string }) =>
          await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId: tid, limit: 100 }),
        { tid: topicId }
      )
      expect(mainTopo?.ok).toBe(true)
      const branchTopo: any = await page.evaluate(
        async ({ tid, bid }: { tid: string; bid: string }) =>
          await (window as any).api.chatDb.fetchMessagesWindow({
            kind: 'latest',
            topicId: tid,
            branchId: bid,
            limit: 100
          }),
        { tid: topicId, bid: branchAId }
      )
      expect(branchTopo?.ok).toBe(true)
      // Load full A route through real top UI (prep, outside the measured
      // journey). Main was already user-browsed before creation (activate plus
      // wheel to anchorA), so no artificial no-snapshot premise: no extra
      // wheel parking here, only the UI reload needed to resident the suffix.
      await bbTopTo(null)
      await bbTopTo(branchAId)
      const mainExclAll = ids.slice(ANCHOR_IDX + 1)
      const mainTail = ids[ids.length - 1]
      const aTailForeignProbe = mainTail

      // 1) Continuous journey: from branch A wheel to an A-exclusive live
      // anchor; record the settled crossing-first anchor.
      let anchorA1 = await bbWheelSearchExclusive(aExcl)
      expect(anchorA1, 'A must settle on an exclusive anchor').not.toBeNull()
      expect(aExcl, 'A anchor must be A-exclusive').toContain(anchorA1?.id as string)
      expect(await bbVisible(anchorA1?.id as string), 'A anchor must be visible').toBe(true)
      expect(await bbCount(aTailForeignProbe), 'foreign main tail must be absent from A DOM').toBe(0)
      // Ready-sync stabilization only (phase + geometry settle; no keyv or
      // internal snapshot read): lets the production wheel saver flush the
      // live anchor before the top switch. No extra wheel. Re-pin the baseline
      // to the stabilized live anchor.
      await bbWaitDomRoute()
      anchorA1 = await bbSettled()
      expect(anchorA1, 'A live anchor must stay measurable after ready settle').not.toBeNull()
      expect(aExcl, 'stabilized A anchor must stay A-exclusive').toContain(anchorA1?.id as string)

      // 2) Cut to main and form a main-exclusive anchor with real wheel.
      // Duplicate A/main repeated round-trips are covered by visual contracts
      // + top-cross provenance; this journey keeps only the distinct-anchor
      // establishment needed for the three-route round-trip below.
      await bbTopTo(null)
      let anchorM1 = await bbWheelSearchExclusive(mainExclAll)
      expect(anchorM1, 'main must settle on an exclusive anchor').not.toBeNull()
      expect(mainExclAll, 'main anchor must be main-exclusive').toContain(anchorM1?.id as string)
      expect(aExcl, 'main anchor must exclude the A suffix').not.toContain(anchorM1?.id as string)
      expect(await bbVisible(anchorM1?.id as string), 'main anchor must be visible').toBe(true)
      const aForeignForMain = aExcl[aExcl.length - 1]
      expect(await bbCount(aForeignForMain), 'foreign A tail must be absent from main DOM').toBe(0)
      await bbWaitDomRoute()
      anchorM1 = await bbSettled()
      expect(anchorM1, 'main live anchor must stay measurable after ready settle').not.toBeNull()
      expect(mainExclAll, 'stabilized main anchor must stay main-exclusive').toContain(anchorM1?.id as string)

      // 3) Divider offset is covered by visual contracts (single center smoke);
      // this three-route journey skips divider UI entirely and proceeds to B
      // creation from the current main route.
      // Divider UI skipped here (covered by visual center smoke).

      // 4) Real message UI creates branch B from the main route; reasonable landing (selector + fork anchor visible).
      // Ensure the owner main route is active for the creation click.
      await bbTopTo(null)
      const reachedB = await bbWheelUntilVisible(anchorB)
      expect(reachedB, 'B fork anchor must be reachable via wheel').toBe(true)
      // Final main departure position before creation (black-box only): the
      // B-search wheel above necessarily moves main again, and production
      // saves that departure on main. Post-B top returns assert this true
      // current main stable, not the stale pre-search anchorM1.
      const anchorMBeforeBCreation = await bbSettled()
      expect(anchorMBeforeBCreation, 'main pre-creation anchor must be measurable').not.toBeNull()
      expect(ids, 'main pre-creation anchor must sit on the main valid route').toContain(
        anchorMBeforeBCreation?.id as string
      )
      expect(await bbVisible(anchorMBeforeBCreation?.id as string), 'main pre-creation anchor must be visible').toBe(
        true
      )
      await bbClickBranchBtn(anchorB)
      await expect(page.locator('[data-testid="branch-selector-entry"]').first()).toBeVisible({ timeout: 30000 })
      expect(await bbVisible(anchorB), 'new branch must land with its fork anchor visible').toBe(true)
      branches = await listBranches(page, topicId)
      expect(branches.length, 'branch B must exist alongside A').toBe(2)
      const branchB = branches.find((b: any) => b.id !== branchAId)
      const branchBId = branchB.id as string
      const B_SUFFIX = 12
      const bExcl: string[] = []
      let afterB: string = anchorB
      for (let i = 0; i < B_SUFFIX; i++) {
        const mid = `${topicId}-msg-bexcl-${pad(i, 5)}`
        bExcl.push(mid)
        const res: any = await page.evaluate(
          async ({
            tid,
            bid,
            after,
            m,
            asst,
            idx
          }: {
            tid: string
            bid: string
            after: string
            m: string
            asst: string
            idx: number
          }) =>
            await (window as any).api.chatDb.insertMessagesAfterAnchor({
              topicId: tid,
              branchId: bid,
              afterMessageId: after,
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
          { tid: topicId, bid: branchBId, after: afterB, m: mid, asst: assistantId, idx: i }
        )
        expect(res?.ok, `B suffix ${mid} must insert`).toBe(true)
        afterB = mid
      }
      // Load the full B route through real top UI (prep, outside the measured
      // multi-route loop). Suffix rows above are API-inserted owned rows only;
      // route loading and all viewport moves stay real UI.
      await bbTopTo(null)
      await bbTopTo(branchBId)
      // Top-selector UI must offer both A and B as cascader items (API only
      // discovered the IDs above via listBranches; visibility is a UI claim).
      await page.locator('[data-testid="branch-selector-entry"]').first().click()
      await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
      await expect(page.locator(`[data-testid="branch-cascader-item-${branchAId}"]`).first()).toBeVisible({
        timeout: 15000
      })
      await expect(page.locator(`[data-testid="branch-cascader-item-${branchBId}"]`).first()).toBeVisible({
        timeout: 15000
      })
      await page.locator(`[data-testid="branch-cascader-item-${branchBId}"]`).first().click()
      await bbWaitDomRoute()

      // 5) In B wheel to a B-exclusive anchor; one continuous main/A/B top
      // round-trip with distinct anchors.
      let anchorB1 = await bbWheelSearchExclusive(bExcl)
      expect(anchorB1, 'B must settle on an exclusive anchor').not.toBeNull()
      expect(bExcl, 'B anchor must be B-exclusive').toContain(anchorB1?.id as string)
      expect(aExcl, 'B anchor must exclude the A suffix').not.toContain(anchorB1?.id as string)
      expect(mainExclAll, 'B anchor must exclude the main post-fork tail').not.toContain(anchorB1?.id as string)
      await bbWaitDomRoute()
      anchorB1 = await bbSettled()
      expect(anchorB1, 'B live anchor must stay measurable after ready settle').not.toBeNull()
      expect(bExcl, 'stabilized B anchor must stay B-exclusive').toContain(anchorB1?.id as string)
      const bForeignForOthers = bExcl[bExcl.length - 1]
      // One continuous main/A/B top round-trip with distinct exclusive
      // anchors: A restores its wheel-established anchorA1; main restores its
      // pre-creation departure anchorMBeforeBCreation (source saves on
      // departure through B search, not the stale pre-search anchorM1).
      await bbTopTo(branchAId)
      assertSameAnchor('A after B', anchorA1, await bbSettled())
      expect(await bbCount(mainTail), 'A must still exclude the main tail').toBe(0)
      expect(await bbCount(bForeignForOthers), 'A must still exclude the B tail').toBe(0)
      await bbTopTo(null)
      assertSameAnchor('main after B', anchorMBeforeBCreation, await bbSettled())
      expect(await bbCount(aForeignForMain), 'main must still exclude the A tail').toBe(0)
      expect(await bbCount(bForeignForOthers), 'main must still exclude the B tail').toBe(0)
      await bbTopTo(branchBId)
      assertSameAnchor('B return', anchorB1, await bbSettled())
      expect(await bbCount(mainTail), 'B must exclude the main tail').toBe(0)
      expect(await bbCount(aForeignForMain), 'B must exclude the A tail').toBe(0)

      // 6) One no-scroll transient supersession: a no-scroll visit leaves no
      // trace. Each route keeps its current stable position (A keeps
      // anchorA1; main keeps anchorMBeforeBCreation; B keeps anchorB1).
      await bbTopTo(null)
      assertSameAnchor('main pre-transient', anchorMBeforeBCreation, await bbSettled())
      await bbTopTo(branchAId)
      // No wheel here: immediate departure proves a no-scroll visit leaves no trace.
      await bbTopTo(branchBId)
      assertSameAnchor('B after transient A', anchorB1, await bbSettled())
      await bbTopTo(null)
      assertSameAnchor('main after transient A', anchorMBeforeBCreation, await bbSettled())
      await bbTopTo(branchAId)
      assertSameAnchor('A after transient', anchorA1, await bbSettled())
    } catch (err) {
      await attachFailure(err instanceof Error ? err.message : String(err))
      throw err
    }
  })

  test('branch route owner-only: referenced owner group still operates, child references read-only, owned edit selection gates', async ({
    mainWindow
  }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'BRANCH-4/5/9 INTEGRATED: a parent-route multi-answer group referenced by a live child prefix still operates through the owner route (append/useful/select/reorder succeed, zero partial writes); a post-anchor owned group still operates (selectAnswer); a fully-owned edit selection enables cut/delete/copy with real keyboard cut publishing a cut clipboard and zero DB change. Child mutation of an ancestor reference rejects (covered by the focused describe below). No overlay semantics are introduced.'
    })
    await waitForAppReady(mainWindow)
    const page = mainWindow
    const assistantId = await prepareAssistant(page, TOTAL)
    const topicId = `perm-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sourceIds = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `Perm ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => letterMessageId(topicId, i),
      contentPrefix: 'true-branch-'
    })
    const user0 = sourceIds[0]
    const asst1 = sourceIds[1]
    const forkAnchor = sourceIds[10]
    const userLater = sourceIds[20]
    const asstLater = sourceIds[21]
    const extraId = `${topicId}-msg-extra01`

    // Build a two-answer group under user0 while it is still unreferenced.
    const joinExtra = await page.evaluate(
      ({
        tid,
        asstId,
        anchor,
        extra,
        ask
      }: {
        tid: string
        asstId: string
        anchor: string
        extra: string
        ask: string
      }) => {
        const api: any = (window as any).api.chatDb
        return api.insertMessagesAfterAnchor({
          topicId: tid,
          branchId: null,
          afterMessageId: anchor,
          entries: [
            {
              message: {
                id: extra,
                topicId: tid,
                role: 'assistant',
                assistantId: asstId,
                askId: ask,
                status: 'success',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              },
              blocks: []
            }
          ]
        })
      },
      { tid: topicId, asstId: assistantId, anchor: asst1, extra: extraId, ask: user0 }
    )
    expect(joinExtra?.ok, `pre-fork join must succeed: ${JSON.stringify(joinExtra)}`).toBe(true)

    // Fork L1 through msg-00010: the user0 answer group stays owned by the
    // parent route and referenced (read-only) from the child; the msg-00020
    // pair stays a post-anchor owned group.
    const forked = await page.evaluate(
      ({ tid, anchor }: { tid: string; anchor: string }) => {
        const api: any = (window as any).api.chatDb
        return api.createBranch({ topicId: tid, parentBranchId: null, anchorMessageId: anchor, name: 'E2E Perm L1' })
      },
      { tid: topicId, anchor: forkAnchor }
    )
    expect(forked?.ok, `fork must succeed: ${JSON.stringify(forked)}`).toBe(true)

    // Load the parent route window (default route) with its capability.
    await activateTopic(page, topicId, TOTAL + 1)

    // Referenced owner multi-answer group: append-join / useful / select /
    // reorder all still succeed through the owner route (BRANCH-4 butterfly
    // effect, no partial writes).
    const selectOwned = await page.evaluate(
      ({ tid, id }: { tid: string; id: string }) => {
        const api: any = (window as any).api.chatDb
        return api.selectAnswerMessage({ topicId: tid, branchId: null, selectedMessageId: id })
      },
      { tid: topicId, id: extraId }
    )
    expect(selectOwned?.ok, `referenced owner group select must succeed: ${JSON.stringify(selectOwned)}`).toBe(true)
    const usefulOwned = await page.evaluate(
      ({ tid, id }: { tid: string; id: string }) => {
        const api: any = (window as any).api.chatDb
        return api.selectUsefulAnswer({ topicId: tid, branchId: null, messageId: id })
      },
      { tid: topicId, id: asst1 }
    )
    expect(usefulOwned?.ok, `referenced owner group useful must succeed: ${JSON.stringify(usefulOwned)}`).toBe(true)
    const reorderOwned = await page.evaluate(
      ({ tid, anchor, order }: { tid: string; anchor: string; order: string[] }) => {
        const api: any = (window as any).api.chatDb
        return api.reorderAnswerGroup({
          topicId: tid,
          branchId: null,
          anchorMessageId: anchor,
          orderedMessageIds: order
        })
      },
      { tid: topicId, anchor: asst1, order: [extraId, asst1] }
    )
    expect(reorderOwned?.ok, `referenced owner group reorder must succeed: ${JSON.stringify(reorderOwned)}`).toBe(true)
    const joinOwned = await page.evaluate(
      ({
        tid,
        asstId,
        anchor,
        extra,
        ask
      }: {
        tid: string
        asstId: string
        anchor: string
        extra: string
        ask: string
      }) => {
        const api: any = (window as any).api.chatDb
        return api.insertMessagesAfterAnchor({
          topicId: tid,
          branchId: null,
          afterMessageId: anchor,
          entries: [
            {
              message: {
                id: extra,
                topicId: tid,
                role: 'assistant',
                assistantId: asstId,
                askId: ask,
                status: 'success',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              },
              blocks: []
            }
          ]
        })
      },
      { tid: topicId, asstId: assistantId, anchor: asst1, extra: `${topicId}-msg-extra02`, ask: user0 }
    )
    expect(joinOwned?.ok, `referenced owner group append-join must succeed: ${JSON.stringify(joinOwned)}`).toBe(true)

    // Post-anchor owned group still operates (one stable select).
    const selectPrivate = await page.evaluate(
      ({ tid, id }: { tid: string; id: string }) => {
        const api: any = (window as any).api.chatDb
        return api.selectAnswerMessage({ topicId: tid, branchId: null, selectedMessageId: id })
      },
      { tid: topicId, id: asstLater }
    )
    expect(selectPrivate?.ok, `owned group select must succeed: ${JSON.stringify(selectPrivate)}`).toBe(true)
    expect((selectPrivate as any).value?.messageIds).toEqual([asstLater])

    // Owner-write proof against live SQLite (bounded retry on pressure): the
    // pre-fork join plus the post-fork owner append-join both landed.
    const chatDbPath = getChatDbPath()
    expect(chatDbPath).not.toBeNull()
    const countAfter = await queryChatDbViaElectronWithRetry(
      chatDbPath!,
      `SELECT COUNT(*) AS n FROM messages WHERE topic_id = '${esc(topicId)}'`
    )
    expect(countAfter?.ok).toBe(true)
    expect((((countAfter as any).rows ?? []) as any[])[0]?.n).toBe(TOTAL + 2)
    const joinPresent = await queryChatDbViaElectronWithRetry(
      chatDbPath!,
      `SELECT id FROM messages WHERE id = '${esc(`${topicId}-msg-extra02`)}'`
    )
    expect(joinPresent?.ok).toBe(true)
    expect(((joinPresent as any).rows ?? []) as any[]).toHaveLength(1)

    // Fully-owned edit selection: cut/delete/copy all enabled. True-branch
    // entry: the real edit-mode toggle enables edit mode first; selection is
    // set in a separate step only after the heavy edit bridge is attached.
    const editToggle = page.locator('[data-testid="edit-mode-toggle"]').first()
    await expect(editToggle, 'edit-mode toggle must be visible').toBeVisible({ timeout: 15000 })
    await editToggle.click()
    await page.waitForFunction(() => (window as any).store.getState().editMode?.enabled === true, null, {
      timeout: 15000
    })
    await expect(page.locator('[data-testid="edit-heavy-active"]').first()).toBeAttached({ timeout: 15000 })
    await page.evaluate(
      ({ groups }: { groups: string[] }) => {
        ;(window as any).store.dispatch({ type: 'editMode/setSelectedGroupIds', payload: groups })
      },
      { groups: [user0, userLater] }
    )
    await page.waitForFunction(
      ({ a, b }: { a: string; b: string }) => {
        const ids = (window as any).store.getState().editMode?.selectedGroupIds ?? []
        return Array.isArray(ids) && ids.length === 2 && ids[0] === a && ids[1] === b
      },
      { a: user0, b: userLater },
      { timeout: 15000 }
    )
    const cutBtn = page.locator('[data-testid="edit-cut-btn"]').first()
    const delBtn = page.locator('[data-testid="edit-delete-btn"]').first()
    const copyBtn = page.locator('[data-testid="edit-copy-btn"]').first()
    await expect(copyBtn, 'edit ActionBar must be attached after selection').toBeAttached({ timeout: 15000 })
    await expect(cutBtn, 'edit ActionBar must be attached after selection').toBeAttached({ timeout: 15000 })
    await expect(delBtn, 'edit ActionBar must be attached after selection').toBeAttached({ timeout: 15000 })
    await expect(cutBtn, 'owned-selection cut must be enabled').toBeEnabled({ timeout: 15000 })
    await expect(delBtn, 'owned-selection delete must be enabled').toBeEnabled({ timeout: 15000 })
    await expect(copyBtn, 'copy stays enabled on owned selections').toBeEnabled({ timeout: 15000 })
    await copyBtn.click()
    await page.waitForFunction(
      () => {
        const s = (window as any).store.getState()
        return s.clipboard?.mode === 'copy' && (s.clipboard?.items ?? []).length > 0
      },
      null,
      { timeout: 30000 }
    )
    const clipboardAfterCopy = await page.evaluate(() => {
      const s = (window as any).store.getState()
      return { mode: s.clipboard?.mode, groups: (s.clipboard?.items ?? []).length }
    })
    expect(clipboardAfterCopy.groups).toBeGreaterThan(0)
    // Real keyboard cut path: Meta+X on a fully-owned selection publishes a
    // cut clipboard (mode flips, same groups). Cut stages the clipboard only —
    // the DB below must stay unchanged.
    await page.keyboard.press('Meta+x')
    await page.waitForFunction(
      () => {
        const s = (window as any).store.getState()
        return s.clipboard?.mode === 'cut' && (s.clipboard?.items ?? []).length > 0
      },
      null,
      { timeout: 30000 }
    )
    const clipboardAfterCut = await page.evaluate(() => {
      const s = (window as any).store.getState()
      return { mode: s.clipboard?.mode, groups: (s.clipboard?.items ?? []).length }
    })
    expect(clipboardAfterCut.mode).toBe('cut')
    expect(clipboardAfterCut.groups).toEqual(clipboardAfterCopy.groups)
    const countFinal = await queryChatDbViaElectronWithRetry(
      chatDbPath!,
      `SELECT COUNT(*) AS n FROM messages WHERE topic_id = '${esc(topicId)}'`
    )
    expect(countFinal?.ok).toBe(true)
    expect((((countFinal as any).rows ?? []) as any[])[0]?.n).toBe(TOTAL + 2)
    await editToggle.click()
    await page.waitForFunction(() => (window as any).store.getState().editMode?.enabled === false, null, {
      timeout: 15000
    })
    await expect(page.locator('[data-testid="edit-heavy-inactive"]').first()).toBeAttached({ timeout: 15000 })
  })
})

test.describe('True-branch owner-only focused (BRANCH-4/5/9)', () => {
  test.skip(process.platform !== 'darwin', 'requires macOS disposable-profile Electron lane')

  test('owner edit visible in child + real-UI insert at fork anchor lands at suffix start (focused small-topology)', async ({
    mainWindow,
    electronApp,
    mockPort,
    ownedTmpRoot
  }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'TRUE-BRANCH FOCUSED SMALL-TOPOLOGY: one seedSmallTopic + one createBranch + one activation. (A) owner main edit of the fork anchor is visible in the child effective route under the same stable ID with no prefix copy; child update of the same ancestor ID fails closed; main capability contains the anchor while the child capability excludes it. (B) the production MessageMenubar insert on the branch anchor via the real msg-insert-btn lands the exact new pair at suffix start before the pre-existing suffix with immediate edit/delete controls; true-branch hides on inherited rows; stale-anchor insert rejects; post-exit SQLite proves durable owned-suffix order/count. Owner edit runs first (content-only) so insert order expectations stay valid.'
    })
    void mockPort
    void ownedTmpRoot
    await waitForAppReady(mainWindow)
    const page = mainWindow
    const assistantId = await prepareAssistant(page, TOTAL)
    const topicId = `tb-focused-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await seedSmallTopic(page, assistantId, topicId, `FocusedSmall ${topicId}`)
    const seedIds = [`${topicId}-msg-00000`, `${topicId}-msg-00001`, `${topicId}-msg-00002`, `${topicId}-msg-00003`]
    const branchAnchor = seedIds[1]
    // Single fork L1 through the anchor via the real Main IPC (same contract the toolbar uses).
    const created: any = await page.evaluate(
      async ({ tid, anchor }: { tid: string; anchor: string }) =>
        await (window as any).api.chatDb.createBranch({ topicId: tid, parentBranchId: null, anchorMessageId: anchor }),
      { tid: topicId, anchor: branchAnchor }
    )
    expect(created?.ok, `createBranch failed: ${JSON.stringify(created)}`).toBe(true)
    const branchId = created.value.branch.id as string
    // Claim A first (content-only owner edit): runs before the suffix seed and
    // the single activation so the later insert order expectations stay valid.
    // Owner main edit of the referenced anchor succeeds (butterfly effect, BRANCH-4/5).
    const editedContent = `owner-edit-${Date.now()}`
    const updateOk: any = await page.evaluate(
      async ({ tid, mid, content }: { tid: string; mid: string; content: string }) =>
        await (window as any).api.chatDb.updateMessage({ topicId: tid, messageId: mid, updates: { content } }),
      { tid: topicId, mid: branchAnchor, content: editedContent }
    )
    // NOTE: updateMessage IPC shape follows the existing preload contract; a
    // contract mismatch surfaces here as a failed expectation, never as a pass.
    expect(updateOk?.ok, `owner update failed: ${JSON.stringify(updateOk)}`).toBe(true)
    // Child effective route sees the unique entity update under the same stable ID (no copy).
    const childRoute: any = await page.evaluate(
      async ({ tid, bid }: { tid: string; bid: string }) =>
        await (window as any).api.chatDb.fetchMessages({ topicId: tid, branchId: bid }),
      { tid: topicId, bid: branchId }
    )
    expect(childRoute?.ok, `child fetch failed: ${JSON.stringify(childRoute)}`).toBe(true)
    const childHit = (childRoute.value.messages as any[]).find((m: any) => m.id === branchAnchor)
    expect(childHit?.content).toBe(editedContent)
    // Child mutation of the same ancestor ID fails closed (read-only reference, BRANCH-3/4).
    const childWrite: any = await page.evaluate(
      async ({ tid, mid, bid }: { tid: string; mid: string; bid: string }) =>
        await (window as any).api.chatDb.updateMessage({
          topicId: tid,
          messageId: mid,
          updates: { content: 'child-fork-attempt' },
          branchId: bid
        }),
      { tid: topicId, mid: branchAnchor, bid: branchId }
    )
    expect(childWrite?.ok, 'child write of an ancestor reference must fail closed').toBe(false)
    // Owner capability evidence (Main-authoritative): the main route carries
    // the owned anchor. The child-side exclusion is proven once below by the
    // branch window after the real-UI insert (shared assertion, no duplicate
    // pre-insert child probe).
    const mainCap: any = await page.evaluate(
      async ({ tid }: { tid: string }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId: tid, limit: 10 }),
      { tid: topicId }
    )
    expect(mainCap?.ok).toBe(true)
    expect(mainCap.value.mutableMessageIds as string[]).toContain(branchAnchor)
    // Setup-only IPC seed: one pre-existing owned suffix row through the branch route.
    const suffixId = `${topicId}-msg-suffix01`
    const suffixOk: any = await page.evaluate(
      async ({ tid, bid, mid, asstId }: { tid: string; bid: string; mid: string; asstId: string }) =>
        await (window as any).api.chatDb.insertMessagesAfterAnchor({
          topicId: tid,
          branchId: bid,
          afterMessageId: `${tid}-msg-00001`,
          entries: [
            {
              message: {
                id: mid,
                topicId: tid,
                role: 'user',
                assistantId: asstId,
                status: 'success',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              },
              blocks: []
            }
          ]
        }),
      { tid: topicId, bid: branchId, mid: suffixId, asstId: assistantId }
    )
    expect(suffixOk?.ok, `suffix seed failed: ${JSON.stringify(suffixOk)}`).toBe(true)
    // Load the branch route through production UI: activate the topic (main
    // route), then switch to the L1 route via the real top-selector cascader.
    await activateTopic(page, topicId, 4)
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    await page.locator(`[data-testid="branch-cascader-item-${branchId}"]`).first().click()
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const s = (window as any).store.getState()
        const ids = s.messages?.messageIdsByTopic?.[tid]
        return Array.isArray(ids) && ids.length === len && s.messages?.loadingByTopic?.[tid] !== true
      },
      { tid: topicId, len: 3 },
      { timeout: 30000 }
    )
    const preBranchIds: string[] = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
      topicId
    )
    expect(preBranchIds).toEqual([seedIds[0], seedIds[1], suffixId])
    await page.waitForFunction((n: number) => document.querySelectorAll('#messages [data-message-id]').length >= n, 3, {
      timeout: 30000
    })
    // Act: real production insert click on the last ancestor-prefix message
    // (the branch anchor, an assistant row whose msg-insert-btn stays visible
    // on inherited references by design). No direct insert IPC on this path.
    const anchorSel = `[id="message-${branchAnchor}"][data-message-id="${branchAnchor}"]`
    const anchorContainer = page.locator(anchorSel).first()
    await expect(anchorContainer, 'branch-anchor container must be visible on the branch route').toBeVisible({
      timeout: 15000
    })
    await page.evaluate((id: string) => {
      const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
      if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
    }, branchAnchor)
    try {
      await anchorContainer.hover({ timeout: 8000 })
    } catch {
      // Hover flakiness near edges; the click below uses a force fallback.
    }
    const insertBtn = anchorContainer.locator('[data-testid="msg-insert-btn"]')
    await expect(insertBtn, 'production insert control must be attached on the last prefix message').toBeAttached({
      timeout: 10000
    })
    try {
      await insertBtn.click({ timeout: 8000 })
    } catch {
      await insertBtn.click({ force: true } as any)
    }
    // The thunk publishes authoritatively into the same resident: no route
    // switch and no full reload are performed after the click.
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const s = (window as any).store.getState()
        const ids = s.messages?.messageIdsByTopic?.[tid]
        return Array.isArray(ids) && ids.length === len && s.messages?.loadingByTopic?.[tid] !== true
      },
      { tid: topicId, len: 5 },
      { timeout: 30000 }
    )
    await page.waitForFunction((n: number) => document.querySelectorAll('#messages [data-message-id]').length >= n, 5, {
      timeout: 30000
    })
    const postIds: string[] = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
      topicId
    )
    // Discover the thunk-generated pair by diffing the same resident.
    const freshIds = postIds.filter((id) => !preBranchIds.includes(id))
    expect(freshIds, 'production insert must publish exactly two new rows into the same resident').toHaveLength(2)
    // Suffix-start placement in the live resident: prefix through the branch
    // anchor, then the new pair, then the previous suffix.
    expect(postIds).toEqual([seedIds[0], seedIds[1], freshIds[0], freshIds[1], suffixId])
    const freshRoles: Record<string, { role: string; askId: string | null }> = await page.evaluate(
      ({ ids }: { ids: string[] }) => {
        const entities = (window as any).store.getState().messages?.entities ?? {}
        const out: Record<string, { role: string; askId: string | null }> = {}
        for (const id of ids) {
          out[id] = { role: entities[id]?.role ?? '', askId: (entities[id]?.askId ?? null) as string | null }
        }
        return out
      },
      { ids: freshIds }
    )
    expect(freshRoles[freshIds[0]]?.role).toBe('user')
    expect(freshRoles[freshIds[1]]?.role).toBe('assistant')
    expect(freshRoles[freshIds[1]]?.askId).toBe(freshIds[0])
    // Primary rendered-UI proof (Redux above only supplements): visual
    // top-to-bottom order matches the resident, and each new row is really
    // rendered. #messages renders flex column-reverse so raw DOM query order
    // is newest-to-oldest; sort by geometry top for the user-visible order.
    const domOrder: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#messages [data-message-id]'))
        .map((el) => ({
          id: (el as HTMLElement).getAttribute('data-message-id') as string,
          top: (el as HTMLElement).getBoundingClientRect().top
        }))
        .sort((a, b) => a.top - b.top)
        .map((x) => x.id)
    )
    expect(domOrder).toEqual(postIds)
    for (const freshId of freshIds) {
      const sel = `[id="message-${freshId}"][data-message-id="${freshId}"]`
      const container = page.locator(sel).first()
      await expect(container, `inserted message ${freshId} must be rendered`).toBeVisible({ timeout: 15000 })
      await page.evaluate((id: string) => {
        const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
        const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
        if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
      }, freshId)
      try {
        await container.hover({ timeout: 8000 })
      } catch {
        // Hover flakiness near edges; assertions below retry via Playwright.
      }
      await expect(
        container.locator('[data-testid="msg-edit-btn"], [data-testid="msg-assistant-edit-btn"]'),
        `inserted message ${freshId} must immediately expose its edit control`
      ).toHaveCount(1, { timeout: 15000 })
      await expect(
        container.locator('[data-testid="message-delete-button"]'),
        `inserted message ${freshId} must immediately expose its delete control`
      ).toHaveCount(1, { timeout: 15000 })
    }
    // Shared Main-authoritative capability (same contract the divider switch
    // reads; single assertion supporting both claims): the branch window
    // carries the effective order with only the owned suffix mutable — the
    // inherited fork anchor stays excluded on the child route while the owner
    // main capability above contains it. The owner edit also survives the insert.
    const branchWin: any = await page.evaluate(
      async ({ tid, bid }: { tid: string; bid: string }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({
          kind: 'latest',
          topicId: tid,
          branchId: bid,
          limit: 20
        }),
      { tid: topicId, bid: branchId }
    )
    expect(branchWin?.ok).toBe(true)
    expect((branchWin.value.messages as any[]).map((m: any) => m.id)).toEqual(postIds)
    expect(new Set(branchWin.value.mutableMessageIds as string[])).toEqual(new Set([suffixId, ...freshIds]))
    expect(
      (branchWin.value.mutableMessageIds as string[]).includes(branchAnchor),
      'inherited fork anchor must stay excluded from the child capability'
    ).toBe(false)
    expect(
      (branchWin.value.messages as any[]).find((m: any) => m.id === branchAnchor)?.content,
      'owner edit must survive the suffix-start insert under the same stable ID'
    ).toBe(editedContent)
    // Bounded UI contract on the branch route: true-branch hides on every
    // inherited ref (including the fork anchor); insert shows only at the
    // exact fork anchor among inherited refs.
    const olderSel = `[id="message-${seedIds[0]}"][data-message-id="${seedIds[0]}"]`
    const olderContainer = page.locator(olderSel).first()
    await expect(olderContainer, 'older inherited container must be visible').toBeVisible({ timeout: 15000 })
    try {
      await olderContainer.hover({ timeout: 8000 })
    } catch {}
    await expect(
      olderContainer.locator('[data-testid="msg-true-branch-btn"]'),
      'true-branch must hide on older inherited refs'
    ).toHaveCount(0, { timeout: 10000 })
    await expect(
      olderContainer.locator('[data-testid="msg-insert-btn"]'),
      'insert must hide on older inherited refs'
    ).toHaveCount(0, { timeout: 10000 })
    await page.evaluate((id: string) => {
      const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
      if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
    }, branchAnchor)
    const forkContainer = page.locator(anchorSel).first()
    await expect(forkContainer, 'fork-anchor container must be visible').toBeVisible({ timeout: 15000 })
    try {
      await forkContainer.hover({ timeout: 8000 })
    } catch {}
    await expect(
      forkContainer.locator('[data-testid="msg-true-branch-btn"]'),
      'true-branch must hide even at the fork anchor (inherited)'
    ).toHaveCount(0, { timeout: 10000 })
    await expect(
      forkContainer.locator('[data-testid="msg-insert-btn"]'),
      'insert must stay visible at the exact fork anchor'
    ).toHaveCount(1, { timeout: 10000 })
    // Bounded Main contract: an older inherited anchor rejects atomically
    // with zero writes; the effective order and capability are unchanged.
    const staleInsert: any = await page.evaluate(
      async ({ tid, bid, anchor }: { tid: string; bid: string; anchor: string }) =>
        await (window as any).api.chatDb.insertMessagesAfterAnchor({
          topicId: tid,
          branchId: bid,
          afterMessageId: anchor,
          entries: [
            {
              message: {
                id: `${tid}-msg-stale-reject`,
                topicId: tid,
                role: 'user',
                status: 'success',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              },
              blocks: []
            }
          ]
        }),
      { tid: topicId, bid: branchId, anchor: seedIds[0] }
    )
    expect(staleInsert?.ok, 'older inherited insert must reject').toBe(false)
    const branchWinAfter: any = await page.evaluate(
      async ({ tid, bid }: { tid: string; bid: string }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({
          kind: 'latest',
          topicId: tid,
          branchId: bid,
          limit: 20
        }),
      { tid: topicId, bid: branchId }
    )
    expect(branchWinAfter?.ok).toBe(true)
    expect((branchWinAfter.value.messages as any[]).map((m: any) => m.id)).toEqual(postIds)
    // Durable post-exit SQLite proof via the established helper (ownership
    // scope: this disposable topic only; the profile may own other topics).
    // This also closes claim A stable identity: no prefix copy — every seed
    // row stays branch_id NULL with the exact 4+1+2 set and owned order.
    await electronApp.close()
    const chatDbPath = getChatDbPath()
    expect(chatDbPath).not.toBeNull()
    const durable = queryChatDbViaElectron(
      chatDbPath!,
      `SELECT id, branch_id FROM messages WHERE topic_id = '${esc(topicId)}' ORDER BY sort_order ASC, id ASC`
    )
    expect(durable?.ok).toBe(true)
    const durableRows = ((durable as any).rows ?? []) as any[]
    expect(durableRows.map((r: any) => r.id).sort()).toEqual([...seedIds, suffixId, ...freshIds].sort())
    const ownedInOrder = durableRows.filter((r: any) => r.branch_id === branchId).map((r: any) => r.id)
    expect(ownedInOrder).toEqual([...freshIds, suffixId])
    for (const prefixId of seedIds) {
      expect(durableRows.find((r: any) => r.id === prefixId)?.branch_id).toBeNull()
    }
    // Fixture teardown owns any remaining Electron cleanup after the close above.
  })
})
