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
 * 4. Real toolbar click on an INHERITED message forks L2 (parent = L1).
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

    // 4. Second level from an INHERITED message (parent route = L1).
    await clickToolbarBranch(page, inheritedAnchorId)
    await page.waitForFunction(
      ({ tid }: { tid: string }) => {
        const s = (window as any).store.getState()
        return (s.topicBranch?.branchesByTopic?.[tid] ?? []).length === 2
      },
      { tid: sourceTopicId },
      { timeout: 30000 }
    )
    branches = await listBranches(page, sourceTopicId)
    expect(branches).toHaveLength(2)
    const branch2 = branches.find((b: any) => b.id !== branch1Id)
    expect(branch2.parentBranchId).toBe(branch1Id)
    expect(branch2.anchorMessageId).toBe(inheritedAnchorId)
    const branch2Id = branch2.id as string
    expect(await sidebarTopicIds(page)).toEqual(topicsBefore)

    // 5. Fork-divider switch on the L1 route: its anchor fork is taken
    // (selected branch name shown); switching to the parent/original route
    // lands on the SAME shared anchor, never a bottom jump. (The fresh L2
    // route only spans main[0..m5], so its anchor fork is not in view —
    // return to L1 via the top selector first.)
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    await page.locator(`[data-testid="branch-cascader-item-${branch1Id}"]`).first().click()
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const s = (window as any).store.getState()
        const ids = s.messages?.messageIdsByTopic?.[tid]
        return Array.isArray(ids) && ids.length === len
      },
      { tid: sourceTopicId, len: ANCHOR_IDX + 1 },
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

    // 5b. Mutation capability on the restored parent route (Main-authoritative
    // mutableMessageIds): the fork anchor and its prior shared prefix are
    // immutable, while a post-anchor main message stays mutable. The L1 route
    // probe excludes the shared prefix from its capability.
    const restoredMutable: string[] = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.mutableMessageIdsByTopic?.[tid] ?? [],
      sourceTopicId
    )
    const restoredRoute: string | null | undefined = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.mutableRouteByTopic?.[tid] ?? null,
      sourceTopicId
    )
    expect(restoredRoute, 'restored parent capability must be bound to the main route').toBeNull()
    expect(
      restoredMutable.length,
      'restored parent capability must be non-empty (no empty-array hole)'
    ).toBeGreaterThan(0)
    expect(restoredMutable, 'shared fork anchor must not be mutable on the parent route').not.toContain(anchorId)
    expect(restoredMutable, 'pre-anchor shared prefix must not be mutable on the parent route').not.toContain(
      sourceIds[0]
    )
    for (const sharedId of sourceIds.slice(0, 5)) {
      expect(restoredMutable, `shared prefix ${sharedId} must not be mutable on the parent route`).not.toContain(
        sharedId
      )
    }
    const restoredTail = sourceIds[sourceIds.length - 1]
    expect(restoredMutable, 'post-anchor parent message must stay mutable').toContain(restoredTail)
    const l1CapProbe: any = await page.evaluate(
      async ({ topicId, branchId }: { topicId: string; branchId: string }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId, branchId, limit: 10 }),
      { topicId: sourceTopicId, branchId: branch1Id }
    )
    expect(l1CapProbe?.ok, `L1 capability probe failed: ${JSON.stringify(l1CapProbe)}`).toBe(true)
    expect(
      (l1CapProbe.value.mutableMessageIds as string[]).includes(anchorId),
      'shared prefix must be excluded from the L1 capability'
    ).toBe(false)
    // DOM: the hovered shared anchor hides mutation controls on the parent route.
    await page.evaluate((id: string) => {
      const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
      if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
    }, anchorId)
    const anchorSel = `[id="message-${anchorId}"][data-message-id="${anchorId}"]`
    const anchorContainer = page.locator(anchorSel).first()
    await expect(anchorContainer, 'shared anchor container must be visible').toBeVisible({ timeout: 15000 })
    try {
      await anchorContainer.hover({ timeout: 8000 })
    } catch {
      // Hover flakiness near edges; visibility assertions below still hold.
    }
    await expect(
      anchorContainer.locator('[data-testid="msg-edit-btn"], [data-testid="msg-assistant-edit-btn"]'),
      'shared anchor edit control must be hidden on the parent route'
    ).toHaveCount(0)
    await expect(
      anchorContainer.locator('[data-testid="message-delete-button"]'),
      'shared anchor delete control must be hidden on the parent route'
    ).toHaveCount(0)

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
    // main[0..5] (stable IDs, no clone), breadcrumb keeps the branch path,
    // and the stored active branch is L2. The saved-position scroll restore
    // is production-owned and deterministically lands on the window head —
    // so the test asserts the exact resident first, then performs the
    // user-visible anchor scroll explicitly and asserts it.
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const s = (window as any).store.getState()
        const ids = s.messages?.messageIdsByTopic?.[tid]
        return Array.isArray(ids) && ids.length === len && s.messages?.loadingByTopic?.[tid] !== true
      },
      { tid: sourceTopicId, len: INHERITED_ANCHOR_IDX + 1 },
      { timeout: 30000 }
    )
    const l2ResidentIds: string[] = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
      sourceTopicId
    )
    expect(l2ResidentIds, 'L2 restore resident must be exactly main[0..5]').toEqual(
      sourceIds.slice(0, INHERITED_ANCHOR_IDX + 1)
    )
    const activeAfterL2: string | null = await page.evaluate(
      (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
      sourceTopicId
    )
    expect(activeAfterL2, 'top-switch must land the active route on L2').toBe(branch2Id)
    await page.evaluate((id: string) => {
      const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
      if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
    }, inheritedAnchorId)
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
      inheritedAnchorId,
      { timeout: 30000 }
    )
    expect(await isVisibleInMessagesViewport(page, inheritedAnchorId)).toBe(true)

    // 6b. Topic switch away/back restores the logical topic's previously
    // active branch (no reset to main). Sidebar stays logical-topic-only.
    const otherTopicId = `intbranch-other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await seedSmallTopic(page, assistantId, otherTopicId, `Other ${otherTopicId}`)
    const topicsWithOther = await sidebarTopicIds(page)
    expect(topicsWithOther).toContain(sourceTopicId)
    expect(topicsWithOther).toContain(otherTopicId)
    expect(topicsWithOther).toEqual([...topicsBefore, otherTopicId].sort())
    await activateTopic(page, otherTopicId, 4)
    await activateTopic(page, sourceTopicId, INHERITED_ANCHOR_IDX + 1)
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
    expect(await isVisibleInMessagesViewport(page, inheritedAnchorId)).toBe(true)
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
      await waitActiveRouteWindowStable(page2, sourceTopicId, INHERITED_ANCHOR_IDX + 1)
      await expect(page2.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
        'E2E Renamed Branch',
        { timeout: 30000 }
      )
      const relaunchedBranchId: string | null = await page2.evaluate(
        (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
        sourceTopicId
      )
      expect(relaunchedBranchId).toBe(branch2Id)
      // The L2 route's own taken fork (at its anchor) is back as well.
      await expect(page2.locator(`[data-testid="branch-fork-selected-${inheritedAnchorId}"]`).first()).toBeVisible({
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
        'VISUAL-CONTRACT E2E: new true branch lands at latest/bottom; fork-divider keeps the same row offset across real divider-switch round-trips at multiple viewport positions; top selector round-trips through another route twice with no scrolling in the target route and restores the same stable messageId/intraRowOffset (pixel threshold).'
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
    const scrollAnchorTo = async (block: ScrollLogicalPosition): Promise<void> => {
      await page.evaluate(
        ({ id, block }: { id: string; block: ScrollLogicalPosition }) => {
          const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
          const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
          if (el) el.scrollIntoView({ block, inline: 'nearest', behavior: 'instant' as ScrollBehavior })
        },
        { id: anchorId, block }
      )
      await rafSettle()
    }

    // True top-selector round-trip (twice, no scrolling in the target route):
    // L1 (target) -> main (other route, window stable) -> L1. The stable
    // anchor identity + intra-row offset must repeat within pixels.
    await scrollAnchorTo('center')
    await waitRouteWindowStable(ANCHOR_IDX + 1)
    const targetBefore = await readStableAnchor()
    expect(targetBefore, 'target route must expose a stable viewport-top anchor').not.toBeNull()
    for (let round = 0; round < 2; round += 1) {
      await openTopSelector()
      await page.locator('[data-testid="branch-cascader-item-main"]').first().click()
      await waitActiveBranch(null)
      await waitRouteWindowStable(1)
      // No scrolling while away or after returning: the restore itself must
      // place the viewport; any explicit scroll here would mask regression.
      await openTopSelector()
      await page.locator(`[data-testid="branch-cascader-item-${visualBranchId}"]`).first().click()
      await waitActiveBranch(visualBranchId)
      await waitRouteWindowStable(ANCHOR_IDX + 1)
      expect(await readActiveBranch()).toBe(visualBranchId)
      const targetAfter = await readStableAnchor()
      expect(targetAfter, `round ${round}: stable anchor must be measurable after return`).not.toBeNull()
      expect(targetAfter?.id, `round ${round}: same stable message must anchor the viewport`).toBe(targetBefore?.id)
      expect(
        Math.abs((targetAfter?.intra ?? 0) - (targetBefore?.intra ?? 0)),
        `round ${round}: intra-row offset must repeat within pixels`
      ).toBeLessThanOrEqual(12)
      expect(
        Math.abs((targetAfter?.offset ?? 0) - (targetBefore?.offset ?? 0)),
        `round ${round}: pixel offset must repeat within threshold`
      ).toBeLessThanOrEqual(12)
    }

    // Divider round-trips at two viewport positions with real clicks: measure
    // the SAME logical divider row offset, switch to the parent route via the
    // divider popup, compare the row offset, then switch back via the divider
    // and compare again. Never a bare finite check.
    for (const block of ['center', 'start'] as const) {
      await waitActiveBranch(visualBranchId)
      await scrollAnchorTo(block)
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
      // True-branch visual divider return: resident-first, no unconditional
      // oldest-edge scroll. The windowed return may first commit the around
      // window (main[5..15], 11 msgs) and then auto-page the head (msgs 0..4)
      // via the production InfiniteScroll → pending-replay → around → merge
      // path. Read the resident first: when auto replay already converged to
      // the full 16, skip the oldest-edge scroll and settle the DOM directly;
      // only when the resident is still the 11-window, perform exactly one
      // oldest-edge scroll to trigger pagination. Either way the final
      // contract is the SAME divider row absolute offset repeating within
      // pixels (preferred divider anchor). No `visualHeadId`/fork-anchor
      // visibility assertion (resident membership + DOM attached only).
      await waitRouteWindowStable(1)
      await rafSettle()
      let returnResident: string[] = await page.evaluate(
        (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
        topicId
      )
      if (returnResident.length === ANCHOR_IDX + 1) {
        // Auto replay already complete: no oldest-edge scroll. Wait for DOM
        // settle to the full prefix, then verify the divider contract.
        await page.waitForFunction(
          (len: number) => document.querySelectorAll('#messages [data-message-id]').length === len,
          ANCHOR_IDX + 1,
          { timeout: 30000 }
        )
        await rafSettle()
      } else {
        // Still the 11-window: exactly one oldest-edge scroll triggers
        // pagination, then wait for the final resident (full 16).
        await page.evaluate(() => {
          const el = document.getElementById('messages') as HTMLElement | null
          if (!el) throw new Error('#messages not found')
          const targetTop = Math.min(0, el.clientHeight - el.scrollHeight)
          el.scrollTop = targetTop
          el.dispatchEvent(new Event('scroll', { bubbles: true }))
        })
        await page.waitForFunction(
          ({ tid, len, anchor }: { tid: string; len: number; anchor: string }) => {
            const s = (window as any).store.getState()
            const rids = s.messages?.messageIdsByTopic?.[tid]
            return (
              Array.isArray(rids) &&
              rids.length === len &&
              rids.includes(anchor) &&
              s.messages?.loadingByTopic?.[tid] !== true
            )
          },
          { tid: topicId, len: ANCHOR_IDX + 1, anchor: anchorId },
          { timeout: 30000 }
        )
        await page.waitForFunction(
          (len: number) => document.querySelectorAll('#messages [data-message-id]').length === len,
          ANCHOR_IDX + 1,
          { timeout: 30000 }
        )
        await rafSettle()
      }
      const pagedResident: string[] = await page.evaluate(
        (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
        topicId
      )
      expect(pagedResident, `visual return must converge the resident to the full prefix at ${block}`).toEqual(
        ids.slice(0, ANCHOR_IDX + 1)
      )
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

  test('branch route permission: shared answer group rejects, private group operates, mixed edit selection gates writes', async ({
    mainWindow
  }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'PROJ-13 INTEGRATED: a parent-route multi-answer group covered by a live child prefix rejects append/useful/select/reorder through the parent route (real IPC + SQLite, zero partial writes); a post-anchor private group still operates (selectAnswer); a mixed shared+private edit selection disables cut/delete with zero change while copy still works. No overlay semantics are introduced.'
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

    // Build a two-answer group under user0 while it is still private.
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

    // Fork L1 through msg-00010: the user0 answer group becomes a shared
    // prefix on the parent route; the msg-00020 pair stays post-anchor private.
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

    // Shared multi-answer group: append-join / useful / select / reorder all
    // reject through the parent route with zero partial writes.
    const selectShared = await page.evaluate(
      ({ tid, id }: { tid: string; id: string }) => {
        const api: any = (window as any).api.chatDb
        return api.selectAnswerMessage({ topicId: tid, branchId: null, selectedMessageId: id })
      },
      { tid: topicId, id: extraId }
    )
    expect(selectShared?.ok, 'shared group select must reject').toBe(false)
    const usefulShared = await page.evaluate(
      ({ tid, id }: { tid: string; id: string }) => {
        const api: any = (window as any).api.chatDb
        return api.selectUsefulAnswer({ topicId: tid, branchId: null, messageId: id })
      },
      { tid: topicId, id: asst1 }
    )
    expect(usefulShared?.ok, 'shared group useful must reject').toBe(false)
    const reorderShared = await page.evaluate(
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
    expect(reorderShared?.ok, 'shared group reorder must reject').toBe(false)
    const joinShared = await page.evaluate(
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
    expect(joinShared?.ok, 'shared group append-join must reject').toBe(false)

    // Post-anchor private group still operates (one stable select).
    const selectPrivate = await page.evaluate(
      ({ tid, id }: { tid: string; id: string }) => {
        const api: any = (window as any).api.chatDb
        return api.selectAnswerMessage({ topicId: tid, branchId: null, selectedMessageId: id })
      },
      { tid: topicId, id: asstLater }
    )
    expect(selectPrivate?.ok, `private group select must succeed: ${JSON.stringify(selectPrivate)}`).toBe(true)
    expect((selectPrivate as any).value?.messageIds).toEqual([asstLater])

    // Zero-partial-write proof against live SQLite (bounded retry on pressure).
    const chatDbPath = getChatDbPath()
    expect(chatDbPath).not.toBeNull()
    const countAfter = await queryChatDbViaElectronWithRetry(
      chatDbPath!,
      `SELECT COUNT(*) AS n FROM messages WHERE topic_id = '${esc(topicId)}'`
    )
    expect(countAfter?.ok).toBe(true)
    expect((((countAfter as any).rows ?? []) as any[])[0]?.n).toBe(TOTAL + 1)
    const joinAbsent = await queryChatDbViaElectronWithRetry(
      chatDbPath!,
      `SELECT id FROM messages WHERE id = '${esc(`${topicId}-msg-extra02`)}'`
    )
    expect(joinAbsent?.ok).toBe(true)
    expect(((joinAbsent as any).rows ?? []) as any[]).toHaveLength(0)

    // Mixed shared+private edit selection: cut/delete disabled, copy works,
    // keyboard cut is a zero-change no-op. True-branch entry: the real
    // edit-mode toggle enables edit mode first; selection is set in a
    // separate step only after the heavy edit bridge is attached.
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
    await expect(cutBtn, 'mixed-selection cut must be disabled').toBeDisabled({ timeout: 15000 })
    await expect(delBtn, 'mixed-selection delete must be disabled').toBeDisabled({ timeout: 15000 })
    await expect(copyBtn, 'copy stays enabled on mixed selections').toBeEnabled({ timeout: 15000 })
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
    // Real keyboard cut path: Meta+X must leave the copy clipboard untouched.
    // A short settle window is required here because the assertion is the
    // ABSENCE of a change (no state transition to wait on); the cut handler
    // is synchronous fire-and-forget, so 500ms bounds the observation.
    await page.keyboard.press('Meta+x')
    await page.waitForTimeout(500)
    const clipboardAfterCut = await page.evaluate(() => {
      const s = (window as any).store.getState()
      return { mode: s.clipboard?.mode, groups: (s.clipboard?.items ?? []).length }
    })
    expect(clipboardAfterCut).toEqual(clipboardAfterCopy)
    const countFinal = await queryChatDbViaElectronWithRetry(
      chatDbPath!,
      `SELECT COUNT(*) AS n FROM messages WHERE topic_id = '${esc(topicId)}'`
    )
    expect(countFinal?.ok).toBe(true)
    expect((((countFinal as any).rows ?? []) as any[])[0]?.n).toBe(TOTAL + 1)
    await editToggle.click()
    await page.waitForFunction(() => (window as any).store.getState().editMode?.enabled === false, null, {
      timeout: 15000
    })
    await expect(page.locator('[data-testid="edit-heavy-inactive"]').first()).toBeAttached({ timeout: 15000 })
  })
})
