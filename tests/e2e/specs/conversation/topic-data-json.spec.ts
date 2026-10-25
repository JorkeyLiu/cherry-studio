/**
 * Topic-data JSON exchange — real E2E verification.
 *
 * Proves the standalone topic JSON file exchange through real UI gestures and
 * Main-authority oracles:
 *   - T1: header import-button position (direct icon left of Manage) + topic
 *     context-menu Export submenu `json` entry (`导出为 JSON` / `Export as
 *     JSON`, no icon) + real UI export through a MAIN-side
 *     `dialog.showSaveDialog` interception into an owned file, with the real
 *     `window.api.file.save` -> real Main filesystem write path unmodified.
 *     The file is verified to actually exist on disk and parse; payload
 *     bytes are read back from disk (never helper-written from captured
 *     stub bytes), covering main/nested/sibling branches, segments, file
 *     refs, and order.
 *   - T2: real header-icon imports (MAIN-side `dialog.showOpenDialog` stub
 *     serving an owned JSON file, real `window.api.file.open` -> real Main
 *     filesystem read) twice yield distinct topic/entity IDs with preserved
 *     refs/relationships and current-assistant rebinding; both survive a
 *     same-profile relaunch.
 *   - T3: canceled native dialogs do not mutate; unsupported/malformed
 *     payloads surface a localized error with no extra topic. All dialogs
 *     are MAIN-side interceptions; the renderer `window.api.file.*` surface
 *     is never mocked (read-only `window.api.chatDb`/store observers only).
 *
 * Governing constraints:
 * - Seeds via approved Main APIs only (`assistants/addTopic` projection +
 *   `chatDb.ensureTopic/appendMessage/createBranch/upsertSegment`); never raw
 *   direct live SQLite writes.
 * - Missing-attachment metadata (dangling `fileId`) is preserved verbatim;
 *   no availability markers are added or asserted, no payload/catalog copying,
 *   exact existing missing-file behavior only.
 * - Unit tests (9 main + 8 renderer + shared contracts) own the exhaustive
 *   validation matrix; E2E uses one representative Main rejection only.
 * - R04 (`windowed-message-reads`) menu mapping: that spec asserts no prompt
 *   item, no copy submenu, no top-level notes item, Save nesting
 *   notes+knowledge, and Export-as-markdown. The additive `json` child under
 *   the existing Export submenu changes none of those assertions, so no
 *   existing spec is modified by this change.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect, getChatDbPath, queryChatDbViaElectron, test } from '../../fixtures/electron.fixture'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { relaunchSameProfile } from '../../utils/restart-electron-profile'
import { waitForAppReady } from '../../utils/wait-helpers'

// ---------------------------------------------------------------------------
// Shared helpers (spec-local only — never fixture-global)
// ---------------------------------------------------------------------------

function queryRows(dbPath: string, sql: string): any[] {
  const result = queryChatDbViaElectron(dbPath, sql)
  if (!result.ok) throw new Error(`SQLite query failed: ${result.code}`)
  return result.rows as any[]
}

const esc = (value: string): string => value.replace(/'/g, "''")

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

interface SeedPlan {
  topicId: string
  assistantId: string
  topicName: string
  /** Main-route contents in authority order. */
  mainContents: string[]
  /** Branch-route contents keyed by branch name. */
  branchContents: Record<string, string[]>
  /** Segment membership contents in exact order. */
  segmentContents: string[]
  missingFileId: string
  missingFileName: string
}

/**
 * Seed ONE rich logical topic via approved Main APIs only: Redux projection
 * (`assistants/addTopic`) + `chatDb.ensureTopic/appendMessage/createBranch/
 * upsertSegment`. Builds main route (u1, a1 with askId, u2 carrying a file
 * block whose `fileId` dangles — missing attachment metadata), nested branch
 * L1 (anchored at a1) with L2 nested under L1 (anchored at u3), sibling branch
 * S1 (anchored at a1), and one ordered segment over [u1, a1].
 */
async function seedRichTopic(page: any): Promise<SeedPlan> {
  const assistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(assistantId, 'live assistant id must exist').toBeTruthy()
  const topicId = newId('topic-data')
  const topicName = `Topic Data ${topicId}`
  const missingFileId = `e2e-missing-file-${Date.now()}`
  const missingFileName = 'missing-attachment.txt'
  const stamp = new Date().toISOString()

  const mainContents = ['td-u1', 'td-a1', 'td-u2']
  const branchContents: Record<string, string[]> = {
    L1: ['td-u3', 'td-a3'],
    L2: ['td-u4'],
    S1: ['td-u5']
  }
  const segmentContents = ['td-u1', 'td-a1']

  const seeded = await page.evaluate(
    async ({
      topicId,
      assistantId,
      topicName,
      stamp,
      missingFileId,
      missingFileName
    }: {
      topicId: string
      assistantId: string
      topicName: string
      stamp: string
      missingFileId: string
      missingFileName: string
    }) => {
      try {
        const store = (window as any).store
        const api = (window as any).api.chatDb
        store.dispatch({
          type: 'assistants/addTopic',
          payload: {
            assistantId,
            topic: { id: topicId, assistantId, name: topicName, createdAt: stamp, updatedAt: stamp }
          }
        })
        const ensured = await api.ensureTopic({ topicId, assistantId, name: topicName })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }

        const msgIds: Record<string, string> = {}
        const put = async (
          key: string,
          content: string,
          opts: { role: 'user' | 'assistant'; askKey?: string; branchId?: string | null; file?: boolean }
        ) => {
          const id = `${topicId}-${key}`
          msgIds[key] = id
          const message: Record<string, unknown> = {
            id,
            topicId,
            role: opts.role,
            content,
            status: 'success',
            createdAt: stamp,
            updatedAt: stamp
          }
          if (opts.askKey) message.askId = msgIds[opts.askKey]
          const blocks: Record<string, unknown>[] = [
            { id: `${id}-main`, messageId: id, type: 'main_text', content, status: 'success', createdAt: stamp }
          ]
          if (opts.file) {
            blocks.push({
              id: `${id}-file`,
              messageId: id,
              type: 'file',
              content: null,
              status: 'success',
              createdAt: stamp,
              file: { id: missingFileId, name: missingFileName, path: `/tmp/${missingFileName}`, type: 'text/plain' }
            })
          }
          const req: Record<string, unknown> = { topicId, message, blocks }
          if (opts.branchId) req.branchId = opts.branchId
          const res = await api.appendMessage(req)
          if (!res || res.ok !== true) return `append ${key}: ${JSON.stringify(res)}`
          return null
        }

        let err: string | null
        err = await put('u1', 'td-u1', { role: 'user' })
        if (err) return { ok: false, err }
        err = await put('a1', 'td-a1', { role: 'assistant', askKey: 'u1' })
        if (err) return { ok: false, err }
        err = await put('u2', 'td-u2', { role: 'user', file: true })
        if (err) return { ok: false, err }

        const l1 = await api.createBranch({ topicId, anchorMessageId: msgIds.a1, name: 'L1' })
        if (!l1 || l1.ok !== true) return { ok: false, err: `createBranch L1 ${JSON.stringify(l1)}` }
        const branchL1 = (l1.value as any).branch.id as string
        err = await put('u3', 'td-u3', { role: 'user', branchId: branchL1 })
        if (err) return { ok: false, err }
        err = await put('a3', 'td-a3', { role: 'assistant', askKey: 'u3', branchId: branchL1 })
        if (err) return { ok: false, err }

        const l2 = await api.createBranch({ topicId, parentBranchId: branchL1, anchorMessageId: msgIds.u3, name: 'L2' })
        if (!l2 || l2.ok !== true) return { ok: false, err: `createBranch L2 ${JSON.stringify(l2)}` }
        const branchL2 = (l2.value as any).branch.id as string
        err = await put('u4', 'td-u4', { role: 'user', branchId: branchL2 })
        if (err) return { ok: false, err }

        const s1 = await api.createBranch({ topicId, anchorMessageId: msgIds.a1, name: 'S1' })
        if (!s1 || s1.ok !== true) return { ok: false, err: `createBranch S1 ${JSON.stringify(s1)}` }
        const branchS1 = (s1.value as any).branch.id as string
        err = await put('u5', 'td-u5', { role: 'user', branchId: branchS1 })
        if (err) return { ok: false, err }

        const seg = await api.upsertSegment({
          segmentId: `${topicId}-seg`,
          topicId,
          name: 'TD Seg',
          messageIds: [msgIds.u1, msgIds.a1]
        })
        if (!seg || seg.ok !== true) return { ok: false, err: `upsertSegment ${JSON.stringify(seg)}` }
        return { ok: true, msgIds, branchL1, branchL2, branchS1 }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId, topicName, stamp, missingFileId, missingFileName }
  )
  expect(seeded.ok, `seed failed: ${(seeded as any).err}`).toBe(true)
  return {
    topicId,
    assistantId,
    topicName,
    mainContents,
    branchContents,
    segmentContents,
    missingFileId,
    missingFileName
  }
}

async function activateTopic(page: any, topicId: string): Promise<void> {
  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await item.waitFor({ state: 'attached', timeout: 15000 })
  await item.scrollIntoViewIfNeeded()
  await item.waitFor({ state: 'visible', timeout: 15000 })
  await item.click()
  await page.waitForFunction(
    (id: string) => {
      const s = (window as any).store.getState()
      const active = s.assistants.assistants.flatMap((a: any) => a.topics).find((t: any) => t.id === id)
      return Boolean(active)
    },
    topicId,
    { timeout: 15000 }
  )
}

async function getTopicIds(page: any): Promise<string[]> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    return s.assistants.assistants.flatMap((a: any) => (a.topics || []).map((t: any) => t.id)) as string[]
  })
}

// ---------------------------------------------------------------------------
// MAIN-side native dialog interception (real file.save / file.open paths).
// The renderer `window.api.file.*` surface is never mocked; only the Electron
// MAIN `dialog` module is intercepted so the real Main filesystem
// read/write runs. Counters prove the real dialog -> Main chain was hit.
// ---------------------------------------------------------------------------

async function installMainSaveFile(electronApp: any, filePath: string): Promise<void> {
  await electronApp.evaluate(({ dialog }: typeof import('electron'), target: string) => {
    const d = dialog as any
    if (!d.__e2eTopicDataOrigSave) d.__e2eTopicDataOrigSave = d.showSaveDialog.bind(d)
    d.__e2eTopicSaveCalls = 0
    d.__e2eTopicSavePath = target
    d.showSaveDialog = async () => {
      d.__e2eTopicSaveCalls += 1
      return { canceled: false, filePath: d.__e2eTopicSavePath }
    }
  }, filePath)
}

async function installMainSaveCancel(electronApp: any): Promise<void> {
  await electronApp.evaluate(({ dialog }: typeof import('electron')) => {
    const d = dialog as any
    if (!d.__e2eTopicDataOrigSave) d.__e2eTopicDataOrigSave = d.showSaveDialog.bind(d)
    d.__e2eTopicSaveCalls = 0
    d.showSaveDialog = async () => {
      d.__e2eTopicSaveCalls += 1
      return { canceled: true, filePath: '' }
    }
  })
}

async function installMainOpenFiles(electronApp: any, filePaths: string[] | null): Promise<void> {
  await electronApp.evaluate(({ dialog }: typeof import('electron'), paths: string[] | null) => {
    const d = dialog as any
    if (!d.__e2eTopicDataOrigOpen) d.__e2eTopicDataOrigOpen = d.showOpenDialog.bind(d)
    d.__e2eTopicOpenCalls = 0
    d.__e2eTopicOpenPaths = paths
    d.showOpenDialog = async () => {
      d.__e2eTopicOpenCalls += 1
      if (!d.__e2eTopicOpenPaths) return { canceled: true, filePaths: [] }
      return { canceled: false, filePaths: [...d.__e2eTopicOpenPaths] }
    }
  }, filePaths)
}

async function mainDialogCalls(electronApp: any): Promise<{ save: number; open: number }> {
  return electronApp.evaluate(({ dialog }: typeof import('electron')) => {
    const d = dialog as any
    return {
      save: (d.__e2eTopicSaveCalls ?? 0) as number,
      open: (d.__e2eTopicOpenCalls ?? 0) as number
    }
  })
}

async function restoreMainDialogs(electronApp: any): Promise<void> {
  await electronApp.evaluate(({ dialog }: typeof import('electron')) => {
    const d = dialog as any
    if (d.__e2eTopicDataOrigSave) {
      d.showSaveDialog = d.__e2eTopicDataOrigSave
      delete d.__e2eTopicDataOrigSave
    }
    if (d.__e2eTopicDataOrigOpen) {
      d.showOpenDialog = d.__e2eTopicDataOrigOpen
      delete d.__e2eTopicDataOrigOpen
    }
  })
}

async function dismissTopicMenus(page: any): Promise<void> {
  // Ant keeps hidden menu DOM alive (no destroy): dismiss oracle must assert
  // zero VISIBLE menus, never zero DOM nodes.
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

function topicRootMenu(page: any): any {
  // Unambiguous root: only the root menu hosts the Export submenu title;
  // Export-child popups hold JSON/Markdown leaves, never the Export parent.
  return page
    .locator('.ant-dropdown-menu')
    .filter({ has: page.locator('.ant-dropdown-menu-submenu-title', { hasText: /^(导出|Export)$/ }) })
}

async function openTopicContextMenu(page: any, topicId: string): Promise<void> {
  await dismissTopicMenus(page)
  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await item.scrollIntoViewIfNeeded()
  await item.click({ button: 'right' })
  const root = topicRootMenu(page)
  await expect(root).toHaveCount(1, { timeout: 10000 })
  await expect(root.first()).toBeVisible({ timeout: 10000 })
}

async function clickExportJsonMenuItem(page: any): Promise<void> {
  const root = topicRootMenu(page)
  await expect(root).toHaveCount(1, { timeout: 10000 })
  // Target the actual submenu title hit-area with exact text in the root.
  // The wrapping `li.ant-dropdown-menu-submenu` hover is an unreliable
  // hit-area; the title node is the real Ant hover/focus target.
  const exportTitle = root.locator('.ant-dropdown-menu-submenu-title', { hasText: /^(导出|Export)$/ }).first()
  await exportTitle.waitFor({ state: 'visible', timeout: 10000 })
  await exportTitle.hover()
  // Reliable user gesture following Ant semantics: focus the Export title
  // then ArrowRight opens the submenu without forced DOM/evaluate bypass.
  try {
    await exportTitle.focus()
  } catch {}
  await page.keyboard.press('ArrowRight')
  // Latest source label only: `导出为 JSON` / `Export as JSON` (no icon).
  // Single Export popup holds exactly one JSON leaf, so .first() is exact.
  const jsonItem = page.getByRole('menuitem', { name: /^(导出为 JSON|Export as JSON)$/ }).first()
  await jsonItem.waitFor({ state: 'visible', timeout: 10000 })
  await jsonItem.click()
}

async function clickHeaderImport(page: any): Promise<void> {
  const btn = page.getByTestId('topic-import-btn')
  await btn.waitFor({ state: 'visible', timeout: 10000 })
  await btn.click()
}

async function waitForNewActiveTopic(page: any, knownIds: string[], timeout = 30000): Promise<string> {
  await page.waitForFunction(
    (known: string[]) => {
      const s = (window as any).store.getState()
      const ids = s.assistants.assistants.flatMap((a: any) => (a.topics || []).map((t: any) => t.id)) as string[]
      return ids.some((id) => !known.includes(id))
    },
    knownIds,
    { timeout }
  )
  return page.evaluate((known: string[]) => {
    const s = (window as any).store.getState()
    const ids = s.assistants.assistants.flatMap((a: any) => (a.topics || []).map((t: any) => t.id)) as string[]
    return ids.find((id) => !known.includes(id)) as string
  }, knownIds)
}

/** Main-authority snapshot of a topic's exported entity ids (fresh IDs after import). */
async function snapshotEntityIds(
  page: any,
  topicId: string
): Promise<{ messages: string[]; blocks: string[]; branches: string[]; segments: string[]; refs: string[] }> {
  return page.evaluate(async (id: string) => {
    const api = (window as any).api.chatDb
    const exp = await api.exportTopicData({ topicId: id })
    if (!exp || exp.ok !== true) throw new Error(`exportTopicData failed ${JSON.stringify(exp)}`)
    const payload = exp.value.payload
    const branches = await api.listBranches({ topicId: id })
    const segments = await api.listSegments({ topicId: id })
    return {
      messages: (payload.messages as any[]).map((m) => m.id),
      blocks: (payload.blocks as any[]).map((b) => b.id),
      branches: ((branches?.value?.branches ?? []) as any[]).map((b) => b.id),
      segments: ((segments?.value ?? []) as any[]).map((s) => s.id),
      refs: (payload.fileReferences as any[]).map((r) => r.id)
    }
  }, topicId)
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('topic-data JSON exchange', () => {
  test.setTimeout(240000)

  test('T1 export menu contract + header position + real Main save verifies branches/segments/refs/order', async ({
    electronApp,
    mainWindow,
    ownedTmpRoot
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'T1 INTEGRATED: real topic-item Export submenu json entry (Export as JSON) + real header position (import icon left of Manage) + real Export click through MAIN dialog.showSaveDialog interception with the real window.api.file.save -> Main filesystem write; owned file verified to exist on disk and parse, payload bytes verified against the Main authority oracle.'
    })
    const page = mainWindow
    const seed = await seedRichTopic(page)
    await activateTopic(page, seed.topicId)

    await test.step('header import icon sits directly left of Manage', async () => {
      const importBtn = page.getByTestId('topic-import-btn')
      await expect(importBtn).toBeVisible({ timeout: 10000 })
      await expect(importBtn).toHaveAttribute('aria-label', /^(从 JSON 导入话题|Import topic from JSON)$/)
      const manageBtn = page.getByTestId('topic-manage-btn')
      await expect(manageBtn).toBeVisible({ timeout: 10000 })
      const order = await page.evaluate(() => {
        const importEl = document.querySelector('[data-testid="topic-import-btn"]') as HTMLElement | null
        const manageEl = document.querySelector('[data-testid="topic-manage-btn"]') as HTMLElement | null
        if (!importEl || !manageEl) return null
        const sameTab = importEl.closest('.topics-tab') === manageEl.closest('.topics-tab')
        // Bit 4 (DOCUMENT_POSITION_FOLLOWING): manage follows import in DOM.
        const precedes = Boolean(importEl.compareDocumentPosition(manageEl) & 4)
        const importRect = importEl.getBoundingClientRect()
        const manageRect = manageEl.getBoundingClientRect()
        return {
          sameTab,
          precedes,
          importRight: importRect.right,
          manageLeft: manageRect.left,
          verticalOverlap: !(importRect.bottom < manageRect.top || manageRect.bottom < importRect.top)
        }
      })
      expect(order, 'import + manage header buttons must both exist in the topics tab').toBeTruthy()
      expect(order!.sameTab).toBe(true)
      expect(order!.precedes).toBe(true)
      expect(order!.importRight).toBeLessThanOrEqual(order!.manageLeft)
      expect(order!.verticalOverlap).toBe(true)
      console.log('[E2E] T1 header order ok (import directly left of Manage)')
    })

    let payload: any
    const outFile = path.join(ownedTmpRoot, 'topic-data-export.json')
    await test.step('Export submenu JSON + markdown contract then immediate real JSON click writes owned file', async () => {
      if (fs.existsSync(outFile)) fs.rmSync(outFile)
      await installMainSaveFile(electronApp, outFile)
      // Single opening: assert JSON + Markdown, then immediately click the
      // real JSON leaf using the already-opened submenu (no dismiss/reopen).
      await openTopicContextMenu(page, seed.topicId)
      const root = topicRootMenu(page)
      await expect(root).toHaveCount(1, { timeout: 10000 })
      const exportTitle = root.locator('.ant-dropdown-menu-submenu-title', { hasText: /^(导出|Export)$/ }).first()
      await exportTitle.waitFor({ state: 'visible', timeout: 10000 })
      await exportTitle.hover()
      try {
        await exportTitle.focus()
      } catch {}
      await page.keyboard.press('ArrowRight')
      const jsonLeaf = page.getByRole('menuitem', { name: /^(导出为 JSON|Export as JSON)$/ }).first()
      await expect(jsonLeaf).toBeVisible({ timeout: 10000 })
      // R04 regression pin: the pre-existing markdown entry still renders.
      await expect(page.getByRole('menuitem', { name: /^(导出为 Markdown|Export as markdown)$/ }).first()).toBeVisible({
        timeout: 10000
      })
      await jsonLeaf.click()
      await expect(page.locator('.ant-message')).toContainText(/(话题数据已导出|Topic data exported)/, {
        timeout: 15000
      })
      // The real Main write must have produced the file — never a helper
      // write of captured bytes. Poll for the filesystem side effect, then
      // read the real bytes back from disk.
      await expect.poll(() => fs.existsSync(outFile), { timeout: 15000 }).toBe(true)
      const calls = await mainDialogCalls(electronApp)
      expect(calls.save, 'MAIN showSaveDialog must have served the export').toBeGreaterThanOrEqual(1)
      const bytes = fs.readFileSync(outFile, 'utf-8')
      expect(bytes.length).toBeGreaterThan(0)
      payload = JSON.parse(bytes)
      console.log(`[E2E] T1 real Main file ok file=${outFile} len=${bytes.length}`)
    })

    await test.step('file bytes hold all owned branches/segments/refs in order', async () => {
      expect(payload.format).toBe('cherry-chat-topic-data')
      expect(payload.version).toBe(1)
      expect(payload.messages).toHaveLength(7)
      // Main_text blocks (7) + the dangling file block (1).
      expect(payload.blocks).toHaveLength(8)
      expect(payload.branches).toHaveLength(3)
      expect(payload.segments).toHaveLength(1)
      expect(payload.fileReferences).toHaveLength(1)

      const byId = new Map((payload.messages as any[]).map((m: any) => [m.id, m]))
      const mainMsgs = (payload.messages as any[]).filter((m: any) => m.branchId === null)
      expect(mainMsgs.map((m: any) => m.content)).toEqual(seed.mainContents)
      const branchByName = new Map((payload.branches as any[]).map((b: any) => [b.name, b]))
      const l1 = branchByName.get('L1') as any
      const l2 = branchByName.get('L2') as any
      const s1 = branchByName.get('S1') as any
      expect(l1 && l2 && s1).toBeTruthy()
      // Sibling + nested structure: L1/S1 fork main, L2 nests under L1.
      expect(l1.parentBranchId).toBeNull()
      expect(s1.parentBranchId).toBeNull()
      expect(l2.parentBranchId).toBe(l1.id)
      const contentOf = (id: string): string => (byId.get(id) as any)?.content
      expect(contentOf(l1.anchorMessageId)).toBe('td-a1')
      expect(contentOf(s1.anchorMessageId)).toBe('td-a1')
      expect(contentOf(l2.anchorMessageId)).toBe('td-u3')
      const forBranch = (branchId: string): string[] =>
        (payload.messages as any[]).filter((m: any) => m.branchId === branchId).map((m: any) => m.content)
      expect(forBranch(l1.id)).toEqual(seed.branchContents.L1)
      expect(forBranch(l2.id)).toEqual(seed.branchContents.L2)
      expect(forBranch(s1.id)).toEqual(seed.branchContents.S1)

      // askId relationship survives the export.
      const a1 = mainMsgs.find((m: any) => m.content === 'td-a1') as any
      const u1 = mainMsgs.find((m: any) => m.content === 'td-u1') as any
      expect(a1.askId).toBe(u1.id)

      // Segment membership order preserved.
      expect(payload.segments[0].messageIds.map((id: string) => contentOf(id))).toEqual(seed.segmentContents)

      // Missing-attachment metadata preserved verbatim (no payload copy, no
      // availability markers added or expected).
      const ref = payload.fileReferences[0] as any
      expect(ref.fileId).toBe(seed.missingFileId)
      expect(ref.fileName).toBe(seed.missingFileName)
      expect(Object.keys(ref).some((k) => /avail|missing|repair/i.test(k))).toBe(false)
      const refBlock = (payload.blocks as any[]).find((b: any) => b.id === ref.blockId) as any
      expect(refBlock).toBeTruthy()
      expect(contentOf(refBlock.messageId)).toBe('td-u2')
      expect(refBlock.type).toBe('file')

      // Export strips identity/scope keys: no topic/assistant binding columns
      // leak. Entity `id` values and the seeded topic name legitimately embed
      // the seed prefix (`${topicId}-u1`, `Topic Data ${topicId}`), so a raw
      // substring check on seed.topicId is invalid; assert stripped KEYS plus
      // the assistant binding value instead (production strips id /
      // assistantId / deletedAt / topicId columns, never opaque id content).
      expect(payload.topic.id).toBeUndefined()
      expect(payload.topic.assistantId).toBeUndefined()
      expect(payload.topic.deletedAt).toBeUndefined()
      for (const m of payload.messages as any[]) {
        expect(m.topicId).toBeUndefined()
        expect(m.assistantId).toBeUndefined()
      }
      for (const s of payload.segments as any[]) {
        expect(s.topicId).toBeUndefined()
      }
      const serialized = JSON.stringify(payload)
      expect(serialized).not.toContain(seed.assistantId)
      console.log('[E2E] T1 payload shape ok (7 msgs / 8 blocks / 3 branches / 1 seg / 1 ref)')
    })

    await test.step('Main oracle matches the real file (snapshot never publishes)', async () => {
      const oracle = await page.evaluate(async (id: string) => {
        const exp = await (window as any).api.chatDb.exportTopicData({ topicId: id })
        return exp
      }, seed.topicId)
      expect(oracle.ok).toBe(true)
      const value = oracle.value.payload
      expect(value.messages).toEqual(payload.messages)
      expect(value.blocks).toEqual(payload.blocks)
      expect(value.branches).toEqual(payload.branches)
      expect(value.segments).toEqual(payload.segments)
      expect(value.fileReferences).toEqual(payload.fileReferences)
      await restoreMainDialogs(electronApp)
    })
  })

  test('T2 header imports twice stay disjoint, rebind to the current assistant, and survive relaunch', async ({
    electronApp,
    mainWindow,
    ownedTmpRoot,
    mockPort,
    userDataDir
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'T2 INTEGRATED: real header import-icon clicks with MAIN dialog.showOpenDialog stub serving the same owned JSON file twice through the real window.api.file.open -> Main filesystem read; distinct topic/entity IDs, preserved refs/relationships, current-assistant rebinding, missing-file metadata verbatim; both topics survive a same-profile relaunch with Main + SQLite oracles.'
    })
    const page = mainWindow
    const seed = await seedRichTopic(page)
    await activateTopic(page, seed.topicId)
    const knownBefore = await getTopicIds(page)

    const sourcePayloadText = await page.evaluate(async (id: string) => {
      const exp = await (window as any).api.chatDb.exportTopicData({ topicId: id })
      if (!exp || exp.ok !== true) throw new Error(`export oracle failed ${JSON.stringify(exp)}`)
      return JSON.stringify(exp.value.payload)
    }, seed.topicId)
    const sourcePayload = JSON.parse(sourcePayloadText)

    // Owned import fixture: the MAIN open stub serves this exact file, and
    // the real Main `file.open` reads it from disk (no renderer mock, no
    // payload injection).
    const importFile = path.join(ownedTmpRoot, 'topic-data-import.json')
    fs.writeFileSync(importFile, sourcePayloadText, 'utf-8')
    await installMainOpenFiles(electronApp, [importFile])

    await test.step('first header import creates a rebound duplicate', async () => {
      await clickHeaderImport(page)
      await expect(page.locator('.ant-message')).toContainText(/(话题已导入|Topic imported)/, { timeout: 15000 })
      const calls = await mainDialogCalls(electronApp)
      expect(calls.open, 'MAIN showOpenDialog must have served the first import').toBeGreaterThanOrEqual(1)
    })
    const firstId = await waitForNewActiveTopic(page, knownBefore)
    expect(firstId).not.toBe(seed.topicId)

    let secondId: string
    await test.step('second header import duplicates again with fully disjoint IDs', async () => {
      const knownAfterFirst = await getTopicIds(page)
      expect(knownAfterFirst).toContain(firstId)
      await clickHeaderImport(page)
      await expect(page.locator('.ant-message')).toContainText(/(话题已导入|Topic imported)/, { timeout: 15000 })
      secondId = await waitForNewActiveTopic(page, knownAfterFirst)
      expect(secondId).not.toBe(seed.topicId)
      expect(secondId).not.toBe(firstId)

      const first = await snapshotEntityIds(page, firstId)
      const second = await snapshotEntityIds(page, secondId)
      for (const key of ['messages', 'blocks', 'branches', 'segments', 'refs'] as const) {
        expect(first[key]).toHaveLength(second[key].length)
        expect(new Set([...first[key], ...second[key]]).size).toBe(first[key].length * 2)
      }
      // Neither import reuses source IDs.
      const sourceIds = new Set([
        ...(sourcePayload.messages as any[]).map((m: any) => m.id),
        ...(sourcePayload.blocks as any[]).map((b: any) => b.id),
        ...(sourcePayload.branches as any[]).map((b: any) => b.id),
        ...(sourcePayload.segments as any[]).map((s: any) => s.id)
      ])
      for (const id of [...first.messages, ...second.messages]) expect(sourceIds.has(id)).toBe(false)
      console.log(`[E2E] T2 disjoint ok first=${firstId} second=${secondId}`)
    })

    await test.step('refs/relationships rebound to the current assistant with metadata verbatim', async () => {
      const check = await page.evaluate(
        async ({ topicId, assistantId }: { topicId: string; assistantId: string }) => {
          const api = (window as any).api.chatDb
          const exp = await api.exportTopicData({ topicId })
          if (!exp || exp.ok !== true) throw new Error(`export failed ${JSON.stringify(exp)}`)
          const payload = exp.value.payload
          const byContent = new Map((payload.messages as any[]).map((m: any) => [m.content, m]))
          const branchByName = new Map((payload.branches as any[]).map((b: any) => [b.name, b]))
          const contentOf = (id: string): string | null => {
            const m = (payload.messages as any[]).find((x: any) => x.id === id)
            return m ? m.content : null
          }
          return {
            messageCount: payload.messages.length,
            blockCount: payload.blocks.length,
            branchCount: payload.branches.length,
            segmentCount: payload.segments.length,
            refCount: payload.fileReferences.length,
            askOk: (byContent.get('td-a1') as any)?.askId === (byContent.get('td-u1') as any)?.id,
            askBranchOk: (byContent.get('td-a3') as any)?.askId === (byContent.get('td-u3') as any)?.id,
            l1Parent: branchByName.has('L1') ? (branchByName.get('L1') as any)?.parentBranchId : 'missing-branch',
            l2Parent: branchByName.has('L2') ? (branchByName.get('L2') as any)?.parentBranchId : 'missing-branch',
            s1Parent: branchByName.has('S1') ? (branchByName.get('S1') as any)?.parentBranchId : 'missing-branch',
            l2Anchor: contentOf((branchByName.get('L2') as any)?.anchorMessageId),
            l1Anchor: contentOf((branchByName.get('L1') as any)?.anchorMessageId),
            segOrder: ((payload.segments as any[])[0]?.messageIds as string[]).map(contentOf),
            ref: (payload.fileReferences as any[])[0] ?? null,
            refKeys: Object.keys(((payload.fileReferences as any[])[0] ?? {}) as Record<string, unknown>),
            assistantOk: (payload.messages as any[]).every(() => true),
            liveAssistant: assistantId
          }
        },
        { topicId: firstId, assistantId: seed.assistantId }
      )
      expect(check.messageCount).toBe(7)
      expect(check.blockCount).toBe(8)
      expect(check.branchCount).toBe(3)
      expect(check.segmentCount).toBe(1)
      expect(check.refCount).toBe(1)
      expect(check.askOk).toBe(true)
      expect(check.askBranchOk).toBe(true)
      expect(check.l1Parent).toBeNull()
      expect(check.s1Parent).toBeNull()
      expect(check.l2Parent).not.toBeNull()
      expect(check.l1Anchor).toBe('td-a1')
      expect(check.l2Anchor).toBe('td-u3')
      expect(check.segOrder).toEqual(seed.segmentContents)
      expect(check.ref.fileId).toBe(seed.missingFileId)
      expect(check.ref.fileName).toBe(seed.missingFileName)
      expect(check.refKeys.some((k: string) => /avail|missing|repair/i.test(k))).toBe(false)

      // Current-assistant rebinding: both imports live under the live assistant
      // in Redux and in SQLite (no source-assistant leakage).
      const owners = await page.evaluate(
        ({ first, second }: { first: string; second: string }) => {
          const s = (window as any).store.getState()
          const ownerOf = (id: string): string => {
            const a = s.assistants.assistants.find((x: any) => (x.topics || []).some((t: any) => t.id === id))
            return a ? a.id : ''
          }
          return { first: ownerOf(first), second: ownerOf(second) }
        },
        { first: firstId, second: secondId }
      )
      expect(owners.first).toBe(seed.assistantId)
      expect(owners.second).toBe(seed.assistantId)
      const dbPath = getChatDbPath()
      expect(dbPath).not.toBeNull()
      const rows = queryRows(
        dbPath!,
        `SELECT id, assistant_id FROM topics WHERE id IN ('${esc(firstId)}', '${esc(secondId)}')`
      )
      expect(rows).toHaveLength(2)
      for (const row of rows) expect(row.assistant_id).toBe(seed.assistantId)
      console.log('[E2E] T2 rebinding ok (both imports under the live assistant)')
    })

    await test.step('imported missing-file topic renders with existing behavior (no repair claims)', async () => {
      await activateTopic(page, firstId)
      await expect(page.locator('#messages')).toContainText('td-u1', { timeout: 15000 })
      await expect(page.locator('#messages')).toContainText('td-u2', { timeout: 15000 })
    })

    await test.step('same-profile relaunch keeps both imports with Main authority intact', async () => {
      await restoreMainDialogs(electronApp)
      await electronApp.close()
      const relaunched = await relaunchSameProfile({ userDataDir, ownedTmpRoot, mockPort })
      try {
        const page2 = relaunched.page
        await waitForAppReady(page2)
        const ids = await page2.evaluate(() => {
          const s = (window as any).store.getState()
          return s.assistants.assistants.flatMap((a: any) => (a.topics || []).map((t: any) => t.id)) as string[]
        })
        expect(ids).toContain(seed.topicId)
        expect(ids).toContain(firstId)
        expect(ids).toContain(secondId)
        for (const id of [firstId, secondId]) {
          const exp = await page2.evaluate(async (topicId: string) => {
            return await (window as any).api.chatDb.exportTopicData({ topicId })
          }, id)
          expect(exp.ok, `post-relaunch export must succeed for ${id}`).toBe(true)
          expect(exp.value.payload.messages as any[]).toHaveLength(7)
          expect(exp.value.payload.branches as any[]).toHaveLength(3)
          expect((exp.value.payload.fileReferences as any[])[0]?.fileId).toBe(seed.missingFileId)
        }
        console.log('[E2E] T2 relaunch ok (source + both imports persist)')
      } finally {
        await closeElectronWithExactCleanup(userDataDir, {
          close: () => relaunched.app.close(),
          findExactProcesses: findProcessesByUserDataDir,
          terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
        })
      }
    })
  })

  test('T3 canceled dialogs stay silent with no mutation; bad payloads error with no extra topic', async ({
    electronApp,
    mainWindow,
    ownedTmpRoot
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'T3 INTEGRATED: real Export-as-JSON with a canceling MAIN save stub and real header imports with canceling/malformed/unsupported/version-tampered MAIN open stubs serving owned files through the real window.api.file.open read; silent cancels, localized error toasts, and exact topic-count stability.'
    })
    const page = mainWindow
    const seed = await seedRichTopic(page)
    await activateTopic(page, seed.topicId)

    const countTopics = async (): Promise<number> => (await getTopicIds(page)).length
    const before = await countTopics()

    await test.step('canceled save dialog stays silent and mutates nothing', async () => {
      await installMainSaveCancel(electronApp)
      await openTopicContextMenu(page, seed.topicId)
      await clickExportJsonMenuItem(page)
      await page.waitForTimeout(1200)
      // Silent cancel: no export-error toast appears. The toast container may
      // not exist at all, so assert zero failure-text toasts (not.toContainText
      // requires the container to exist and times out on absence).
      await expect(
        page.locator('.ant-message', { hasText: /(导出话题数据失败|Failed to export topic data)/ })
      ).toHaveCount(0)
      expect(await countTopics()).toBe(before)
      const calls = await mainDialogCalls(electronApp)
      expect(calls.save, 'MAIN showSaveDialog must have served the cancel').toBeGreaterThanOrEqual(1)
      const dbPath = getChatDbPath()
      expect(dbPath).not.toBeNull()
      expect(queryRows(dbPath!, `SELECT COUNT(*) AS n FROM topics`).map((r) => r.n)[0]).toBe(before)
      console.log('[E2E] T3 save-cancel silent ok')
    })

    await test.step('canceled open dialog stays silent and mutates nothing', async () => {
      await installMainOpenFiles(electronApp, null)
      await clickHeaderImport(page)
      await page.waitForTimeout(1200)
      // Silent cancel: no import toasts appear (container may be absent, so
      // assert zero failure-text toasts rather than not.toContainText).
      await expect(
        page.locator('.ant-message', { hasText: /(无效的话题数据文件|Invalid topic data file)/ })
      ).toHaveCount(0)
      await expect(
        page.locator('.ant-message', { hasText: /(导入话题文件失败|Failed to import topic file)/ })
      ).toHaveCount(0)
      expect(await countTopics()).toBe(before)
      console.log('[E2E] T3 open-cancel silent ok')
    })

    const serveTextAsOwnedFile = async (fileName: string, text: string): Promise<void> => {
      const filePath = path.join(ownedTmpRoot, fileName)
      fs.writeFileSync(filePath, text, 'utf-8')
      await installMainOpenFiles(electronApp, [filePath])
    }

    await test.step('malformed JSON errors with no extra topic', async () => {
      await serveTextAsOwnedFile('topic-data-malformed.json', 'not-json{{{')
      await clickHeaderImport(page)
      await expect(page.locator('.ant-message')).toContainText(/(无效的话题数据文件|Invalid topic data file)/, {
        timeout: 15000
      })
      expect(await countTopics()).toBe(before)
    })

    await test.step('unsupported format marker errors with no extra topic', async () => {
      await serveTextAsOwnedFile('topic-data-other-format.json', JSON.stringify({ format: 'other-format', version: 1 }))
      await clickHeaderImport(page)
      await expect(page.locator('.ant-message')).toContainText(/(无效的话题数据文件|Invalid topic data file)/, {
        timeout: 15000
      })
      expect(await countTopics()).toBe(before)
    })

    await test.step('unsupported version + Main rejection error with no extra topic', async () => {
      const oracle = await page.evaluate(async (id: string) => {
        const exp = await (window as any).api.chatDb.exportTopicData({ topicId: id })
        return JSON.stringify(exp.value.payload)
      }, seed.topicId)
      const parsed = JSON.parse(oracle)
      // Renderer passes the format marker but Main rejects the version.
      await serveTextAsOwnedFile('topic-data-bad-version.json', JSON.stringify({ ...parsed, version: 2 }))
      await clickHeaderImport(page)
      await expect(page.locator('.ant-message')).toContainText(
        /(无效的话题数据文件|Invalid topic data file|导入话题文件失败|Failed to import topic file)/,
        { timeout: 15000 }
      )
      expect(await countTopics()).toBe(before)

      // One representative Main deep-validation rejection (duplicated message
      // id); the exhaustive matrix stays in unit tests.
      const tampered = JSON.parse(oracle)
      tampered.messages = [...tampered.messages, { ...tampered.messages[0] }]
      await serveTextAsOwnedFile('topic-data-duplicate-id.json', JSON.stringify(tampered))
      await clickHeaderImport(page)
      await expect(page.locator('.ant-message')).toContainText(/(导入话题文件失败|Failed to import topic file)/, {
        timeout: 15000
      })
      expect(await countTopics()).toBe(before)
      const dbPath = getChatDbPath()
      expect(dbPath).not.toBeNull()
      expect(queryRows(dbPath!, `SELECT COUNT(*) AS n FROM topics`).map((r) => r.n)[0]).toBe(before)
      await restoreMainDialogs(electronApp)
      console.log('[E2E] T3 bad-payload errors ok (no extra topic)')
    })
  })
})
