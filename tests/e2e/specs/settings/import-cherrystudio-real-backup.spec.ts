/**
 * E2E (opt-in, privacy-safe): L2 Cherry Studio REAL-backup import harness.
 *
 * Collects real-artifact evidence that the production selective-extraction
 * import pipeline accepts a large user-provided backup ZIP, imports the
 * selected IndexedDB / Local Storage subset, promotes SQLite with integrity
 * and FK guarantees, never materializes the ignored `Data/` subtree, cleans
 * up exactly, and leaves the source ZIP byte-identical.
 *
 * Opt-in only: the spec is SKIPPED unless `CHERRY_E2E_REAL_ZIP` is set to the
 * absolute path of a real Cherry Studio backup ZIP. The path is read from the
 * environment ONCE, is never hardcoded, never printed, and never enters any
 * report/log; the run command is the only place it appears.
 *
 * Privacy contract (LOCK-REAL1/2/5):
 * - Zero user content, assistant/topic IDs/names, file paths, or message text
 *   in logs, matcher messages, or reports — only aggregate counts, booleans,
 *   durations, and an 8-hex SHA-256 prefix (house docs style precedent:
 *   `docs/sqlite-migration.md` hash prefixes).
 * - Assertions are aggregate: candidate counts from status events; after the
 *   projection apply the synthetic pre-import marker is gone, assistant/topic
 *   counts are coherent, at least one imported active topic is visible and
 *   clickable with historical message/block PRESENCE (no content returned),
 *   and the one-shot projection is durably acked (absent). After close a
 *   single fixed batched readonly verification plan (LOCK-QDB-3) proves the
 *   SQLite counts equal the candidate stats, `integrity_check` is exactly
 *   one-row ok and `foreign_key_check` is exactly empty, and the exact
 *   `deletedTopics` sibling (LOCK-QDB-17/18) reconciles the navigation
 *   active/total algebra from the SAME readonly snapshot, with bounded
 *   transient retry (LOCK-QDB-4) replacing any fixed sleep-as-evidence.
 * - Playwright trace/screenshot/video are disabled for this spec; errors are
 *   wrapped so no source path can surface.
 *
 * Source immutability (LOCK-REAL3):
 * - The source ZIP is only ever READ. SHA-256, size, mtime, inode and mode
 *   are captured before the import and again in `finally` (even on failure)
 *   and compared for exact equality. No copy/hardlink/symlink/rename/chmod/
 *   touch/delete is performed on the source.
 *
 * `Data/` non-materialization (LOCK-REAL6):
 * - Only OWNED workspaces are inspected: the owned temp root (`cherry-import-*`
 *   extraction workspaces + the root itself) and the disposable candidate
 *   workspace under the app Data root. A top-level `Data` entry is asserted
 *   absent there. The app's own `Data` root is the production target and is
 *   deliberately NOT scanned for this.
 *
 * Platform: macOS-only (production A-9 gate). Skipped clearly otherwise.
 *
 * Prerequisite (owned by the main validation phase): a fresh production build
 * including the chatImport window entry, the LOCK-PROD-7 in-process reload and
 * the navigation projection apply; better-sqlite3 rebuilt for the Electron
 * ABI so `queryChatDbViaElectron` (post-close file reads) loads the native
 * module under the Electron binary.
 */
import { createHash } from 'node:crypto'
import * as fs from 'fs'
import * as path from 'path'

import {
  expect,
  getChatDbPath,
  getRuntimeAppDataPath,
  test,
  verifyChatDbViaElectronWithRetry
} from '../../fixtures/electron.fixture'
import type { VerificationTable } from '../../utils/query-chat-db-electron'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import {
  assertOnlyEmptyPromotedCandidateShells,
  type CandidateInventory,
  listCandidateTempWorkspaces,
  snapshotCandidateInventory
} from '../../utils/import-artifact-validation'
import { assertStateSubsequence, observeImportStatuses, REQUIRED_STATE_CHAIN } from '../../utils/import-status'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { redactPathText, redactSourcePath } from '../../utils/redact-path'
import { assertRetainedSnapshotFile } from '../../utils/snapshot-file'

/** Opt-in real-artifact gate (LOCK-REAL1). Never printed. */
const REAL_ZIP = process.env.CHERRY_E2E_REAL_ZIP ?? null

/** Fixed names produced by the promotion pipeline (Phase 4.4). */
const ROLLBACK_SNAPSHOT_FILENAME = 'chat.db.pre-import-backup'
const ROLLBACK_SNAPSHOT_STAGING_FILENAME = 'chat.db.pre-import-backup.staging'
const PROMOTION_JOURNAL_FILENAME = 'chat-import-promotion.journal.json'
const PROMOTION_JOURNAL_STAGING_FILENAME = 'chat-import-promotion.journal.json.staging'

/** Candidate directory leaf prefix under `Data/chat-import-candidates`. */
const CANDIDATE_DIR_PREFIX = 'candidate-'

/** Forbidden top-level materialized subtree (LOCK-REAL6). */
const IGNORED_DATA_ROOT_NAME = 'Data'

/** Deterministic synthetic pre-import marker (LOCK-REAL5: replace-all must remove it). */
const MARKER = { topic: 't-marker-real-e2e', name: 'Marker Topic' } as const

/**
 * Post-finalizing reload-marker timeout: after `finalizing`, the imported
 * full DB / Files / catalog re-verification and the in-process reload run at
 * real 1.3 GiB scale (thousands of files), which far exceeds the previous
 * fixed 180s budget. Bounded: this is a step-level wait budget only — the
 * test-level timeout stays 1_200_000 ms and no status wait, assertion,
 * privacy setting, or production code changes.
 */
const REAL_BACKUP_RELOAD_MARKER_TIMEOUT_MS = 360_000

// LOCK-REAL2: disable Playwright failure artifacts for this file — the real
// backup path must never leak into a trace/screenshot/video. `video` cannot
// be set inside a describe group (it forces a new worker), so it is file-
// scope; this file contains exactly one test.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test.describe('Cherry Studio real-backup import harness', () => {
  test.skip(!REAL_ZIP, 'skipped unless CHERRY_E2E_REAL_ZIP is set (opt-in real-artifact harness)')
  test.skip(process.platform !== 'darwin', 'L2 import is macOS-only (LOCK-623)')

  test('imports the user-provided real backup via selective extraction with aggregate-only assertions', async ({
    electronApp,
    mainWindow,
    userDataDir,
    ownedTmpRoot
  }) => {
    // Fixture launch + source hashing + real-archive import (extraction of
    // ~415 MiB selected inventory) + in-process reload + UI checks + close +
    // post-close data-plane evidence far exceed the 60s default.
    test.setTimeout(1200000)
    const page = mainWindow
    const zipPath = REAL_ZIP as string

    // --- 0. Original process identity + target chat.db location -----------
    const originalPid = electronApp.process().pid
    expect(originalPid, 'original target process pid must be defined').toBeTruthy()
    const originalPidValue = originalPid as number
    const chatDbPath = getChatDbPath()
    expect(chatDbPath, 'fixture must have captured the disposable chat.db path').toBeTruthy()
    const dataDir = path.dirname(chatDbPath!)

    // LOCK-REAL3: source immutable baseline — read-only, captured outside the
    // page (node-side fs). Only an 8-hex hash prefix is ever surfaced. Wrapped
    // so a filesystem error can never surface the source path.
    let sourceBefore: SourceFingerprint
    try {
      sourceBefore = await captureSourceFingerprint(zipPath)
    } catch (error) {
      throw redactSourcePath(error, zipPath)
    }
    console.log(
      `[E2E] real-backup source fingerprint baseline captured (sha256[:8]=${sourceBefore.sha256.slice(0, 8)})`
    )

    // LOCK-REAL6/LOCK-DEV-8: owned candidate/temp workspace inventory BEFORE
    // the import so non-materialization and cleanup are provable afterwards.
    const candidateInventoryBefore = snapshotCandidateInventory(dataDir, ownedTmpRoot)

    // Body + cleanup error capture (LOCK-C6: cleanup failure is a test
    // failure, never a warning; a body failure is preserved for diagnosis).
    let bodyFailure: unknown = null
    const cleanupErrors: string[] = []
    let observer: Awaited<ReturnType<typeof observeImportStatuses>> | null = null

    try {
      // ─────────────────────────────────────────────────────────────────────
      // 0. Reload detection marker + deterministic target marker (LOCK-REAL5)
      // ─────────────────────────────────────────────────────────────────────
      // The in-process reload (LOCK-PROD-7) resets the page context, so the
      // marker vanishing proves the reload ran (LOCK-UI1).
      await page.evaluate(() => {
        ;(window as any).__e2ePreImportMarker = true
      })
      // Synthetic marker topic in Redux (sidebar) AND SQLite — the replace-all
      // import must remove it from both planes.
      await createMarkerTopic(page, MARKER.topic, MARKER.name)
      expect(await topicExistsInRedux(page, MARKER.topic), 'marker must be in Redux before import').toBe(true)

      // --- 1. Production import chain (LOCK-REAL4) --------------------------
      const support = await page.evaluate(() => (window as any).api.cherryImport.getPlatformSupport())
      expect(support?.supported, 'production platform gate must report darwin support').toBe(true)

      observer = await observeImportStatuses(page)
      const startResult = await page.evaluate((zipPath) => (window as any).api.cherryImport.start(zipPath), zipPath)
      expect(startResult?.ok, `cherryImport.start failed: ${JSON.stringify(startResult)}`).toBe(true)
      expect(typeof startResult.sessionId).toBe('string')
      const sessionId = startResult.sessionId as string
      observer.setSessionId(sessionId)

      // --- 2. Candidate-ready: aggregate stats (LOCK-REAL5) -----------------
      // LOCK-OBS-1/6: the poll-only getStatus observation (state only, stats
      // null) must NOT satisfy this wait — it resolves only once the event
      // carrying CandidateImportStats lands (and enriches the poll record).
      const ready = await observer.waitForState('candidate-ready', 900000, (record) => record.stats != null)
      expect(ready?.stats, 'candidate-ready event must carry CandidateImportStats').toBeTruthy()
      const stats = ready?.stats as Record<string, unknown>
      assertCandidateStatsCoherent(stats)
      console.log(
        `[E2E] real-backup candidate stats (aggregate): ` +
          `topics=${String(stats.topicCount)} messages=${String(stats.messageCount)} ` +
          `blocks=${String(stats.blockCount)} segments=${String(stats.segmentCount)} ` +
          `memberships=${String(stats.segmentMembershipCount)} fileRefs=${String(stats.fileReferenceCount)} ` +
          `pages=${String(stats.pageCount)} elapsedMs=${String(stats.elapsedMs)}`
      )

      // --- 3. `Data/` non-materialization (LOCK-REAL6) ----------------------
      // At candidate-ready the extraction workspace exists with the selected
      // subtrees materialized; prove the ignored top-level `Data` subtree was
      // never written into any OWNED extraction/candidate/temp workspace.
      assertIgnoredDataSubtreesAbsent(candidateInventoryBefore, dataDir, ownedTmpRoot)

      // --- 4. Status progression THROUGH finalizing (LOCK-622 evidence a) ---
      const finalizing = await observer.waitForState('finalizing', 900000)
      expect(finalizing.state).toBe('finalizing')
      const observed = await observer.getStates()
      const stateNames = observed.map((s) => s.state)
      const chainError = assertStateSubsequence(stateNames, REQUIRED_STATE_CHAIN)
      expect(chainError, chainError ?? undefined).toBeNull()
      const promotedIndex = stateNames.indexOf('promoted')
      if (promotedIndex !== -1) {
        expect(promotedIndex).toBeGreaterThan(stateNames.indexOf('finalizing'))
      }
      console.log(`[E2E] Observed real-backup import states: ${stateNames.join(' -> ')}`)

      // --- 5. In-process reload — same PID stays alive (LOCK-REAL4) ---------
      expect(
        electronApp.process().pid,
        `original PID ${originalPidValue} must still be alive after finalizing (LOCK-UI1)`
      ).toBe(originalPidValue)
      await page.waitForFunction(() => (window as any).__e2ePreImportMarker !== true, {
        timeout: REAL_BACKUP_RELOAD_MARKER_TIMEOUT_MS
      })
      await waitForMainWindowReady(page)

      // LOCK-REAL5: the one-shot navigation projection must be durably applied
      // and acked — getProjection() returns no pending projection afterwards.
      await waitForProjectionAcked(page)
      // LOCK-PROD-6: the imported navigation (aggregate) must be present.
      await waitForImportedNavigationAggregate(page)

      expect(
        electronApp.process().pid,
        `original PID ${originalPidValue} must still be alive after the in-process reload (LOCK-UI1)`
      ).toBe(originalPidValue)
      console.log(`[E2E] In-process reload observed; original PID ${originalPidValue} stayed alive (LOCK-REAL4)`)

      // Detach the page-side observer (the collector was reset by the reload).
      await observer.stop()
      observer = null

      // --- 6. Post-import aggregate assertions (LOCK-REAL5) -----------------
      // Marker removed — Redux, UI, and SQLite planes.
      expect(await topicExistsInRedux(page, MARKER.topic), 'marker must be gone from Redux after replace-all').toBe(
        false
      )
      await expect(
        page.locator(`[data-testid="topic-item"][data-topic-id="${MARKER.topic}"]`),
        'marker must be gone from the sidebar'
      ).toHaveCount(0)
      const markerAfterSql = await page.evaluate(
        (topicId) => (window as any).api.chatDb.topicExists({ topicId }),
        MARKER.topic
      )
      expect(markerAfterSql?.value, 'marker must be gone from SQLite after replace-all').toBe(false)

      // Assistant/topic aggregate counts coherent.
      const nav = await readNavigationAggregate(page)
      assertNavigationAggregate(nav)
      console.log(
        `[E2E] real-backup post-import navigation aggregate: ` +
          `assistants=${nav.assistantCount} topics=${nav.topicCount} ` +
          `activeTopics=${nav.activeTopicCount} deletedTopics=${nav.deletedTopicCount}`
      )

      // At least one imported active topic is visible/clickable in the real UI
      // and carries historical message/block presence (no content returned).
      await assertImportedTopicVisibleAndClickable(page)

      // --- 7. Close the ENTIRE app (LOCK-625) --------------------------------
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => electronApp.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })

      // --- 8. Hard data-plane evidence (LOCK-REAL4/5) ------------------------
      // Post-close SQLite readonly aggregate counts equal the candidate stats,
      // integrity ok, foreign-key check empty, and the exact deletedTopics
      // sibling reconciles the navigation algebra. LOCK-QDB-3/17: ONE fixed
      // batched readonly child/connection/snapshot; LOCK-QDB-4: bounded
      // transient retry replaces any fixed sleep-as-evidence.
      await assertPostCloseSqlite(chatDbPath!, stats, nav)
      // Retained pre-import snapshot + journal/staging cleanup (4434/4436/4438).
      await assertRetainedPreImportSnapshot(dataDir)
      // Empty promoted candidate shells + tmpdir deferred-recovery contract.
      assertOnlyEmptyPromotedCandidateShells(candidateInventoryBefore, dataDir, ownedTmpRoot)
      // Re-check `Data/` non-materialization on whatever owned workspaces remain.
      assertIgnoredDataSubtreesAbsent(candidateInventoryBefore, dataDir, ownedTmpRoot)
    } catch (error) {
      bodyFailure = error
      // LOCK-REAL2: wrap so no source path can surface in the failure output.
      throw redactSourcePath(error, zipPath)
    } finally {
      // ─────────────────────────────────────────────────────────────────────
      // Cleanup (LOCK-REAL4, LOCK-C6/T1/T5) — always runs, even on failure.
      // ─────────────────────────────────────────────────────────────────────
      if (observer) {
        try {
          await observer.stop()
        } catch {
          // Page may already be gone — observer cleanup is best-effort.
        }
      }
      // Exact-token process sweep for the disposable profile, excluding the
      // fixture-owned original PID (defensive; normally nothing remains after
      // the body's exact close).
      try {
        const leftover = await terminateProcessesByUserDataDir(userDataDir, originalPidValue)
        if (leftover.remainingPids.length > 0) {
          cleanupErrors.push(`Processes remained after finally: ${leftover.remainingPids.join(', ')}`)
        }
        if (leftover.errors.length > 0) {
          cleanupErrors.push(`Process cleanup errors: ${leftover.errors.join('; ')}`)
        }
      } catch (err) {
        cleanupErrors.push(`finally process cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      // LOCK-DREAL2/3: bounded reading-stage failure diagnostics. Pure
      // allowlisted self-checks run on every teardown; the disposable-profile
      // log classifier runs ONLY when the body failed and emits exactly one
      // aggregate JSON — never raw lines/paths/IDs/names/content/stacks.
      try {
        assertFailureClassifierSelfChecks()
      } catch (error) {
        cleanupErrors.push(
          `real-backup failure classifier self-check failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      if (bodyFailure !== null) {
        const ownedLogsDir = resolveOwnedLogsDir(userDataDir)
        try {
          const aggregate = classifyRealBackupFailureLines(readOwnedAppLogLines(ownedLogsDir))
          console.log(`[E2E] real-backup failure aggregate: ${JSON.stringify(aggregate)}`)
        } catch (error) {
          cleanupErrors.push(
            `real-backup failure aggregate extraction failed: ${redactPathText(redactPathText(error, zipPath), ownedLogsDir)}`
          )
        }
      }

      // LOCK-REAL3: source immutable post-check — runs even on failure.
      try {
        const sourceAfter = await captureSourceFingerprint(zipPath)
        const diffs = compareFingerprints(sourceBefore, sourceAfter)
        if (diffs.length > 0) {
          cleanupErrors.push(`Source ZIP immutability violated after import: ${diffs.join(', ')}`)
        } else {
          console.log(
            `[E2E] real-backup source immutability post-check PASS ` +
              `(sha256[:8]=${sourceAfter.sha256.slice(0, 8)}; size/mtime/inode/mode unchanged)`
          )
        }
      } catch (err) {
        cleanupErrors.push(`Source ZIP post-check failed: ${redactPathText(err, zipPath)}`)
      }

      if (cleanupErrors.length > 0) {
        const bodyNote = bodyFailure ? ` (body also failed: ${redactPathText(bodyFailure, zipPath)})` : ''
        throw new Error(`E2E cleanup failed (${cleanupErrors.length} error(s)): ${cleanupErrors.join('; ')}${bodyNote}`)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Helpers — pre-import setup
// ---------------------------------------------------------------------------

/**
 * Create the deterministic target marker topic in Redux (visible in the
 * sidebar) and persist it to SQLite so the replace-all import must remove it
 * from both planes (LOCK-REAL5).
 */
async function createMarkerTopic(page: import('@playwright/test').Page, topicId: string, name: string): Promise<void> {
  const result = await page.evaluate(
    async ({ topicId, name }) => {
      const store = (window as any).store
      const state = store.getState()
      const assistant = state.assistants?.assistants?.[0]
      if (!assistant) throw new Error('No assistant available to host the marker topic')
      const topic = {
        id: topicId,
        assistantId: assistant.id,
        name,
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z'
      }
      store.dispatch({ type: 'assistants/addTopic', payload: { assistantId: assistant.id, topic } })
      const ensured = await (window as any).api.chatDb.ensureTopic({ topicId, assistantId: assistant.id, name })
      return { assistantId: assistant.id, ensured }
    },
    { topicId, name }
  )
  expect(result.assistantId, 'the default assistant must host the marker topic').toBeTruthy()
  expect(result.ensured?.ok, `marker ensureTopic failed: ${JSON.stringify(result.ensured)}`).toBe(true)
}

// ---------------------------------------------------------------------------
// Helpers — Redux/UI aggregate readers (no names/IDs/content ever returned)
// ---------------------------------------------------------------------------

async function topicExistsInRedux(page: import('@playwright/test').Page, topicId: string): Promise<boolean> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    for (const assistant of s.assistants?.assistants ?? []) {
      if ((assistant.topics ?? []).some((t: any) => t.id === topicId)) return true
    }
    return false
  }, topicId)
}

/** Aggregate navigation snapshot — counts/booleans only (LOCK-REAL5). */
interface NavigationAggregate {
  assistantCount: number
  topicCount: number
  activeTopicCount: number
  deletedTopicCount: number
}

async function readNavigationAggregate(page: import('@playwright/test').Page): Promise<NavigationAggregate> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistants = s.assistants?.assistants ?? []
    let topicCount = 0
    let activeTopicCount = 0
    let deletedTopicCount = 0
    for (const a of assistants) {
      for (const t of a.topics ?? []) {
        topicCount += 1
        if (t.deletedAt) deletedTopicCount += 1
        else activeTopicCount += 1
      }
    }
    return {
      assistantCount: assistants.length,
      topicCount,
      activeTopicCount,
      deletedTopicCount
    }
  })
}

/**
 * Wait until the imported navigation is present in Redux at an aggregate
 * level: at least one assistant owning at least one topic (LOCK-PROD-6 apply).
 */
async function waitForImportedNavigationAggregate(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = (window as any).store?.getState()
      const list = s?.assistants?.assistants
      if (!Array.isArray(list) || list.length === 0) return false
      const topicCount = list.reduce((n: number, a: any) => n + ((a.topics ?? []).length as number), 0)
      return topicCount >= 1
    },
    { timeout: 120000 }
  )
}

/**
 * LOCK-REAL5: the one-shot navigation projection must be absent afterwards —
 * getProjection() returns ok with a null projection only after the renderer
 * applied the replace-all navigation AND durably acknowledged it
 * (LOCK-PROD-6 ordering: read → dispatch → flush → ack).
 */
async function waitForProjectionAcked(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as any).api?.cherryImport?.getProjection().then((r: any) => r && r.ok === true && r.projection === null),
    { timeout: 120000 }
  )
}

/**
 * Wait until the main window is usable again after the in-process reload:
 * #root attached, Redux store defined, home ready.
 */
async function waitForMainWindowReady(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('#root', { state: 'attached', timeout: 120000 })
  await page.waitForFunction(() => typeof (window as any).store !== 'undefined', { timeout: 120000 })
  await page.waitForSelector(
    ['#chat', '.inputbar-container', '[class*="Inputbar"]', '[class*="Container"]'].join(', '),
    { state: 'visible', timeout: 120000 }
  )
}

/**
 * LOCK-REAL5: at least one imported active topic is visible in the real topic
 * list, clickable, and carries historical message/block PRESENCE — counts
 * only, never content.
 */
async function assertImportedTopicVisibleAndClickable(page: import('@playwright/test').Page): Promise<void> {
  // LOCK-NAV: the assistant list panel always renders; no tab switching.
  await expect(page.locator('.assistants-tab')).toBeVisible()
  const assistantRows = page.locator('.assistants-tab .draggable-list-container > div')
  const assistantCount = await assistantRows.count()
  expect(assistantCount, 'at least one imported assistant row must render in the sidebar').toBeGreaterThanOrEqual(1)

  // Find an assistant that owns at least one visible topic (aggregate scan —
  // no names, no IDs).
  let topicItems: ReturnType<import('@playwright/test').Page['locator']> | null = null
  for (let i = 0; i < assistantCount; i++) {
    await assistantRows.nth(i).click()
    // LOCK-NAV: the topics list panel always renders beside the assistant
    // list; assert its readiness after activating the assistant row.
    await expect(page.locator('.topics-tab')).toBeVisible()
    const items = page.locator('[data-testid="topic-item"]')
    if ((await items.count()) >= 1) {
      topicItems = items
      break
    }
  }
  expect(topicItems, 'at least one imported active topic must be visible in the topic list').not.toBeNull()

  // Click topics until one renders historical message containers (bounded).
  const topicTotal = await (topicItems as NonNullable<typeof topicItems>).count()
  let renderedMessages = 0
  for (let j = 0; j < Math.min(topicTotal, 15) && renderedMessages === 0; j++) {
    await (topicItems as NonNullable<typeof topicItems>).nth(j).click()
    renderedMessages = await waitForRenderedMessageCount(page, 10000)
  }
  expect(
    renderedMessages,
    'at least one imported active topic must expose historical message containers in the real UI'
  ).toBeGreaterThanOrEqual(1)

  // Redux aggregate: historical message + block presence (no content).
  const presence = await page.evaluate(() => {
    const s = (window as any).store?.getState()
    const byTopic = s?.messages?.messageIdsByTopic ?? {}
    const entities = s?.messages?.entities ?? {}
    let topicsWithMessages = 0
    let totalMessageIds = 0
    let totalBlockIds = 0
    for (const topicId of Object.keys(byTopic)) {
      const ids = byTopic[topicId] ?? []
      if (ids.length > 0) topicsWithMessages += 1
      totalMessageIds += ids.length
      for (const id of ids) {
        totalBlockIds += (entities[id]?.blocks ?? []).length
      }
    }
    return { topicsWithMessages, totalMessageIds, totalBlockIds }
  })
  expect(
    presence.topicsWithMessages,
    'at least one imported topic must hold loaded historical messages in Redux'
  ).toBeGreaterThanOrEqual(1)
  expect(presence.totalMessageIds, 'historical message presence in Redux must be non-zero').toBeGreaterThanOrEqual(1)
  expect(presence.totalBlockIds, 'historical message-block presence in Redux must be non-zero').toBeGreaterThanOrEqual(
    1
  )
}

/** Poll the rendered `[data-message-id]` count until non-zero or the budget elapses. */
async function waitForRenderedMessageCount(page: import('@playwright/test').Page, timeoutMs: number): Promise<number> {
  const start = Date.now()
  for (;;) {
    const count = await page.locator('[data-message-id]').count()
    if (count > 0) return count
    if (Date.now() - start > timeoutMs) return 0
    await page.waitForTimeout(300)
  }
}

// ---------------------------------------------------------------------------
// Helpers — candidate stats / navigation aggregates
// ---------------------------------------------------------------------------

/** CandidateImportStats aggregate sanity (LOCK-REAL5) — counts only. */
function assertCandidateStatsCoherent(stats: Record<string, unknown>): void {
  const countFields = [
    'topicCount',
    'messageCount',
    'blockCount',
    'segmentCount',
    'segmentMembershipCount',
    'fileReferenceCount',
    'pageCount'
  ] as const
  const values: Record<string, number> = {}
  for (const field of countFields) {
    const value = stats[field]
    expect(value, `candidate stat ${field} must be present`).toBeDefined()
    expect(
      Number.isSafeInteger(value) && (value as number) >= 0,
      `candidate stat ${field} must be a non-negative safe integer`
    ).toBe(true)
    values[field] = Number(value)
  }
  const elapsed = Number(stats.elapsedMs)
  expect(Number.isFinite(elapsed) && elapsed >= 0, 'candidate elapsedMs must be finite and non-negative').toBe(true)

  // A real Cherry Studio backup carries historical conversations — at least
  // one topic, one message, and one message block must be imported.
  expect(values.topicCount, 'real-backup candidate must contain at least one topic').toBeGreaterThanOrEqual(1)
  expect(
    values.messageCount,
    'real-backup candidate must contain at least one historical message'
  ).toBeGreaterThanOrEqual(1)
  expect(values.blockCount, 'real-backup candidate must contain at least one message block').toBeGreaterThanOrEqual(1)
}

/** Aggregate navigation coherence (LOCK-REAL5) — counts/booleans only. */
function assertNavigationAggregate(nav: NavigationAggregate): void {
  expect(nav.assistantCount, 'at least one imported assistant must be present').toBeGreaterThanOrEqual(1)
  expect(nav.topicCount, 'at least one imported topic must be present').toBeGreaterThanOrEqual(1)
  expect(nav.activeTopicCount, 'at least one imported active topic must be present').toBeGreaterThanOrEqual(1)
  expect(nav.deletedTopicCount, 'deleted topic count must be a non-negative integer').toBeGreaterThanOrEqual(0)
  expect(nav.activeTopicCount, 'active topic count must be coherent with the total topic count').toBeLessThanOrEqual(
    nav.topicCount
  )
}

// ---------------------------------------------------------------------------
// Helpers — `Data/` non-materialization proof (LOCK-REAL6)
// ---------------------------------------------------------------------------

/**
 * Assert no top-level `Data` entry is materialized in ANY owned workspace:
 * the owned temp root, every `cherry-import-*` extraction workspace under it,
 * and every `candidate-*` candidate directory under the app Data root. Only
 * OWNED paths are inspected — the source ZIP is never re-scanned and the
 * production app `Data` root (the legitimate target) is not part of this
 * proof.
 */
function assertIgnoredDataSubtreesAbsent(_before: CandidateInventory, dataDir: string, ownedTmpRoot: string): void {
  const violations: string[] = []
  let scannedWorkspaces = 0

  // The owned temp root itself must not gain a top-level Data entry.
  scannedWorkspaces += 1
  assertNoTopLevelDataEntry(ownedTmpRoot, violations)

  // Extraction/temp workspaces under the owned tmp root.
  for (const workspace of listCandidateTempWorkspaces(ownedTmpRoot)) {
    scannedWorkspaces += 1
    // The selected IndexedDB subtree MUST be materialized (proves the
    // workspace really received ZIP content) while Data must not.
    if (!fs.existsSync(path.join(workspace, 'IndexedDB'))) {
      violations.push(`owned extraction workspace missing the selected IndexedDB subtree: ${workspace}`)
    }
    assertNoTopLevelDataEntry(workspace, violations)
  }

  // Candidate workspace under the disposable app Data root.
  const candidatesDir = path.join(dataDir, 'chat-import-candidates')
  if (fs.existsSync(candidatesDir)) {
    for (const entry of fs.readdirSync(candidatesDir)) {
      if (!entry.startsWith(CANDIDATE_DIR_PREFIX)) continue
      const candidatePath = path.join(candidatesDir, entry)
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(candidatePath)
      } catch {
        continue
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        scannedWorkspaces += 1
        assertNoTopLevelDataEntry(candidatePath, violations)
      }
    }
  }

  expect(
    scannedWorkspaces,
    'at least one owned extraction/candidate/temp workspace must exist to prove Data/ non-materialization (LOCK-REAL6)'
  ).toBeGreaterThan(0)
  expect(
    violations,
    'no top-level Data/ subtree may be materialized in any owned extraction/candidate/temp workspace (LOCK-REAL6)'
  ).toEqual([])
}

function assertNoTopLevelDataEntry(root: string, violations: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    violations.push(`failed to read owned workspace ${root}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  for (const entry of entries) {
    if (entry.name === IGNORED_DATA_ROOT_NAME) {
      violations.push(`top-level Data/ entry materialized in owned workspace ${root}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers — SQLite evidence (post-close, read-only, aggregate)
// ---------------------------------------------------------------------------

/**
 * LOCK-REAL5/LOCK-QDB-3/6/7/17/18: post-close SQLite readonly aggregate checks
 * run through ONE fixed batched verification plan — a single child opens ONE
 * readonly connection/snapshot, checks exactly one-row integrity 'ok', an
 * exactly empty foreign_key_check, exact one valid integer count per
 * allowlisted table, and the exact `deletedTopics` sibling from
 * `SELECT COUNT(*) ... WHERE deleted_at IS NOT NULL` in the SAME snapshot.
 * Installed counts must EXACTLY equal the candidate stats, and the
 * navigation aggregate must reconcile with the snapshot algebra (LOCK-QDB-18):
 * the real-backup artifact carries exactly 3 deleted topics; navigation
 * active === SQLite total - deleted; the navigation surfaces only active
 * topics; and SQLite total === navigation active + deleted.
 * Assertions use fixed operation labels/counts only — never paths or raw
 * outcome serialization.
 */
async function assertPostCloseSqlite(
  dbPath: string,
  stats: Record<string, unknown>,
  nav: NavigationAggregate
): Promise<void> {
  const result = await verifyChatDbViaElectronWithRetry(dbPath)
  if (!result.ok) {
    throw new Error(`post-close chat.db verification failed: ${result.code}`)
  }
  const { integrityOk, foreignKeyViolations, counts, deletedTopics } = result.value
  // LOCK-QDB-7: exact one-row integrity 'ok'; FK exactly empty.
  expect(integrityOk, 'post-close SQLite integrity_check must be exactly one row with value ok').toBe(true)
  expect(foreignKeyViolations, 'post-close SQLite foreign_key_check must be exactly empty').toBe(0)

  // LOCK-QDB-18: the real-backup artifact is known to carry exactly 3 deleted
  // topics, proven by the exact sibling from the same readonly snapshot.
  expect(deletedTopics, 'post-close deletedTopics must be exactly 3 for the real-backup artifact (LOCK-QDB-18)').toBe(3)

  // LOCK-QDB-18: the navigation active count must equal SQLite total minus
  // deleted (activeNavigation === counts.topics - deletedTopics).
  expect(nav.activeTopicCount, 'navigation active topics must equal SQLite total minus deleted (LOCK-QDB-18)').toBe(
    counts.topics - deletedTopics
  )
  // LOCK-QDB-18: the navigation surfaces ONLY active topics after import.
  expect(nav.topicCount, 'navigation must surface only active topics (nav.topicCount===nav.activeTopicCount)').toBe(
    nav.activeTopicCount
  )
  // LOCK-QDB-18: SQLite total must equal navigation active + deleted
  // (total === active + deleted).
  expect(counts.topics, 'SQLite total topics must equal navigation active + deleted (LOCK-QDB-18)').toBe(
    nav.activeTopicCount + deletedTopics
  )

  const tableCounts: Array<[VerificationTable, string, unknown]> = [
    ['topics', 'topicCount', stats.topicCount],
    ['messages', 'messageCount', stats.messageCount],
    ['message_blocks', 'blockCount', stats.blockCount],
    ['topic_segments', 'segmentCount', stats.segmentCount],
    ['topic_segment_messages', 'segmentMembershipCount', stats.segmentMembershipCount],
    ['file_references', 'fileReferenceCount', stats.fileReferenceCount]
  ]
  for (const [table, statName, expected] of tableCounts) {
    expect(counts[table], `post-close ${table} count must equal candidate ${statName}`).toBe(Number(expected))
  }
}

/**
 * LOCK-SNAP-1: the retained pre-import snapshot must be a regular non-symlink
 * file, non-empty and readable, and must pass the bounded readonly integrity
 * evidence. Journal/staging absence messages stay path-free (fixed artifact
 * names only).
 */
async function assertRetainedPreImportSnapshot(dataDir: string): Promise<void> {
  const snapshotPath = path.join(dataDir, ROLLBACK_SNAPSHOT_FILENAME)
  // LOCK-SNAP-2: regular non-symlink non-empty file (fixed path-free checks).
  assertRetainedSnapshotFile(snapshotPath)

  // LOCK-SNAP-1: bounded readonly integrity evidence on the retained snapshot.
  const snapshotVerify = await verifyChatDbViaElectronWithRetry(snapshotPath)
  if (!snapshotVerify.ok) {
    throw new Error(`retained pre-import snapshot integrity check failed: ${snapshotVerify.code}`)
  }
  expect(snapshotVerify.value.integrityOk, 'retained pre-import snapshot must pass integrity_check').toBe(true)
  expect(snapshotVerify.value.foreignKeyViolations, 'retained pre-import snapshot must pass foreign_key_check').toBe(0)

  // LOCK-4436/4438: the journal and every staging sibling are durably cleaned
  // after successful recovery. Fixed artifact names only — no paths.
  for (const artifactName of [
    PROMOTION_JOURNAL_FILENAME,
    PROMOTION_JOURNAL_STAGING_FILENAME,
    ROLLBACK_SNAPSHOT_STAGING_FILENAME
  ]) {
    const artifactPath = path.join(dataDir, artifactName)
    expect(
      fs.existsSync(artifactPath),
      `promotion artifact should be absent after successful recovery: ${artifactName}`
    ).toBe(false)
  }
}

// ---------------------------------------------------------------------------
// Helpers — source immutability (LOCK-REAL3)
// ---------------------------------------------------------------------------

interface SourceFingerprint {
  sha256: string
  size: number
  mtimeMs: number
  ino: number
  mode: number
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** Read-only source fingerprint: SHA-256 + size + mtime + inode + mode. */
async function captureSourceFingerprint(filePath: string): Promise<SourceFingerprint> {
  const stat = fs.statSync(filePath)
  return {
    sha256: await sha256File(filePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: stat.ino,
    mode: stat.mode
  }
}

function compareFingerprints(before: SourceFingerprint, after: SourceFingerprint): string[] {
  const diffs: string[] = []
  if (before.sha256 !== after.sha256) diffs.push('sha256 changed')
  if (before.size !== after.size) diffs.push('size changed')
  if (before.mtimeMs !== after.mtimeMs) diffs.push('mtime changed')
  if (before.ino !== after.ino) diffs.push('inode changed')
  if (before.mode !== after.mode) diffs.push('mode changed')
  return diffs
}

// ---------------------------------------------------------------------------
// Helpers — privacy redaction (LOCK-REAL2/LOCK-PRIV-2)
// ---------------------------------------------------------------------------
// `redactPathText` / `redactSourcePath` are shared E2E utilities in
// `tests/e2e/utils/redact-path.ts` (unit-tested there). LOCK-PRIV-2: the
// source path is redacted in BOTH the error message and the error stack; the
// unredacted stack is never preserved.

// ---------------------------------------------------------------------------
// Helpers — bounded reading-stage failure classifier (LOCK-DREAL2/3)
// ---------------------------------------------------------------------------
// Privacy contract: when the body fails, the harness reads ONLY the owned
// disposable profile's `logs/app*.log` files, parses each line strictly IN
// MEMORY through the allowlisted signals below, and emits ONE aggregate JSON
// containing only closed-enum category fields plus a matching-line count.
// Indices, IDs, values, constructor names, table filenames, stacks, paths and
// raw lines never appear in the output. When no pattern matches, every
// category reports its safe unknown/none value and matchCount is 0 — there is
// never a raw fallback. The classifier is exercised against synthetic
// secret-bearing log lines in self-checks before any real log is read.
// ---------------------------------------------------------------------------

/**
 * Fixed production data-plane rejection codes (LOCK-DIAG-2): the exact
 * `ImportDataPlaneErrorCode` members plus the sanitized `UNKNOWN` label that
 * production renders for any non-allowlisted code (LOCK-PRIV-10). Every value
 * is regex-special-safe (uppercase letters/underscore only). The array is the
 * single source of truth for the closed classifier enum AND its regexes, so
 * the classifier can never drift from the production summary format.
 */
const DATA_PLANE_CODES = [
  'INVALID_ROW',
  'DUPLICATE_RELATION',
  'OWNERSHIP_MISMATCH',
  'MISSING_BLOCKS',
  'UNKNOWN_TABLE',
  'ENTITY_ORDER_VIOLATION',
  'TARGET_COLLISION',
  'FINALIZED',
  'NOT_FINALIZED',
  'UNKNOWN'
] as const

/**
 * Fixed production data-plane table labels (LOCK-DIAG-2): the bounded
 * `SUMMARY_TABLE_ALLOWLIST` labels plus the sanitized `unknown` label
 * (LOCK-PRIV-3). Every value is regex-special-safe (lowercase letters/
 * underscore only).
 */
const DATA_PLANE_TABLES = ['topics', 'message_blocks', 'topic_segments', 'files', 'unknown'] as const

/**
 * Fixed production renderer-origin error codes (LOCK-DIAG-2): the exact
 * `RENDERER_ERROR_CODE_ALLOWLIST` members plus the sanitized `UNKNOWN` label
 * (LOCK-PRIV-6). Order doubles as the tie-break priority and preserves
 * reading-stage precedence (READ_FAILED > READPAGE_REJECTED).
 */
const RENDERER_CODES = [
  'READ_FAILED',
  'READPAGE_REJECTED',
  'WRONG_ORIGIN',
  'DISCOVERY_REJECTED',
  'DISCOVERY_FAILED',
  'RENDERER_GONE',
  'UNKNOWN'
] as const

type RealBackupRendererCode = (typeof RENDERER_CODES)[number] | 'none'

type RealBackupDataPlaneCode = (typeof DATA_PLANE_CODES)[number] | 'none'

type RealBackupEntity = (typeof DATA_PLANE_TABLES)[number]

type RealBackupReasonFamily =
  | 'wire-type'
  | 'non-finite'
  | 'cycle'
  | 'sparse-array'
  | 'undefined-array'
  | 'depth'
  | 'non-plain'
  | 'missing-required'
  | 'duplicate-id'
  | 'ownership'
  | 'timeout'
  | 'sqlite-constraint'
  | 'unknown'

interface RealBackupFailureAggregate {
  rendererCode: RealBackupRendererCode
  dataPlaneCode: RealBackupDataPlaneCode
  entity: RealBackupEntity
  reasonFamily: RealBackupReasonFamily
  matchCount: number
}

/**
 * Per-line signal gate — only lines carrying one of these bounded signals are
 * examined. The data-plane and renderer alternatives are composed from the
 * fixed code/table arrays above (LOCK-DIAG-2), so a line carrying an arbitrary
 * code, table, or text substitution can never pass the gate.
 */
const FAILURE_SIGNAL_RE = new RegExp(
  [
    String.raw`\[(READ_FAILED|READPAGE_REJECTED)\]`,
    String.raw`\[chatImport\] (Read page failed|readPageResult rejected by Main)`,
    String.raw`cloneForWire:`,
    String.raw`DATA_PLANE_REJECTION\((?:${DATA_PLANE_CODES.join('|')}), table=(?:${DATA_PLANE_TABLES.join('|')})\)`,
    String.raw`RENDERER_ERROR\((?:${RENDERER_CODES.join('|')})\)`,
    String.raw`Page read timed out`,
    String.raw`constraint failed`
  ].join('|')
)

/**
 * Production data-plane summary (LOCK-DIAG-2): `DATA_PLANE_REJECTION(CODE,
 * table=TABLE)` with ONLY fixed code/table alternatives. Group 1 = code,
 * group 2 = table — both closed enums; arbitrary suffixes, IDs, paths, and
 * text after the summary are never captured.
 */
const DATA_PLANE_SUMMARY_RE = new RegExp(
  `DATA_PLANE_REJECTION\\((${DATA_PLANE_CODES.join('|')}), table=(${DATA_PLANE_TABLES.join('|')})\\)`
)

/** Production renderer summary (LOCK-DIAG-2): `RENDERER_ERROR(CODE)` with
 *  ONLY fixed code alternatives. Group 1 = code — a closed enum. */
const RENDERER_SUMMARY_RE = new RegExp(`RENDERER_ERROR\\((${RENDERER_CODES.join('|')})\\)`)

/** Deterministic tie-break priorities — safe unknown/none values sort last. */
const RENDERER_PRIORITY: readonly RealBackupRendererCode[] = [...RENDERER_CODES, 'none']
const DATA_PLANE_PRIORITY: readonly RealBackupDataPlaneCode[] = [...DATA_PLANE_CODES, 'none']
const ENTITY_PRIORITY: readonly RealBackupEntity[] = [...DATA_PLANE_TABLES]
const REASON_PRIORITY: readonly RealBackupReasonFamily[] = [
  'cycle',
  'sparse-array',
  'undefined-array',
  'non-finite',
  'depth',
  'non-plain',
  'wire-type',
  'timeout',
  'sqlite-constraint',
  'missing-required',
  'duplicate-id',
  'ownership',
  'unknown'
]

interface ClassifiedFailureLine {
  rendererCode: RealBackupRendererCode
  dataPlaneCode: RealBackupDataPlaneCode
  entity: RealBackupEntity
  reasonFamily: RealBackupReasonFamily
}

/**
 * Map one matching line to the closed allowlist categories. The mapping is
 * tuned ONLY to the bounded reading-stage family; anything else stays safe.
 */
function classifyFailureLine(line: string): ClassifiedFailureLine {
  let rendererCode: RealBackupRendererCode = 'none'
  if (/\[READ_FAILED\]/.test(line) || /\[chatImport\] Read page failed/.test(line)) {
    rendererCode = 'READ_FAILED'
  } else if (/\[READPAGE_REJECTED\]/.test(line) || /\[chatImport\] readPageResult rejected by Main/.test(line)) {
    rendererCode = 'READPAGE_REJECTED'
  } else {
    // LOCK-DIAG-3: production Main log boundary — `RENDERER_ERROR(CODE)`.
    const rendererSummary = RENDERER_SUMMARY_RE.exec(line)
    if (rendererSummary) {
      rendererCode = rendererSummary[1] as RealBackupRendererCode
    }
  }

  let dataPlaneCode: RealBackupDataPlaneCode = 'none'
  let entity: RealBackupEntity = 'unknown'
  // LOCK-DIAG-3: production Main log boundary — `DATA_PLANE_REJECTION(CODE,
  // table=TABLE)`. Code AND table both come from the fixed production
  // summary; the entity is never read from arbitrary text.
  const dp = DATA_PLANE_SUMMARY_RE.exec(line)
  if (dp) {
    dataPlaneCode = dp[1] as RealBackupDataPlaneCode
    entity = dp[2] as RealBackupEntity
  }

  return { rendererCode, dataPlaneCode, entity, reasonFamily: classifyReasonFamily(line, dataPlaneCode) }
}

/** Reason family: specific keyword signals first, then the data-plane code. */
function classifyReasonFamily(line: string, dataPlaneCode: RealBackupDataPlaneCode): RealBackupReasonFamily {
  if (/timed out/.test(line)) return 'timeout'
  if (/constraint failed/.test(line)) return 'sqlite-constraint'
  if (/cyclic/i.test(line)) return 'cycle'
  if (/sparse array/i.test(line)) return 'sparse-array'
  if (/undefined in array/i.test(line)) return 'undefined-array'
  if (/non-finite/i.test(line)) return 'non-finite'
  if (/depth exceeds/i.test(line)) return 'depth'
  if (/non-plain/i.test(line)) return 'non-plain'
  if (
    /bigint|symbol|Date is not a valid|Map is not a valid|Set is not a valid|RegExp|Error is not a valid|TypedArray|Buffer is not a valid|function is not a valid|is not a valid JSON value|unsupported type|Unexpected type/i.test(
      line
    )
  ) {
    return 'wire-type'
  }
  switch (dataPlaneCode) {
    case 'DUPLICATE_RELATION':
    case 'TARGET_COLLISION':
      return 'duplicate-id'
    case 'OWNERSHIP_MISMATCH':
      return 'ownership'
    case 'MISSING_BLOCKS':
      return 'missing-required'
    case 'UNKNOWN_TABLE':
    case 'ENTITY_ORDER_VIOLATION':
    case 'FINALIZED':
    case 'NOT_FINALIZED':
    case 'UNKNOWN':
      return 'unknown'
    case 'INVALID_ROW':
      return /duplicate/i.test(line) ? 'duplicate-id' : 'missing-required'
    default:
      break
  }
  if (/duplicate/i.test(line)) return 'duplicate-id'
  if (/ownership|does not match|not referenced by any imported/i.test(line)) return 'ownership'
  if (/must be|missing|required/i.test(line)) return 'missing-required'
  return 'unknown'
}

/** Deterministic aggregate: per-field mode, ties broken by priority order. */
function pickDominant<K extends string>(values: K[], priorities: readonly K[]): K {
  const counts = new Map<K, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  let best = priorities[priorities.length - 1]
  let bestCount = -1
  for (const priority of priorities) {
    const count = counts.get(priority) ?? 0
    if (count > bestCount) {
      best = priority
      bestCount = count
    }
  }
  return best
}

/** Parse lines strictly in memory into the allowlisted aggregate. */
function classifyRealBackupFailureLines(lines: string[]): RealBackupFailureAggregate {
  const classified: ClassifiedFailureLine[] = []
  for (const line of lines) {
    if (!FAILURE_SIGNAL_RE.test(line)) continue
    classified.push(classifyFailureLine(line))
  }
  if (classified.length === 0) {
    return { rendererCode: 'none', dataPlaneCode: 'none', entity: 'unknown', reasonFamily: 'unknown', matchCount: 0 }
  }
  return {
    rendererCode: pickDominant(
      classified.map((c) => c.rendererCode),
      RENDERER_PRIORITY
    ),
    dataPlaneCode: pickDominant(
      classified.map((c) => c.dataPlaneCode),
      DATA_PLANE_PRIORITY
    ),
    entity: pickDominant(
      classified.map((c) => c.entity),
      ENTITY_PRIORITY
    ),
    reasonFamily: pickDominant(
      classified.map((c) => c.reasonFamily),
      REASON_PRIORITY
    ),
    matchCount: classified.length
  }
}

/**
 * The app's runtime userData — the exact explicit `--user-data-dir`
 * launch token, preserved verbatim (no `Dev` suffix) — hosts the winston
 * `logs/app*.log` files for this disposable profile. Falls back to the
 * fixture base only if the runtime path was never captured.
 */
function resolveOwnedLogsDir(userDataDir: string): string {
  const runtimeAppDataPath = getRuntimeAppDataPath()
  return runtimeAppDataPath ? path.join(runtimeAppDataPath, 'logs') : path.join(userDataDir, 'logs')
}

/**
 * Read ONLY the owned disposable `app*.log` files, one trimmed line at a
 * time, and remove them afterwards — nothing is retained or copied elsewhere
 * (LOCK-DREAL3). Missing log dir / read errors degrade to an empty line set
 * (the aggregate then reports the safe unknown/none values with matchCount 0).
 */
function readOwnedAppLogLines(logsDir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(logsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const readFiles: string[] = []
  const lines: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^app.*\.log$/.test(entry.name)) continue
    const filePath = path.join(logsDir, entry.name)
    readFiles.push(filePath)
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (line.length > 0) lines.push(line)
    }
  }
  // Best-effort removal after in-memory parsing; the disposable profile
  // teardown owns the definitive cleanup.
  for (const filePath of readFiles) {
    try {
      fs.unlinkSync(filePath)
    } catch {
      // best-effort only
    }
  }
  return lines
}

/**
 * Pure self-checks: run the classifier against synthetic log lines that embed
 * decoy IDs/paths/content/names and assert (a) the expected closed-enum
 * categories for the CURRENT production fixed-format summaries
 * (`DATA_PLANE_REJECTION(CODE, table=TABLE)` / `RENDERER_ERROR(CODE)`) and
 * the preserved legacy reading-stage signals, and (b) that no decoy survives
 * into the aggregate output. Negative decoy lines prove arbitrary
 * code/table/text substitutions and the stale synthetic phrase can never
 * match. Runs before any real log is read.
 */
function assertFailureClassifierSelfChecks(): void {
  const decoys = {
    id: 'synthetic-private-topic-id-7f3a9c',
    path: '/Users/synthetic/private/chat.db',
    content: 'synthetic-private-conversation-content',
    name: 'SyntheticPrivateTopicName'
  }

  const scenarios: Array<{ lines: string[]; expected: RealBackupFailureAggregate }> = [
    // Preserved legacy renderer wire-family signals (LOCK-DIAG-3).
    {
      lines: [
        `[chatImport] Read page failed: cloneForWire: cyclic reference detected (id=${decoys.id})`,
        `Import error for session abc: [READ_FAILED] cloneForWire: cyclic reference detected`
      ],
      expected: {
        rendererCode: 'READ_FAILED',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'cycle',
        matchCount: 2
      }
    },
    // Production data-plane summary: INVALID_ROW with table context, plus the
    // preserved `[READPAGE_REJECTED]` renderer bracket signal (LOCK-DIAG-3).
    {
      lines: [
        `Session abc failed during page write: DATA_PLANE_REJECTION(INVALID_ROW, table=topics)`,
        `Import error for session abc: [READPAGE_REJECTED] DATA_PLANE_REJECTION(INVALID_ROW, table=topics)`
      ],
      expected: {
        rendererCode: 'READPAGE_REJECTED',
        dataPlaneCode: 'INVALID_ROW',
        entity: 'topics',
        reasonFamily: 'missing-required',
        matchCount: 2
      }
    },
    {
      lines: [`Session abc failed during page write: DATA_PLANE_REJECTION(DUPLICATE_RELATION, table=message_blocks)`],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'DUPLICATE_RELATION',
        entity: 'message_blocks',
        reasonFamily: 'duplicate-id',
        matchCount: 1
      }
    },
    {
      lines: [`Session abc failed during page write: DATA_PLANE_REJECTION(OWNERSHIP_MISMATCH, table=topic_segments)`],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'OWNERSHIP_MISMATCH',
        entity: 'topic_segments',
        reasonFamily: 'ownership',
        matchCount: 1
      }
    },
    {
      lines: [`Session abc failed during page write: DATA_PLANE_REJECTION(MISSING_BLOCKS, table=message_blocks)`],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'MISSING_BLOCKS',
        entity: 'message_blocks',
        reasonFamily: 'missing-required',
        matchCount: 1
      }
    },
    {
      lines: [`Import error for session abc: DATA_PLANE_REJECTION(UNKNOWN_TABLE, table=unknown)`],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'UNKNOWN_TABLE',
        entity: 'unknown',
        reasonFamily: 'unknown',
        matchCount: 1
      }
    },
    {
      lines: [`Import error for session abc: DATA_PLANE_REJECTION(ENTITY_ORDER_VIOLATION, table=files)`],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'ENTITY_ORDER_VIOLATION',
        entity: 'files',
        reasonFamily: 'unknown',
        matchCount: 1
      }
    },
    // Production codes added since the stale synthetic phrase (LOCK-DIAG-2).
    {
      lines: [`Session abc failed during page write: DATA_PLANE_REJECTION(TARGET_COLLISION, table=topics)`],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'TARGET_COLLISION',
        entity: 'topics',
        reasonFamily: 'duplicate-id',
        matchCount: 1
      }
    },
    {
      lines: [`Session abc failed during page write: DATA_PLANE_REJECTION(FINALIZED, table=unknown)`],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'FINALIZED',
        entity: 'unknown',
        reasonFamily: 'unknown',
        matchCount: 1
      }
    },
    {
      lines: [`Session abc failed during page write: DATA_PLANE_REJECTION(NOT_FINALIZED, table=unknown)`],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'NOT_FINALIZED',
        entity: 'unknown',
        reasonFamily: 'unknown',
        matchCount: 1
      }
    },
    {
      lines: [`Session abc failed during page write: DATA_PLANE_REJECTION(UNKNOWN, table=topics)`],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'UNKNOWN',
        entity: 'topics',
        reasonFamily: 'unknown',
        matchCount: 1
      }
    },
    // Production renderer summary (LOCK-DIAG-3): reading-stage codes dominate
    // the tie-break, then the remaining fixed production codes.
    {
      lines: [
        `Import error for session abc: RENDERER_ERROR(READ_FAILED)`,
        `Isolated reader error for session abc: RENDERER_ERROR(READPAGE_REJECTED)`,
        `Import error for session abc: RENDERER_ERROR(WRONG_ORIGIN)`
      ],
      expected: {
        rendererCode: 'READ_FAILED',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'unknown',
        matchCount: 3
      }
    },
    {
      lines: [
        `Import error for session abc: RENDERER_ERROR(DISCOVERY_FAILED)`,
        `Import error for session abc: RENDERER_ERROR(DISCOVERY_REJECTED)`,
        `Isolated reader error for session abc: RENDERER_ERROR(RENDERER_GONE)`
      ],
      expected: {
        rendererCode: 'DISCOVERY_REJECTED',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'unknown',
        matchCount: 3
      }
    },
    {
      lines: [
        `Import error for session abc: RENDERER_ERROR(UNKNOWN)`,
        `Session abc failed during page write: DATA_PLANE_REJECTION(MISSING_BLOCKS, table=message_blocks)`
      ],
      expected: {
        rendererCode: 'UNKNOWN',
        dataPlaneCode: 'MISSING_BLOCKS',
        entity: 'message_blocks',
        reasonFamily: 'missing-required',
        matchCount: 2
      }
    },
    // Arbitrary text AFTER a fixed production summary is never captured — the
    // decoy path/content stay out of the aggregate (checked below).
    {
      lines: [
        `Session abc failed during page write: DATA_PLANE_REJECTION(INVALID_ROW, table=topics) ${decoys.path} ${decoys.content}`
      ],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'INVALID_ROW',
        entity: 'topics',
        reasonFamily: 'missing-required',
        matchCount: 1
      }
    },
    // Realistic winston JSON line carrying the production summary.
    {
      lines: [
        `{"level":"error","message":"Session abc failed during page write: DATA_PLANE_REJECTION(OWNERSHIP_MISMATCH, table=message_blocks)","timestamp":"2026-08-04 01:00:00"}`
      ],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'OWNERSHIP_MISMATCH',
        entity: 'message_blocks',
        reasonFamily: 'ownership',
        matchCount: 1
      }
    },
    // Preserved reading-stage signals (LOCK-DIAG-3).
    {
      lines: [`Import error for session abc: [READ_FAILED] Page read timed out after 120000ms`],
      expected: {
        rendererCode: 'READ_FAILED',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'timeout',
        matchCount: 1
      }
    },
    {
      lines: [`Session abc failed during page write: UNIQUE constraint failed: topics.id (id=${decoys.id})`],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'sqlite-constraint',
        matchCount: 1
      }
    },
    {
      lines: [`[chatImport] Read page failed: cloneForWire: bigint is not a valid JSON value (v=${decoys.content})`],
      expected: {
        rendererCode: 'READ_FAILED',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'wire-type',
        matchCount: 1
      }
    },
    {
      lines: [`[chatImport] Read page failed: cloneForWire: non-finite number: NaN`],
      expected: {
        rendererCode: 'READ_FAILED',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'non-finite',
        matchCount: 1
      }
    },
    {
      lines: [`[chatImport] Read page failed: cloneForWire: sparse arrays are not allowed (hole at index 2)`],
      expected: {
        rendererCode: 'READ_FAILED',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'sparse-array',
        matchCount: 1
      }
    },
    {
      lines: [`[chatImport] Read page failed: cloneForWire: undefined in arrays is not a valid JSON value (index 1)`],
      expected: {
        rendererCode: 'READ_FAILED',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'undefined-array',
        matchCount: 1
      }
    },
    {
      lines: [`[chatImport] Read page failed: cloneForWire: nesting depth exceeds maximum (100)`],
      expected: {
        rendererCode: 'READ_FAILED',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'depth',
        matchCount: 1
      }
    },
    {
      lines: [`[chatImport] Read page failed: cloneForWire: non-plain object (constructor: ${decoys.name})`],
      expected: {
        rendererCode: 'READ_FAILED',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'non-plain',
        matchCount: 1
      }
    },
    // Stale synthetic phrase must NOT be recognized as a data-plane code: the
    // `[READPAGE_REJECTED]` bracket still counts the line as a renderer signal,
    // but the stale `Import data-plane rejection (...)` detail is ignored.
    {
      lines: [
        `Import error for session abc: [READPAGE_REJECTED] Import data-plane rejection (DUPLICATE_RELATION): message_blocks[0] (id=${decoys.id}): duplicate message_blocks row`
      ],
      expected: {
        rendererCode: 'READPAGE_REJECTED',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'duplicate-id',
        matchCount: 1
      }
    },
    // Negative decoys (LOCK-DIAG-2/3): arbitrary code/table/text substitutions
    // and the stale synthetic phrase must not match at all.
    {
      lines: [
        `Session abc failed during page write: DATA_PLANE_REJECTION(HACK_${decoys.name}, table=topics)`,
        `Session abc failed during page write: DATA_PLANE_REJECTION(${decoys.content}, table=topics)`,
        `Session abc failed during page write: DATA_PLANE_REJECTION(INVALID_ROW, table=${decoys.name})`,
        `Session abc failed during page write: DATA_PLANE_REJECTION(INVALID_ROW, table=topics_evil)`,
        `Import error for session abc: RENDERER_ERROR(HACK_${decoys.content})`,
        `Import error for session abc: RENDERER_ERROR(READ_FAILED_EXTRA)`,
        `Import error for session abc: data_plane_rejection(INVALID_ROW, table=topics)`,
        `Session abc failed during page write: DATA_PLANE_REJECTION(INVALID_ROW table=topics)`,
        `Session abc failed during page write: Import data-plane rejection (INVALID_ROW): topics[3] (id=${decoys.id}): field 'id' must be a non-empty string (got number)`
      ],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'unknown',
        matchCount: 0
      }
    },
    // Unrelated owned-profile lines never match (LOCK-DIAG-2).
    {
      lines: [
        `[chatImport] Discovery complete: logical 11 (native 111)`,
        `[chatImport] Database opened with tables: topics, message_blocks, files`,
        `Renderer ready for session abc`,
        `Something completely unrelated: ${decoys.path} ${decoys.content}`
      ],
      expected: {
        rendererCode: 'none',
        dataPlaneCode: 'none',
        entity: 'unknown',
        reasonFamily: 'unknown',
        matchCount: 0
      }
    }
  ]

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i]
    const aggregate = classifyRealBackupFailureLines(scenario.lines)
    const label = `real-backup failure classifier self-check #${i + 1}`
    expect(aggregate.rendererCode, `${label}: rendererCode`).toBe(scenario.expected.rendererCode)
    expect(aggregate.dataPlaneCode, `${label}: dataPlaneCode`).toBe(scenario.expected.dataPlaneCode)
    expect(aggregate.entity, `${label}: entity`).toBe(scenario.expected.entity)
    expect(aggregate.reasonFamily, `${label}: reasonFamily`).toBe(scenario.expected.reasonFamily)
    expect(aggregate.matchCount, `${label}: matchCount`).toBe(scenario.expected.matchCount)

    // Schema is exactly the allowlisted keys — nothing else can be emitted.
    expect(Object.keys(aggregate).sort(), `${label}: schema keys`).toEqual([
      'dataPlaneCode',
      'entity',
      'matchCount',
      'reasonFamily',
      'rendererCode'
    ])

    // Decoy IDs/paths/content/names must never survive into the output.
    const serialized = JSON.stringify(aggregate)
    for (const decoy of Object.values(decoys)) {
      expect(serialized.includes(decoy), `${label}: decoy must never appear in aggregate output`).toBe(false)
    }
  }
}
