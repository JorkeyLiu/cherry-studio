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
 * 3. Real top-selector rename (branch-rename-btn-*) renames DB-first; the
 *    divider + breadcrumb show the new name; the topic name is untouched.
 * 4. Bounded nested fork (parent = L1): an IPC createBranch on an
 *    INHERITED message rejects (parent-owned anchors only, including the
 *    parent fork anchor itself); an IPC createBranch on the L1-owned suffix
 *    succeeds and includes the parent-owned prefix. The inherited toolbar
 *    true-branch button stays hidden (no UI fork from inherited).
 * 5. Windowed parent restore: fork-divider switch (branch-fork-selected-*)
 *    to the parent/original route reloads main around the shared fork
 *    anchor (older 10 / newer 19 groups → deterministic 25-resident
 *    window, authoritative hasMoreBefore=true); the shared anchor stays in
 *    the SAME vicinity — never bottom — then a real oldest-edge scroll
 *    pages the remaining head on demand until the resident converges to
 *    full length.
 * 6. Top-selector cascader switch back to L2 — breadcrumb updates, no jump.
 * 7. Same-profile relaunch: catalog, names, active route, and dividers
 *    persist (in-app reload proof).
 * 8. Real top-selector Delete removes the L1 subtree (L1+L2); the topic is
 *    indistinguishable from never-branched (no selector, no dividers).
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

const TOTAL = 30
const ANCHOR_IDX = 15
const INHERITED_ANCHOR_IDX = 5

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}
const esc = (v: string): string => v.replace(/'/g, "''")

async function prepareAssistant(page: any): Promise<string> {
  await page.evaluate((limit: number) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
  }, TOTAL)
  const liveAssistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

async function seedSourceTopic(page: any, assistantId: string, topicId: string, name: string): Promise<string[]> {
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
  expect(addOk.ok).toBe(true)
  const entries: any[] = []
  const ids: string[] = []
  for (let i = 0; i < TOTAL; i++) {
    const msgId = `${topicId}-msg-${pad(i, 5)}`
    const blockId = `${topicId}-block-${pad(i, 5)}`
    ids.push(msgId)
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const msg: any = {
      id: msgId,
      topicId,
      role,
      assistantId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'success',
      blocks: [blockId],
      sortOrder: i
    }
    if (role === 'assistant') {
      msg.model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
      msg.modelId = 'mock-model'
      msg.askId = `${topicId}-msg-${pad(i - 1, 5)}`
    }
    entries.push({
      message: msg,
      blocks: [
        {
          id: blockId,
          messageId: msgId,
          type: 'main_text',
          content: `true-branch-${pad(i, 5)}`,
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    })
  }
  const persist = await page.evaluate(
    async ({
      topicId,
      assistantId,
      name,
      entries
    }: {
      topicId: string
      assistantId: string
      name: string
      entries: any
    }) => {
      try {
        const api: any = (window as any).api.chatDb
        const ensured = await api.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
        const pasted = await api.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId, name, entries }
  )
  expect(persist.ok, `seed failed: ${(persist as any).err}`).toBe(true)
  return ids
}

async function seedSmallTopic(page: any, assistantId: string, topicId: string, name: string): Promise<string[]> {
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
  expect(addOk.ok).toBe(true)
  const ids = [`${topicId}-msg-00000`, `${topicId}-msg-00001`, `${topicId}-msg-00002`, `${topicId}-msg-00003`]
  const entries = ids.map((msgId, i) => {
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const msg: any = {
      id: msgId,
      topicId,
      role,
      assistantId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'success',
      blocks: [`${topicId}-block-0000${i}`],
      sortOrder: i
    }
    if (role === 'assistant') {
      msg.model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
      msg.modelId = 'mock-model'
      msg.askId = ids[i - 1]
    }
    return {
      message: msg,
      blocks: [
        {
          id: `${topicId}-block-0000${i}`,
          messageId: msgId,
          type: 'main_text',
          content: `other-topic-${i}`,
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    }
  })
  const persist = await page.evaluate(
    async ({
      topicId,
      assistantId,
      name,
      entries
    }: {
      topicId: string
      assistantId: string
      name: string
      entries: any
    }) => {
      try {
        const api: any = (window as any).api.chatDb
        const ensured = await api.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
        const pasted = await api.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId, name, entries }
  )
  expect(persist.ok, `small seed failed: ${(persist as any).err}`).toBe(true)
  return ids
}

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

async function activateTopic(page: any, topicId: string, atLeast: number): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()
  await page.waitForFunction(
    ({ topicId, atLeast }: { topicId: string; atLeast: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      const loading = s.messages?.loadingByTopic?.[topicId]
      return Array.isArray(ids) && ids.length >= atLeast && loading !== true
    },
    { topicId, atLeast },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (atLeast: number) => document.querySelectorAll('#messages [data-message-id]').length >= atLeast,
    atLeast,
    { timeout: 30000 }
  )
}

async function clickToolbarBranch(page: any, messageId: string): Promise<void> {
  const e = messageId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const sel = `[id="message-${e}"][data-message-id="${e}"]`
  let container = page.locator(sel).first()
  await expect(container, `message container ${messageId} must be visible`).toBeVisible({ timeout: 15000 })
  await page.evaluate((id: string) => {
    const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
  }, messageId)
  container = page.locator(sel).first()
  await expect(container, `message container ${messageId} must be visible after scroll`).toBeVisible({ timeout: 15000 })
  try {
    await container.hover({ timeout: 8000 })
  } catch {
    // Hover flakiness near edges; the button click below uses force fallback.
  }
  const btn = container.locator('[data-testid="msg-true-branch-btn"]')
  await expect(btn, `true-branch toolbar button for ${messageId} must be attached`).toBeAttached({ timeout: 10000 })
  try {
    await btn.click({ timeout: 8000 })
  } catch {
    await btn.click({ force: true } as any)
  }
}

async function listBranches(page: any, topicId: string): Promise<any[]> {
  const res: any = await page.evaluate(
    async (tid: string) => (window as any).api.chatDb.listBranches({ topicId: tid }),
    topicId
  )
  expect(res?.ok, `listBranches failed: ${JSON.stringify(res)}`).toBe(true)
  return res.value.branches as any[]
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
        'TRUE-BRANCH INTEGRATED UI: one sidebar topic throughout; toolbar forks local-only route nodes (no prefix clone, no topics); breadcrumb/cascader + fork-divider switching without bottom jump; same-profile relaunch persistence; subtree delete restores pre-branch UI; post-exit SQLite proves branch/row/topic integrity.'
    })
    const userDataDir = getUserDataDir()
    await waitForAppReady(mainWindow)
    const page = mainWindow
    const assistantId = await prepareAssistant(page)
    const sourceTopicId = `intbranch-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const topicName = `IntBranch ${sourceTopicId}`
    const sourceIds = await seedSourceTopic(page, assistantId, sourceTopicId, topicName)
    const anchorId = sourceIds[ANCHOR_IDX]
    const inheritedAnchorId = sourceIds[INHERITED_ANCHOR_IDX]
    await activateTopic(page, sourceTopicId, TOTAL)
    // Baseline sidebar identity (the disposable profile may carry its own
    // default topics): no step may ever add or remove a logical topic.
    const topicsBefore = await sidebarTopicIds(page)
    expect(topicsBefore).toContain(sourceTopicId)

    // 2. Fork L1 at the mid assistant anchor via the real toolbar button.
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
    let branches = await listBranches(page, sourceTopicId)
    expect(branches).toHaveLength(1)
    expect(branches[0].topicId).toBe(sourceTopicId)
    expect(branches[0].parentBranchId).toBeNull()
    expect(branches[0].anchorMessageId).toBe(anchorId)
    const branch1Id = branches[0].id as string
    // Sidebar identity unchanged: no child-topic rows were created.
    expect(await sidebarTopicIds(page)).toEqual(topicsBefore)
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
    expect(await sidebarTopicIds(page)).toEqual(topicsBefore)
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

    // 5. Fork-divider switch on the L1 route: its anchor fork is taken
    // (selected branch name shown); switching to the parent/original route
    // lands on the SAME shared anchor, never a bottom jump. (The fresh L2
    // route spans main[0..anchor] plus the L1-owned suffix, so its anchor
    // fork is not in view — return to L1 via the top selector first. L1 now
    // carries one owned suffix row from the bounded setup seed.)
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    await page.locator(`[data-testid="branch-cascader-item-${branch1Id}"]`).first().click()
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const s = (window as any).store.getState()
        const ids = s.messages?.messageIdsByTopic?.[tid]
        return Array.isArray(ids) && ids.length === len
      },
      { tid: sourceTopicId, len: ANCHOR_IDX + 2 },
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
          Array.isArray(ids) && ids.length === len && ids.includes(anchor) && s.messages?.loadingByTopic?.[tid] !== true
        )
      },
      { tid: sourceTopicId, len: PARENT_RESTORE_LEN, anchor: anchorId },
      { timeout: 30000 }
    )
    const parentResidentIds: string[] = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
      sourceTopicId
    )
    expect(parentResidentIds, 'windowed parent restore resident must be exactly main[5..29]').toEqual(expectedParentIds)
    // Authoritative completeness oracle via the same Main contract the
    // production divider switch reads (around/fork-anchor, main route):
    // older history remains available on demand; nothing newer is missing.
    const parentProbe: any = await page.evaluate(
      async ({ topicId, anchor, before, after }: { topicId: string; anchor: string; before: number; after: number }) =>
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
    // On-demand paging proof (standard fixture, exactly one real container
    // scroll): the oldest edge loads the remaining head (msgs 0..4) through
    // the production InfiniteScroll → around → merge path, including the
    // pending older-edge replay when `next` fires while the divider restore
    // still holds scroll ownership (navigation/anchoring). No sleep bypass —
    // a single oldest-edge scroll plus deterministic polling for data
    // convergence proves the production replay completes the resident to 30.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    const parentScrollTop = await page.evaluate(() => {
      const el = document.getElementById('messages') as HTMLElement | null
      if (!el) throw new Error('#messages not found')
      const targetTop = Math.min(0, el.clientHeight - el.scrollHeight)
      el.scrollTop = targetTop
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
      return { targetTop, reached: el.scrollTop }
    })
    expect(
      Math.abs(parentScrollTop.reached - parentScrollTop.targetTop) <= 12,
      `oldest-edge scroll must reach the inverse threshold (reached=${parentScrollTop.reached} target=${parentScrollTop.targetTop})`
    ).toBe(true)
    // Production replay convergence: exactly one scroll above, no further
    // scrolls or sleeps. The pending intent (when the scroll lands during the
    // divider stabilizer) replays once the viewport commits back to
    // navigation-idle + scrollMode user; the direct path covers the
    // already-idle case. Either way the resident converges to the full route.
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
    expect(await sidebarTopicIds(page)).toEqual(topicsBefore)

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
    // L1 has no owned suffix in this scenario, so its latest window is the
    // ancestor tail main[6..15] and its capability is precisely empty: every
    // ancestor ref is immutable on the child route (BRANCH-9 owned subset).
    expect((l1CapProbe.value.messages as any[]).map((m: any) => m.id)).toEqual(
      sourceIds.slice(ANCHOR_IDX + 1 - 10, ANCHOR_IDX + 1)
    )
    expect(l1CapProbe.value.mutableMessageIds as string[]).toEqual([])
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

    // 6. Top-selector cascader switch back to L2 — breadcrumb updates, no jump.
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    const l2row = page.locator(`[data-testid="branch-cascader-row-${branch1Id}"]`).first()
    await l2row.hover()
    const l2item = page.locator(`[data-testid="branch-cascader-item-${branch2Id}"]`).first()
    await expect(l2item, 'nested branch must appear in the next cascader column').toBeVisible({ timeout: 15000 })
    await l2item.click()
    await expect(page.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
      'E2E Renamed Branch',
      { timeout: 30000 }
    )
    // L2 top-switch restore contract (windowed): the L2 route is exactly
    // main[0..anchor] plus the L1-owned suffix (stable IDs, no clone),
    // breadcrumb keeps the branch path, and the stored active branch is L2.
    // The saved-position scroll restore is production-owned and
    // deterministically lands on the window head — so the test asserts the
    // exact resident first, then performs the user-visible anchor scroll
    // explicitly and asserts it.
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const s = (window as any).store.getState()
        const ids = s.messages?.messageIdsByTopic?.[tid]
        return Array.isArray(ids) && ids.length === len && s.messages?.loadingByTopic?.[tid] !== true
      },
      { tid: sourceTopicId, len: l2ExpectedIds.length },
      { timeout: 30000 }
    )
    const l2ResidentIds: string[] = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
      sourceTopicId
    )
    expect(l2ResidentIds, 'L2 restore resident must be exactly main prefix plus L1-owned suffix').toEqual(l2ExpectedIds)
    const activeAfterL2: string | null = await page.evaluate(
      (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
      sourceTopicId
    )
    expect(activeAfterL2, 'top-switch must land the active route on L2').toBe(branch2Id)
    await page.evaluate((id: string) => {
      const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
      if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
    }, l2AnchorId)
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
      l2AnchorId,
      { timeout: 30000 }
    )
    expect(await isVisibleInMessagesViewport(page, l2AnchorId)).toBe(true)

    // 6b. Topic switch away/back restores the logical topic's previously
    // active branch (no reset to main). Sidebar stays logical-topic-only.
    const otherTopicId = `intbranch-other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await seedSmallTopic(page, assistantId, otherTopicId, `Other ${otherTopicId}`)
    const topicsWithOther = await sidebarTopicIds(page)
    expect(topicsWithOther).toContain(sourceTopicId)
    expect(topicsWithOther).toContain(otherTopicId)
    expect(topicsWithOther).toEqual([...topicsBefore, otherTopicId].sort())
    await activateTopic(page, otherTopicId, 4)
    await activateTopic(page, sourceTopicId, l2ExpectedIds.length)
    // The L2 route is restored: breadcrumb keeps the branch path and the
    // stored active branch is L2 (not main).
    await expect(page.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
      'E2E Renamed Branch',
      { timeout: 30000 }
    )
    const restoredBranchId: string | null = await page.evaluate(
      (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
      sourceTopicId
    )
    expect(restoredBranchId).toBe(branch2Id)
    expect(await isVisibleInMessagesViewport(page, l2AnchorId)).toBe(true)
    expect(await sidebarTopicIds(page)).toEqual(topicsWithOther)

    // 6c. Top selector repeated open at depth: current L2 opens through the
    // L2-containing column but not L2's children; repeat close/open keeps
    // the same behavior (no collapse to first column, no over-expansion).
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    await expect(page.locator(`[data-testid="branch-cascader-item-${branch2Id}"]`).first()).toBeVisible({
      timeout: 15000
    })
    expect(await page.locator('[data-testid="branch-cascader-col-2"]').count()).toBe(0)
    // Repeat close/open preserves the same behavior (no collapse, no over-expansion).
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]')).toHaveCount(0, { timeout: 15000 })
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    await expect(page.locator(`[data-testid="branch-cascader-item-${branch2Id}"]`).first()).toBeVisible({
      timeout: 15000
    })
    expect(await page.locator('[data-testid="branch-cascader-col-2"]').count()).toBe(0)
    // Current L1 with children opens col-0 only (L1 highlighted, no child
    // column until hover on L1).
    await page.locator(`[data-testid="branch-cascader-item-${branch1Id}"]`).first().click()
    await expect(page.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
      'E2E Renamed Branch',
      { timeout: 30000 }
    )
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    expect(await page.locator('[data-testid="branch-cascader-col-1"]').count()).toBe(0)
    await page.locator(`[data-testid="branch-cascader-row-${branch1Id}"]`).first().hover()
    await expect(page.locator(`[data-testid="branch-cascader-item-${branch2Id}"]`).first()).toBeVisible({
      timeout: 15000
    })
    // Back to L2 for the relaunch persistence below.
    await page.locator(`[data-testid="branch-cascader-item-${branch2Id}"]`).first().click()
    await page.waitForFunction(
      ({ tid, bid }: { tid: string; bid: string }) => {
        const s = (window as any).store.getState()
        return s.topicBranch?.activeBranchIdByTopic?.[tid] === bid
      },
      { tid: sourceTopicId, bid: branch2Id },
      { timeout: 30000 }
    )

    // 7. Same-profile relaunch: catalog, names, active route, dividers persist.
    // Race guard (no fixed-sleep correctness gate): first prove the live Redux
    // active route is branch2, then prove the redux-persist writer flushed it
    // (wire-observed) before closing. Production close additionally runs the
    // save-data handshake (App_SaveData request → handleSaveData →
    // persistor.flush() → App_SaveDataAck), so window close completing means
    // the ack settled — the polls above plus close completion (not any
    // sleep) are the durability guarantee.
    const chatDbPath = getChatDbPath()
    expect(chatDbPath).not.toBeNull()
    await page.waitForFunction(
      ({ tid, bid }: { tid: string; bid: string }) => {
        const s = (window as any).store.getState()
        return s.topicBranch?.activeBranchIdByTopic?.[tid] === bid
      },
      { tid: sourceTopicId, bid: branch2Id },
      { timeout: 30000 }
    )
    await waitPersistWireFlushed(page, sourceTopicId, branch1Id, branch2Id)
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

      // 8. Top-selector Delete removes the L1 subtree (L1+L2); pre-branch UI returns.
      await page2.locator('[data-testid="branch-selector-entry"]').first().click()
      await expect(page2.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
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
      // Post-delete owner capability: removing the L1 subtree keeps/restores
      // the exact main owner set (BRANCH-4/9 — no descendant shrink, no
      // delete hole). Main-authoritative window probe, order-insensitive.
      const postDeleteCap: any = await page2.evaluate(
        async ({ topicId, limit }: { topicId: string; limit: number }) =>
          await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId, limit }),
        { topicId: sourceTopicId, limit: TOTAL }
      )
      expect(postDeleteCap?.ok, `post-delete capability probe failed: ${JSON.stringify(postDeleteCap)}`).toBe(true)
      expect((postDeleteCap.value.messages as any[]).map((m: any) => m.id)).toEqual(sourceIds)
      expect(new Set(postDeleteCap.value.mutableMessageIds as string[])).toEqual(new Set(sourceIds))
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

  test('visual contracts: new branch lands bottom, divider offset stable at positions, top round-trip repeats', async ({
    mainWindow
  }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'VISUAL-CONTRACT E2E: new true branch lands at latest/bottom; fork-divider keeps the same row offset across real divider-switch round-trips at multiple viewport positions; top selector round-trips through another route twice with no scrolling in the target route and restores the same stable messageId/intraRowOffset (pixel threshold); route-local A→B→A→B→A switching with distinct real-wheel established route-exclusive positions on both routes and zero scrolling of any kind in the measured loop asserts every return restores its own anchor identity + offset.'
    })
    const page = mainWindow
    await waitForAppReady(page)
    const assistantId = await prepareAssistant(page)
    const topicId = `visual-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ids = await seedSourceTopic(page, assistantId, topicId, `Visual ${topicId}`)
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
    const vcWheelSearchExclusiveExcluding = async (
      exclusiveIds: string[],
      excludeId: string,
      maxSteps = 30
    ): Promise<{ id: string; intra: number; offset: number } | null> => {
      // Ordinary-scroll supplement seek: real-wheel move to a DIFFERENT
      // exclusive crossing-first than the established one. Live-geometry stop
      // only; snapshot is asserted post-hoc by the caller.
      for (let i = 0; i < 6; i++) {
        await vcWheel(560)
        const settled = await vcSettled()
        if (settled && exclusiveIds.includes(settled.id) && settled.id !== excludeId) return settled
      }
      for (let i = 0; i < maxSteps; i++) {
        await vcWheel(-560)
        const settled = await vcSettled()
        if (settled && exclusiveIds.includes(settled.id) && settled.id !== excludeId) return settled
      }
      for (let i = 0; i < maxSteps; i++) {
        await vcWheel(560)
        const settled = await vcSettled()
        if (settled && exclusiveIds.includes(settled.id) && settled.id !== excludeId) return settled
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
    // real-wheel fine-tune toward the nominal block using live geometry only
    // (never keyv, never a fixed scroll-direction assumption — the sign is
    // probed once). The two nominal blocks stay distinct viewport positions;
    // each round-trip still asserts its own ≤12px offset stability with real
    // divider clicks and zero scrolling on the measured legs.
    const vcWheelPositionDivider = async (block: 'center' | 'start'): Promise<void> => {
      let vis = await vcDividerVisible()
      for (let i = 0; i < 24 && !vis; i++) {
        await vcWheel(-560)
        vis = await vcDividerVisible()
      }
      for (let i = 0; i < 24 && !vis; i++) {
        await vcWheel(560)
        vis = await vcDividerVisible()
      }
      expect(vis, `divider row must be reachable via real wheel at ${block}`).toBe(true)
      const targetOf = async (): Promise<number> => {
        const h = await page.evaluate(() => document.querySelector('#messages')?.getBoundingClientRect().height ?? 0)
        return block === 'start' ? 40 : h / 2
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
      expect(await vcDividerVisible(), `divider must stay visible after wheel positioning at ${block}`).toBe(true)
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
    // Measured A→B→A→B→A from here (currently on A): each return asserts
    // its own route-exclusive snapshot. NO scrolling of any kind in this loop
    // — no wheel, touch, pointer, keyboard, scrollbar, scrollIntoView, or
    // scrollTop writes: restores must place the viewport on their own.
    await switchTopRoute(null, 'branch-cascader-item-main', 1)
    assertAnchorRepeat('B return 1', mainBefore, await readStableAnchor(), 12)
    await assertExclusiveResident('B return 1', mainBefore?.id as string, branchBefore?.id as string, mainFullLen)
    await switchTopRoute(visualBranchId, `branch-cascader-item-${visualBranchId}`, 1)
    assertAnchorRepeat('A return 1', branchBefore, await readStableAnchor(), 12)
    await assertExclusiveResident('A return 1', branchBefore?.id as string, mainBefore?.id as string, branchFullLen)
    await switchTopRoute(null, 'branch-cascader-item-main', 1)
    assertAnchorRepeat('B return 2', mainBefore, await readStableAnchor(), 12)
    await assertExclusiveResident('B return 2', mainBefore?.id as string, branchBefore?.id as string, mainFullLen)
    await switchTopRoute(visualBranchId, `branch-cascader-item-${visualBranchId}`, 1)
    assertAnchorRepeat('A return 2', branchBefore, await readStableAnchor(), 12)
    await assertExclusiveResident('A return 2', branchBefore?.id as string, mainBefore?.id as string, branchFullLen)

    // Ordinary-scroll supplement: from the established main anchor, move via
    // real wheel to a DIFFERENT main-exclusive crossing-first anchor, record
    // the live anchor plus its post-hoc snapshot, then switch away/back with
    // zero scrolling during the switch and verify the NEW position restores
    // exact ID + ≤12px (ordinary scroll persistence retained). The wheel seek
    // stops on live geometry only; keyv is a post-hoc proof, never a gate.
    await switchTopRoute(null, 'branch-cascader-item-main', 1)
    await waitViewportVisible()
    let scrolledMainBefore = await vcWheelSearchExclusiveExcluding(mainPostForkExclusiveIds, mainBefore?.id as string)
    expect(scrolledMainBefore, 'scrolled main must expose a stable viewport-top anchor via real wheel').not.toBeNull()
    await waitViewportVisible()
    scrolledMainBefore = await vcSettled()
    expect(scrolledMainBefore, 'scrolled main live anchor must stay measurable after settle').not.toBeNull()
    await waitSnapshotMatchesLiveExclusive(null, mainPostForkExclusiveIds)
    expect(scrolledMainBefore, 'scrolled main must expose a stable viewport-top anchor').not.toBeNull()
    expect(scrolledMainBefore?.id, 'scrolled main stable anchor id must be non-empty').not.toBe('')
    expect(mainPostForkExclusiveIds, 'scrolled main stable anchor must be a main post-fork exclusive ID').toContain(
      scrolledMainBefore?.id
    )
    expect(ids.slice(0, ANCHOR_IDX + 1), 'scrolled main stable anchor must exclude the shared prefix').not.toContain(
      scrolledMainBefore?.id
    )
    expect(branchSuffixIds, 'scrolled main stable anchor must exclude the branch suffix').not.toContain(
      scrolledMainBefore?.id
    )
    expect(
      scrolledMainBefore?.id,
      'scrolled main must move to a different exclusive anchor than the established main viewport'
    ).not.toBe(mainBefore?.id)
    expect(await readRouteSnapshotId(null), 'main stable snapshot must equal the live crossing-first anchor').toBe(
      scrolledMainBefore?.id
    )
    await switchTopRoute(visualBranchId, `branch-cascader-item-${visualBranchId}`, 1)
    await assertExclusiveResident(
      'away on branch',
      branchBefore?.id as string,
      scrolledMainBefore?.id as string,
      branchFullLen
    )
    await switchTopRoute(null, 'branch-cascader-item-main', 1)
    assertAnchorRepeat('scrolled main return', scrolledMainBefore, await readStableAnchor(), 12)
    await assertExclusiveResident(
      'scrolled main return',
      scrolledMainBefore?.id as string,
      branchBefore?.id as string,
      mainFullLen
    )
    // Return the branch leg to a route-exclusive anchor for the divider
    // section below via real wheel (establishment scroll, outside the
    // measured loop). Divider pre-positions in the loop below likewise use
    // real wheel (`vcWheelPositionDivider`, round-1 contract choice) — the
    // divider intent then observes a genuine user-established position.
    await switchTopRoute(visualBranchId, `branch-cascader-item-${visualBranchId}`, 1)
    await waitViewportVisible()
    const dividerPrepAnchor = await vcWheelSearchExclusive(branchSuffixIds)
    expect(dividerPrepAnchor, 'divider-prep branch anchor must be measurable via real wheel').not.toBeNull()
    expect(branchSuffixIds, 'divider-prep branch anchor must stay branch-exclusive').toContain(dividerPrepAnchor?.id)
    await waitRouteWindowStable(1)
    await waitViewportVisible()
    await waitSnapshotMatchesLiveExclusive(visualBranchId, branchSuffixIds)

    // Divider round-trips at two viewport positions with real clicks: measure
    // the SAME logical divider row offset, switch to the parent route via the
    // divider popup, compare the row offset, then switch back via the divider
    // and compare again. Never a bare finite check.
    for (const block of ['center', 'start'] as const) {
      await waitActiveBranch(visualBranchId)
      await vcWheelPositionDivider(block)
      const dividerBefore = await measureDivider()
      expect(dividerBefore, `divider must be measurable at ${block}`).not.toBeNull()
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
      expect(dividerOnParent, `divider row must survive the switch at ${block}`).not.toBeNull()
      expect(
        Math.abs((dividerOnParent as number) - (dividerBefore as number)),
        `divider row offset must be stable across the switch at ${block}`
      ).toBeLessThanOrEqual(12)
      const parentToggle = page.locator(`[data-testid="branch-fork-toggle-${anchorId}"]`).first()
      await expect(parentToggle, 'parent route shows the untaken count form').toBeVisible({ timeout: 30000 })
      await parentToggle.click()
      await expect(page.locator(`[data-testid="branch-fork-list-${anchorId}"]`).first()).toBeVisible({
        timeout: 15000
      })
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
      expect(pagedResident, `fork anchor must stay resident after return at ${block}`).toContain(anchorId)
      const dividerBack = await measureDivider()
      expect(dividerBack, `divider row must be measurable after return at ${block}`).not.toBeNull()
      expect(
        Math.abs((dividerBack as number) - (dividerBefore as number)),
        `divider row offset must repeat after the round-trip at ${block}`
      ).toBeLessThanOrEqual(12)
      // Ordinary pagination anchoring (compatible with the divider contract):
      // the pre-paging head survives the merge and stays attached (resident
      // membership + DOM attached; never a visibility requirement).
      const visualHeadId = ids[ANCHOR_IDX - 10]
      expect(pagedResident).toContain(visualHeadId)
      expect(
        await page.evaluate(
          (id: string) => document.querySelectorAll(`#messages [data-message-id="${id}"]`).length,
          visualHeadId
        ),
        `pre-paging head must stay attached after return at ${block}`
      ).toBeGreaterThan(0)
      expect(
        await page.evaluate(
          (id: string) => document.querySelectorAll(`#messages [data-message-id="${id}"]`).length,
          anchorId
        ),
        `fork anchor must stay attached after return at ${block}`
      ).toBeGreaterThan(0)
    }
  })

  test('user journey black-box continuous main/A/B with real wheel and top/divider/creation UI', async ({
    mainWindow
  }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'USER-JOURNEY BLACK-BOX: single resident window user interaction journey over main + branch A + branch B (displayCount=100 keeps full routes in one resident window; windowed pagination covered by visual contracts/divider search tests); movement only via real wheel plus top selector plus divider UI plus creation UI; geometry-only acceptance (crossing-first anchor identity plus offset, divider offset, DOM attach and absence).'
    })
    const page = mainWindow
    await waitForAppReady(page)
    const assistantId = await prepareAssistant(page)
    // Single resident window user interaction journey (displayCount=100 keeps
    // full routes in one resident window; fixture prep only). Windowed
    // pagination is covered by visual contracts/divider search tests. All
    // actual switches/scrolls/creations below are real UI (wheel/top/divider/
    // message-button); API only inserts owned suffix rows.
    await page.evaluate((limit: number) => {
      ;(window as any).store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
    }, 100)
    const topicId = `journey-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ids = await seedSourceTopic(page, assistantId, topicId, `Journey ${topicId}`)
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
    const bbDividerOffset = (anchorId: string): Promise<number | null> =>
      page.evaluate((a: string) => {
        const container = document.querySelector('#messages') as HTMLElement | null
        if (!container) return null
        const row =
          (document.querySelector(`[data-testid="branch-fork-divider-${a}-main"]`) as HTMLElement | null) ??
          (document.querySelector(`[data-testid="branch-fork-divider-${a}"]`) as HTMLElement | null)
        if (!row) return null
        return row.getBoundingClientRect().top - container.getBoundingClientRect().top
      }, anchorId)
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

      // 2) Immediate return: top to main then immediately top back to A with
      // no wheel and no ready wait on the intermediate main (rapid switch:
      // the pending main transition tears down without committing, so the
      // transient main visit leaves no trace). A restores its exact live
      // anchor within 12px with foreign absent — this directly covers the
      // screenshot continuity (no bottom/tail assertion; main keeps its real
      // user-browsed position).
      await page.locator('[data-testid="branch-selector-entry"]').first().click()
      await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
      await page.locator('[data-testid="branch-cascader-item-main"]').first().click()
      // Immediate departure: no wheel, no bbWaitDomRoute on the transient main.
      await page.locator('[data-testid="branch-selector-entry"]').first().click()
      await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
      await page.locator(`[data-testid="branch-cascader-item-${branchAId}"]`).first().click()
      await bbWaitDomRoute()
      const anchorA1Back = await bbSettled()
      assertSameAnchor('A immediate return', anchorA1, anchorA1Back)
      expect(await bbCount(aTailForeignProbe), 'foreign main tail must stay absent after A return').toBe(0)

      // 3) Cut to main, form a main-exclusive anchor with real wheel, then at
      // least 2 A/main top round-trips with zero scrolling between switches.
      // The A round-1 visit departs immediately without scrolling, proving a
      // no-scroll visit leaves no trace (no pollution).
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
      await bbTopTo(branchAId)
      assertSameAnchor('A round 1', anchorA1, await bbSettled())
      expect(await bbCount(aTailForeignProbe), 'A round 1 foreign must stay absent').toBe(0)
      // No wheel on A round 1: immediate departure without scrolling.
      await bbTopTo(null)
      assertSameAnchor('main round 1', anchorM1, await bbSettled())
      expect(await bbCount(aForeignForMain), 'main round 1 foreign must stay absent').toBe(0)
      await bbTopTo(branchAId)
      assertSameAnchor('A round 2', anchorA1, await bbSettled())
      expect(await bbCount(aTailForeignProbe), 'A round 2 foreign must stay absent').toBe(0)
      await bbTopTo(null)
      assertSameAnchor('main round 2', anchorM1, await bbSettled())
      expect(await bbCount(aForeignForMain), 'main round 2 foreign must stay absent').toBe(0)

      // 4) Fork-divider UI from the current route to the other route; divider screen offset repeats.
      const dividerVisible = async (anchorId: string): Promise<boolean> =>
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
      let dividerSeen = await dividerVisible(anchorA)
      for (let i = 0; i < 24 && !dividerSeen; i++) {
        await bbWheel(-560)
        dividerSeen = await dividerVisible(anchorA)
      }
      expect(dividerSeen, 'divider row must be reachable via wheel').toBe(true)
      const dividerBefore = await bbDividerOffset(anchorA)
      expect(dividerBefore, 'divider must be measurable before switch').not.toBeNull()
      // Source-route departure position (black-box geometry only): the real
      // wheel search above necessarily moves main to the divider vicinity, and
      // production saves that departure position on the source route. Pin it
      // here so post-divider top returns assert the true current main stable
      // (still a real wheel-established position on the main valid route —
      // shared divider vicinity is legal), not the stale pre-search anchorM1.
      const anchorMBeforeDivider = await bbSettled()
      expect(anchorMBeforeDivider, 'main departure anchor must be measurable before divider switch').not.toBeNull()
      expect(ids, 'main departure anchor must sit on the main valid route').toContain(
        anchorMBeforeDivider?.id as string
      )
      expect(await bbVisible(anchorMBeforeDivider?.id as string), 'main departure anchor must be visible').toBe(true)
      const taken = page.locator(`[data-testid="branch-fork-selected-${anchorA}"]`).first()
      const untaken = page.locator(`[data-testid="branch-fork-toggle-${anchorA}"]`).first()
      if (await taken.count()) {
        await expect(taken, 'taken divider must be visible').toBeVisible({ timeout: 15000 })
        await taken.click()
        await expect(page.locator(`[data-testid="branch-fork-list-${anchorA}"]`).first()).toBeVisible({
          timeout: 15000
        })
        await page.locator(`[data-testid="branch-fork-item-parent-${anchorA}"]`).first().click()
      } else {
        await expect(untaken, 'untaken divider must be visible').toBeVisible({ timeout: 15000 })
        await untaken.click()
        await expect(page.locator(`[data-testid="branch-fork-list-${anchorA}"]`).first()).toBeVisible({
          timeout: 15000
        })
        await page.locator(`[data-testid="branch-fork-item-${branchAId}"]`).first().click()
      }
      await bbWaitDomRoute()
      expect(await dividerVisible(anchorA), 'divider must stay visible after switch').toBe(true)
      const dividerAfter = await bbDividerOffset(anchorA)
      expect(dividerAfter, 'divider must be measurable after switch').not.toBeNull()
      expect(
        Math.abs((dividerAfter as number) - (dividerBefore as number)),
        'divider screen offset must repeat within 12px'
      ).toBeLessThanOrEqual(12)
      // Divider switching deliberately supersedes target route's prior stable
      // viewport with the maintained current visual position (shared fork
      // vicinity); top switching thereafter restores this new stable position.
      // Black-box acceptance only: DOM geometry + attach/absence, no keyv /
      // snapshot / Redux reads, no internal snapshot wait.
      expect(await bbVisible(anchorA), 'shared fork anchor must stay visible after divider switch').toBe(true)
      expect(await bbCount(mainTail), 'divider-switched A must still exclude the main-exclusive tail').toBe(0)
      const aRouteIds = [...ids.slice(0, ANCHOR_IDX + 1), ...aExcl]
      const anchorAAfterDivider = await bbSettled()
      expect(anchorAAfterDivider, 'A stable visual anchor must be measurable after divider switch').not.toBeNull()
      expect(aRouteIds, 'A post-divider anchor must sit on the A valid route').toContain(
        anchorAAfterDivider?.id as string
      )
      expect(await bbVisible(anchorAAfterDivider?.id as string), 'A post-divider anchor must be visible').toBe(true)
      // Shared current position is legal: the post-divider anchor may be the
      // shared fork message itself (divider semantics share the current visual
      // position), so no exclusive-membership claim here — only that it sits
      // near the divider in the same viewport.
      expect(
        Math.abs((anchorAAfterDivider?.offset ?? 0) - (dividerAfter as number)),
        'A post-divider anchor must sit near the divider visual position'
      ).toBeLessThanOrEqual(1200)

      // 5) Real message UI creates branch B; reasonable landing (selector + fork anchor visible).
      // Ensure the owner main route is active for the creation click.
      await bbTopTo(null)
      const reachedB = await bbWheelUntilVisible(anchorB)
      expect(reachedB, 'B fork anchor must be reachable via wheel').toBe(true)
      // Final main departure position before creation (black-box only): the
      // B-search wheel above necessarily moves main again (divider-vicinity
      // 00015 -> B-vicinity), and production saves that departure on main.
      // Post-B top returns assert this true current main stable, not the
      // stale pre-divider anchorM1 nor the intermediate anchorMBeforeDivider.
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

      // 6) In B wheel to a B-exclusive anchor; multi-route top restores for A/main/B.
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
      // Top switching restores the divider-superseded stable position: A now
      // restores anchorAAfterDivider (not the pre-divider anchorA1); main
      // restores its pre-creation departure anchorMBeforeBCreation (source
      // saves on departure through divider search + B search, not the stale
      // pre-search anchorM1).
      await bbTopTo(branchAId)
      assertSameAnchor('A after B', anchorAAfterDivider, await bbSettled())
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

      // 7) Transient visit without scrolling must not pollute either side.
      // Each route keeps its current stable position (A keeps the
      // divider-superseded anchorAAfterDivider; main keeps the pre-creation
      // departure anchorMBeforeBCreation; B keeps its exclusive anchorB1).
      await bbTopTo(null)
      assertSameAnchor('main pre-transient', anchorMBeforeBCreation, await bbSettled())
      await bbTopTo(branchAId)
      // No wheel here: immediate departure proves a no-scroll visit leaves no trace.
      await bbTopTo(branchBId)
      assertSameAnchor('B after transient A', anchorB1, await bbSettled())
      await bbTopTo(null)
      assertSameAnchor('main after transient A', anchorMBeforeBCreation, await bbSettled())
      await bbTopTo(branchAId)
      assertSameAnchor('A after transient', anchorAAfterDivider, await bbSettled())
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
    const assistantId = await prepareAssistant(page)
    const topicId = `perm-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sourceIds = await seedSourceTopic(page, assistantId, topicId, `Perm ${topicId}`)
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

  test('owner main edit visible in child under stable ID; child ref read-only (no E2E run this round)', async ({
    mainWindow,
    electronApp,
    mockPort,
    ownedTmpRoot
  }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'TRUE-BRANCH OWNER-ONLY FOCUSED: seed small topic, fork L1 via IPC, owner main update succeeds and is visible in the child effective route under the same stable ID with no row copy; child update of the same ancestor ID fails closed; window capability carries owner-owned IDs on main and only the owned suffix on the child.'
    })
    void electronApp
    void mockPort
    void ownedTmpRoot
    await waitForAppReady(mainWindow)
    const page = mainWindow
    const assistantId = await prepareAssistant(page)
    const topicId = `tb-owner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await seedSmallTopic(page, assistantId, topicId, `OwnerOnly ${topicId}`)
    const ids: string[] = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      return (s.messages?.messageIdsByTopic?.[tid] ?? []) as string[]
    }, topicId)
    // Ensure the seeded route is loaded; fall back to the known small-seed IDs.
    const anchorId = ids.length > 1 ? ids[1] : `${topicId}-msg-00001`
    // Fork L1 through the anchor via the real Main IPC (same contract the toolbar uses).
    const created: any = await page.evaluate(
      async ({ tid, anchor }: { tid: string; anchor: string }) =>
        await (window as any).api.chatDb.createBranch({ topicId: tid, parentBranchId: null, anchorMessageId: anchor }),
      { tid: topicId, anchor: anchorId }
    )
    expect(created?.ok, `createBranch failed: ${JSON.stringify(created)}`).toBe(true)
    const branchId = created.value.branch.id as string
    // Owner main edit of the referenced anchor succeeds (butterfly effect, BRANCH-4/5).
    const editedContent = `owner-edit-${Date.now()}`
    const updateOk: any = await page.evaluate(
      async ({ tid, mid, content }: { tid: string; mid: string; content: string }) =>
        await (window as any).api.chatDb.updateMessage({ topicId: tid, messageId: mid, updates: { content } }),
      { tid: topicId, mid: anchorId, content: editedContent }
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
    const childHit = (childRoute.value.messages as any[]).find((m: any) => m.id === anchorId)
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
      { tid: topicId, mid: anchorId, bid: branchId }
    )
    expect(childWrite?.ok, 'child write of an ancestor reference must fail closed').toBe(false)
    // Window capability: main carries the owned anchor; child carries only its owned suffix.
    const mainCap: any = await page.evaluate(
      async ({ tid }: { tid: string }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId: tid, limit: 10 }),
      { tid: topicId }
    )
    expect(mainCap?.ok).toBe(true)
    expect(mainCap.value.mutableMessageIds as string[]).toContain(anchorId)
    const childCap: any = await page.evaluate(
      async ({ tid, bid }: { tid: string; bid: string }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({
          kind: 'latest',
          topicId: tid,
          branchId: bid,
          limit: 10
        }),
      { tid: topicId, bid: branchId }
    )
    expect(childCap?.ok).toBe(true)
    expect((childCap.value.mutableMessageIds as string[]).includes(anchorId)).toBe(false)
    // Stable identity: no prefix copy was created (row count unchanged apart from the branch row).
    const chatDbPath = getChatDbPath()
    expect(chatDbPath).not.toBeNull()
    const countRes = await queryChatDbViaElectronWithRetry(
      chatDbPath!,
      `SELECT COUNT(*) AS n FROM messages WHERE topic_id = '${esc(topicId)}'`
    )
    expect(countRes?.ok).toBe(true)
    expect((((countRes as any).rows ?? []) as any[])[0]?.n).toBe(4)
    // Fixture teardown owns Electron cleanup; no manual close here.
  })

  test('branch insert on last prefix via real UI lands at suffix start with immediate capability', async ({
    mainWindow,
    electronApp,
    mockPort,
    ownedTmpRoot
  }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'TRUE-BRANCH INSERT SUFFIX-START: fork L1 with a pre-existing owned suffix, invoke the production MessageMenubar insert on the last ancestor-prefix assistant message (branch anchor) via the real msg-insert-btn, then prove without any route switch or full reload that the two new branch-owned rows render at suffix start with immediate edit/delete controls; Redux supplements (never replaces) the DOM order; a Main fetchMessagesWindow probe preserves the authoritative capability; post-exit SQLite proves durable owned-suffix order.'
    })
    void mockPort
    void ownedTmpRoot
    await waitForAppReady(mainWindow)
    const page = mainWindow
    const assistantId = await prepareAssistant(page)
    const topicId = `tb-insert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await seedSmallTopic(page, assistantId, topicId, `InsertSuffix ${topicId}`)
    const seedIds = [`${topicId}-msg-00000`, `${topicId}-msg-00001`, `${topicId}-msg-00002`, `${topicId}-msg-00003`]
    const branchAnchor = seedIds[1]
    const created: any = await page.evaluate(
      async ({ tid, anchor }: { tid: string; anchor: string }) =>
        await (window as any).api.chatDb.createBranch({ topicId: tid, parentBranchId: null, anchorMessageId: anchor }),
      { tid: topicId, anchor: branchAnchor }
    )
    expect(created?.ok, `createBranch failed: ${JSON.stringify(created)}`).toBe(true)
    const branchId = created.value.branch.id as string
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
    // Supplemental Main-authoritative capability (same contract the divider
    // switch reads): the branch window carries the effective order with only
    // the owned suffix mutable.
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
