/**
 * E2E: L2 large-container selective-extraction import (LOCK-LUI1..LUI4).
 *
 * Proves, against a REAL container, that the production import pipeline
 * accepts a valid ZIP whose CENTRAL DIRECTORY carries a 600 MiB irrelevant
 * `Data/Files/e2e-large/irrelevant-bulk.bin` entry, imports the selected
 * IndexedDB / Local Storage subset, and NEVER materializes the irrelevant
 * entry anywhere in the owned workspace:
 *
 *   1. Build the disposable file-origin seed ZIP (real Chromium IndexedDB +
 *      Local Storage projection, LOCK-621/E2/E3) via `createDisposableSeedZip`.
 *   2. Derive the large container via `createDerivedLargeContainerZip`: a
 *      byte-preserving repackage of the seed plus the single streamed
 *      600 MiB irrelevant entry that keeps the archive <20 MiB on disk
 *      (LOCK-LUI1). Assert the evidence before import: archive bounded,
 *      irrelevant entry >500 MiB logical / never selected (LOCK-LUI2), seed
 *      selected-subset preserved.
 *   3. Drive `window.api.cherryImport.start(derivedZipPath)` and observe the
 *      status events THROUGH `finalizing` with candidate-ready data-plane
 *      counts 1/1/1/1/1 (LOCK-LUI3).
 *   4. LOCK-UI1: the import completes with an IN-PROCESS main renderer
 *      reload (LOCK-PROD-7) — the original PID stays alive. Wait for the
 *      reload marker to vanish, then for Redux rehydration and the one-shot
 *      navigation projection apply.
 *   5. Post-import UI assertions: the imported assistant + topic are visible
 *      after the same-PID reload (LOCK-LUI3).
 *   6. Non-materialization proof: recursively scan ONLY the owned app-data
 *      dir and owned temp root (extraction/candidate/temp workspaces) and
 *      assert the irrelevant path/name/root is absent everywhere (LOCK-LUI3).
 *   7. Close the ENTIRE app (exact-token cleanup, LOCK-625) and produce the
 *      hard data-plane evidence: SQLite integrity + replacement contents +
 *      focused counts, retained pre-import snapshot + journal/staging
 *      cleanup (LOCK-4434/4436/4438), and the empty-promoted-candidate-shell
 *      inventory (LOCK-DEV-8 style).
 *   8. finally: stop the observer, exact-token process sweep for the
 *      disposable profile, then `derived.cleanup()` and `seed.cleanup()` in
 *      order, and verify every owned path is gone. Cleanup failures fail the
 *      test (LOCK-C6/T1/T5, LOCK-LUI4).
 *
 * Kept deliberately focused: the full post-import send + same-profile
 * restart belongs to the genuine spec. LOCK-LUI2: this E2E does NOT cross
 * the old 500 MiB *compressed file-stat* cap — that branch is owned by the
 * mocked unit tests; it proves real central-directory/resource selection
 * and extraction behavior.
 *
 * Platform: macOS-only (production A-9 gate + `session.fromPath` verified on
 * darwin). Skipped clearly on other platforms.
 *
 * Prerequisite (owned by the main validation phase): a fresh build including
 * the chatImport window entry, the LOCK-PROD-7 in-process reload, and the
 * navigation projection apply; better-sqlite3 rebuilt for the Electron ABI so
 * `queryChatDbViaElectron` (post-close file reads) can load the native module
 * under the Electron binary.
 */
import * as fs from 'fs'
import * as path from 'path'

import {
  expect,
  getChatDbPath,
  queryChatDbViaElectron,
  test,
  verifyChatDbViaElectronWithRetry
} from '../../fixtures/electron.fixture'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import {
  createDerivedLargeContainerZip,
  DEFAULT_IRRELEVANT_ENTRY_NAME,
  DEFAULT_IRRELEVANT_LOGICAL_BYTES,
  DEFAULT_MAX_ARCHIVE_BYTES
} from '../../utils/derived-large-container-zip'
import {
  createDisposableSeedZip,
  PROJECTION_ASSISTANTS,
  PROJECTION_TOPICS,
  SEED_NATIVE_VERSION,
  SOURCE_IDS
} from '../../utils/disposable-seed-zip'
import { expectedMessageTargetId } from '../../utils/expected-message-id'
import {
  assertOnlyEmptyPromotedCandidateShells,
  snapshotCandidateInventory
} from '../../utils/import-artifact-validation'
import { assertStateSubsequence, observeImportStatuses, REQUIRED_STATE_CHAIN } from '../../utils/import-status'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { assertRetainedSnapshotFile } from '../../utils/snapshot-file'
import { sleep } from '../../utils/wait-helpers'

/** Fixed names produced by the promotion pipeline (Phase 4.4). */
const ROLLBACK_SNAPSHOT_FILENAME = 'chat.db.pre-import-backup'
const ROLLBACK_SNAPSHOT_STAGING_FILENAME = 'chat.db.pre-import-backup.staging'
const PROMOTION_JOURNAL_FILENAME = 'chat-import-promotion.journal.json'
const PROMOTION_JOURNAL_STAGING_FILENAME = 'chat-import-promotion.journal.json.staging'

/**
 * LOCK-MID-1/2 + LOCK-E2E-1: the imported source message does NOT retain its
 * legacy id. Every occurrence maps to the deterministic target
 * `l2m1:<sha256>` of `(outerTopicId, legacyMessageId)` — all message-identity
 * assertions (SQLite `messages.id`, `message_blocks.message_id`,
 * `topic_segment_messages.message_id`) must expect the DERIVED target.
 * Source-side seed evidence (verifiedKeys) legitimately keeps the legacy
 * `SOURCE_IDS.message`.
 */
const TARGET_MESSAGE_ID = expectedMessageTargetId(SOURCE_IDS.topic, SOURCE_IDS.message)

test.describe('Cherry Studio large-container selective-extraction import', () => {
  test.skip(
    process.platform !== 'darwin',
    'L2 import is macOS-only (LOCK-623); large-container E2E requires darwin and session.fromPath behavior'
  )

  test('imports a ZIP with a 600 MiB irrelevant Data/Files entry via selective extraction and never materializes it', async ({
    electronApp,
    mainWindow,
    userDataDir,
    ownedTmpRoot
  }) => {
    // Seed generation + derivation + import + reload + UI lifecycle + close +
    // post-close data-plane evidence exceed the 60s default and the 300s
    // budget of earlier phases.
    test.setTimeout(600000)
    const page = mainWindow

    // --- 0. Original process identity + target chat.db location -----------
    const originalPid = electronApp.process().pid
    expect(originalPid, 'original target process pid must be defined').toBeTruthy()
    const originalPidValue = originalPid as number
    const chatDbPath = getChatDbPath()
    expect(chatDbPath, 'fixture must have captured the disposable chat.db path').toBeTruthy()
    const dataDir = path.dirname(chatDbPath!)

    // LOCK-LUI3: owned candidate/temp workspace inventory BEFORE the import so
    // candidate-shell and tmpdir deferred-recovery cleanup is provable
    // afterwards (LOCK-DEV-8 style).
    const candidateInventoryBefore = snapshotCandidateInventory(dataDir, ownedTmpRoot)

    // Body + cleanup error capture (LOCK-C6: cleanup failure is a test
    // failure, never a warning; a body failure is preserved for diagnosis).
    let bodyFailure: unknown = null
    const cleanupErrors: string[] = []
    let seed: Awaited<ReturnType<typeof createDisposableSeedZip>> | null = null
    let derived: Awaited<ReturnType<typeof createDerivedLargeContainerZip>> | null = null
    let observer: Awaited<ReturnType<typeof observeImportStatuses>> | null = null

    try {
      // ─────────────────────────────────────────────────────────────────────
      // 0. Reload detection marker (LOCK-UI1): the in-process reload resets
      // the page context, so the marker vanishing proves the reload ran.
      // ─────────────────────────────────────────────────────────────────────
      await page.evaluate(() => {
        ;(window as any).__e2ePreImportMarker = true
      })

      // --- 1. Disposable file-origin seed ZIP (LOCK-621/E2/E3) --------------
      seed = await createDisposableSeedZip(ownedTmpRoot)
      expect(seed.evidence.nativeVersion).toBe(SEED_NATIVE_VERSION)
      for (const store of ['topics', 'message_blocks', 'topic_segments', 'files']) {
        expect(seed.evidence.stores).toContain(store)
      }
      expect(seed.evidence.verifiedKeys.topics).toContain(SOURCE_IDS.topic)
      expect(seed.evidence.verifiedKeys.message_blocks).toContain(SOURCE_IDS.block)
      expect(seed.evidence.verifiedKeys.topic_segments).toContain(SOURCE_IDS.segment)
      expect(
        seed.evidence.zipAllEntriesUnderOrigin,
        'every seed ZIP IndexedDB/ entry must be under the expected file origin'
      ).toBe(true)
      expect(seed.evidence.zipLdbEntryCount, 'seed ZIP must contain at least one .ldb entry').toBeGreaterThanOrEqual(1)
      expect(seed.evidence.zipHasLocalStorage, 'seed ZIP must carry Local Storage/leveldb').toBe(true)
      expect(seed.evidence.persistKey, 'seed must carry the persist:cherry-studio key').toBe('persist:cherry-studio')
      expect(seed.evidence.projectionAssistantCount).toBe(2)
      expect(seed.evidence.projectionTopicCount).toBe(2)
      console.log('[E2E] large-container seed ZIP evidence:', JSON.stringify(seed.evidence, null, 2))

      // --- 2. Derive the large container (LOCK-LUI1/LUI2) --------------------
      derived = await createDerivedLargeContainerZip(seed.zipPath, ownedTmpRoot)
      const e = derived.evidence
      // LOCK-LUI1: the archive stays <20 MiB on disk while the irrelevant
      // entry streams 600 MiB of uncompressed logical payload.
      expect(e.archiveBounded, 'derived archive must respect the bounded budget').toBe(true)
      expect(e.derivedArchiveBytes, 'derived archive must stay within the 20 MiB budget').toBeLessThanOrEqual(
        DEFAULT_MAX_ARCHIVE_BYTES
      )
      expect(e.derivedArchiveBytes).toBeLessThan(20 * 1024 * 1024)
      // LOCK-LUI2: the CENTRAL DIRECTORY already exceeds the legacy 500 MiB
      // logical cap via the irrelevant entry; the mocked unit tests own the
      // compressed >500 MiB file-stat cap.
      expect(e.irrelevantLogicalBytes, 'irrelevant entry must be the default 600 MiB logical payload').toBe(
        DEFAULT_IRRELEVANT_LOGICAL_BYTES
      )
      expect(e.irrelevantLogicalBytes).toBeGreaterThan(500 * 1024 * 1024)
      expect(e.irrelevantEntryName).toBe(DEFAULT_IRRELEVANT_ENTRY_NAME)
      expect(e.irrelevantEntryName.startsWith('Data/Files/')).toBe(true)
      expect(e.irrelevantNeverSelected, 'the Data/Files entry must never be selected by production').toBe(true)
      // LOCK-L3: every seed entry is preserved; only the irrelevant entry is
      // appended, and the selected subset stays tiny.
      expect(e.derivedEntryCount, 'derived ZIP must be exactly seed + 1 entry').toBe(e.seedEntryCount + 1)
      expect(e.selectedEntries.length, 'the selected subset must be non-empty').toBeGreaterThan(0)
      expect(e.selectedLogicalBytes, 'the selected subset must stay small').toBeLessThan(10 * 1024 * 1024)
      console.log('[E2E] derived large-container evidence:', JSON.stringify(e, null, 2))

      // --- 3. Observe statuses, then start the import ------------------------
      observer = await observeImportStatuses(page)
      const startResult = await page.evaluate(
        (zipPath) => (window as any).api.cherryImport.start(zipPath),
        derived.zipPath
      )
      expect(startResult?.ok, `cherryImport.start failed: ${JSON.stringify(startResult)}`).toBe(true)
      expect(typeof startResult.sessionId).toBe('string')
      const sessionId = startResult.sessionId as string
      observer.setSessionId(sessionId)

      // --- 4. Status progression THROUGH finalizing (LOCK-622 evidence a) ---
      const finalizing = await observer.waitForState('finalizing', 120000)
      expect(finalizing.state).toBe('finalizing')
      const observed = await observer.getStates()
      const stateNames = observed.map((s) => s.state)
      const chainError = assertStateSubsequence(stateNames, REQUIRED_STATE_CHAIN)
      expect(chainError, chainError ?? undefined).toBeNull()

      // `promoted` races the reload and is best-effort only (LOCK-622): when
      // observed it must come strictly after finalizing.
      const promotedIndex = stateNames.indexOf('promoted')
      if (promotedIndex !== -1) {
        expect(promotedIndex).toBeGreaterThan(stateNames.indexOf('finalizing'))
      }
      console.log(`[E2E] Observed large-container import states: ${stateNames.join(' -> ')}`)

      // LOCK-LUI3: candidate-ready counts stay 1/1/1/1/1 (the derived ZIP
      // preserves the seed's single IDB topic/message/block/segment/membership).
      const ready = observed.find((s) => s.state === 'candidate-ready')
      expect(ready?.stats, 'candidate-ready event must carry CandidateImportStats').toBeTruthy()
      expect(ready?.stats?.topicCount).toBe(1)
      expect(ready?.stats?.messageCount).toBe(1)
      expect(ready?.stats?.blockCount).toBe(1)
      expect(ready?.stats?.segmentCount).toBe(1)
      expect(ready?.stats?.segmentMembershipCount).toBe(1)

      // --- 5. In-process reload — same PID stays alive (LOCK-UI1) ------------
      expect(
        electronApp.process().pid,
        `original PID ${originalPidValue} must still be alive after finalizing (LOCK-UI1)`
      ).toBe(originalPidValue)

      // The reload resets the page context: wait for the pre-import marker to
      // vanish, then for the real main window + Redux to be ready again.
      await page.waitForFunction(() => (window as any).__e2ePreImportMarker !== true, { timeout: 120000 })
      await waitForMainWindowReady(page)
      // LOCK-PROD-6: wait for the one-shot navigation projection to apply on
      // rehydration (imported assistants replace the pre-import navigation).
      await waitForImportedNavigationInRedux(page)

      expect(
        electronApp.process().pid,
        `original PID ${originalPidValue} must still be alive after the in-process reload (LOCK-UI1)`
      ).toBe(originalPidValue)
      console.log(`[E2E] In-process reload observed; original PID ${originalPidValue} stayed alive (LOCK-UI1)`)

      // Detach the page-side observer (the collector was reset by the reload).
      await observer.stop()
      observer = null

      // --- 6. Post-import UI assertions (LOCK-LUI3) --------------------------
      expect(await topicExistsInRedux(page, SOURCE_IDS.topic), 'imported topic must be in Redux').toBe(true)
      await assertImportedNavigationUI(page)

      // --- 7. Non-materialization proof (LOCK-LUI3) --------------------------
      // Scan ONLY owned workspace paths (app-data dir + owned temp root:
      // extraction/candidate/temp workspaces) while the import artifacts
      // still exist; the 600 MiB Data/Files entry must never be materialized.
      assertIrrelevantEntryNeverMaterialized([dataDir, ownedTmpRoot])

      // --- 8. Close the ENTIRE app (LOCK-625) --------------------------------
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => electronApp.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      await sleep(3000)

      // --- 9. Hard data-plane evidence ---------------------------------------
      // Replacement contents + integrity + exact counts (LOCK-622 evidence c).
      assertImportedContents(chatDbPath!)
      await assertSqlIntegrityAndCounts(chatDbPath!)
      // Retained pre-import snapshot + journal/staging cleanup (4434/4436/4438).
      await assertRetainedPreImportSnapshot(dataDir)
      // Empty promoted candidate shells + tmpdir deferred-recovery contract.
      assertOnlyEmptyPromotedCandidateShells(candidateInventoryBefore, dataDir, ownedTmpRoot)
    } catch (error) {
      bodyFailure = error
      throw error
    } finally {
      // ─────────────────────────────────────────────────────────────────────
      // Cleanup (LOCK-624/625, LOCK-C6/T1/T5) — always runs, even on failure.
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
      // LOCK-LUI4: derived fixture cleanup FIRST, then the seed cleanup; both
      // verify exact absence and throw on leftovers (LOCK-T1).
      if (derived) {
        try {
          await derived.cleanup()
          if (fs.existsSync(derived.zipPath)) {
            cleanupErrors.push(`Derived ZIP still exists after cleanup: ${derived.zipPath}`)
          }
          if (fs.existsSync(derived.workDir)) {
            cleanupErrors.push(`Derived work dir still exists after cleanup: ${derived.workDir}`)
          }
        } catch (err) {
          cleanupErrors.push(`finally derived cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (seed) {
        try {
          await seed.cleanup()
          for (const dir of [seed.workDir, seed.profileDir, seed.runtimeProfileDir]) {
            if (fs.existsSync(dir)) {
              cleanupErrors.push(`Seed dir still exists after cleanup: ${dir}`)
            }
          }
          if (fs.existsSync(seed.zipPath)) {
            cleanupErrors.push(`Seed ZIP still exists after cleanup: ${seed.zipPath}`)
          }
        } catch (err) {
          cleanupErrors.push(`finally seed cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (cleanupErrors.length > 0) {
        const bodyNote = bodyFailure
          ? ` (body also failed: ${bodyFailure instanceof Error ? bodyFailure.message : String(bodyFailure)})`
          : ''
        throw new Error(`E2E cleanup failed (${cleanupErrors.length} error(s)): ${cleanupErrors.join('; ')}${bodyNote}`)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Helpers — Redux/UI state readers (bounded duplicates of the genuine spec so
// this file stays independent; no broad helper changes)
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

function topicItem(page: import('@playwright/test').Page, topicId: string) {
  return page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
}

async function clickAssistantsTab(page: import('@playwright/test').Page): Promise<void> {
  const tab = page.getByRole('button', { name: 'Assistants', exact: false })
  await tab.waitFor({ state: 'visible', timeout: 10000 })
  await tab.click()
  await page.waitForTimeout(300)
}

async function clickTopicsTab(page: import('@playwright/test').Page): Promise<void> {
  const tab = page.getByRole('button', { name: 'Topics', exact: false })
  await tab.waitFor({ state: 'visible', timeout: 10000 })
  await tab.click()
  await page.waitForTimeout(300)
}

/**
 * Wait until the main window is usable again after the in-process reload:
 * #root attached, Redux store defined, home ready.
 */
async function waitForMainWindowReady(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('#root', { state: 'attached', timeout: 60000 })
  await page.waitForFunction(() => typeof (window as any).store !== 'undefined', { timeout: 60000 })
  await page.waitForSelector(
    ['#chat', '.inputbar-container', '[class*="Inputbar"]', '[class*="Container"]'].join(', '),
    { state: 'visible', timeout: 60000 }
  )
}

/**
 * Wait until the imported navigation is present in Redux: the first source
 * assistant (a-e2e-1) exists with the visible IDB-matched topic t-e2e-1.
 * This is the authoritative signal that the one-shot projection applied
 * after the reload (LOCK-PROD-6).
 */
async function waitForImportedNavigationInRedux(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    ({ firstAssistantId, topicId }) => {
      const s = (window as any).store?.getState()
      const list = s?.assistants?.assistants
      if (!Array.isArray(list) || list.length === 0) return false
      const first = list.find((a: any) => a.id === firstAssistantId)
      if (!first) return false
      return Array.isArray(first.topics) && first.topics.some((t: any) => t.id === topicId)
    },
    { firstAssistantId: PROJECTION_ASSISTANTS.first.id, topicId: SOURCE_IDS.topic },
    { timeout: 60000 }
  )
}

/** Sidebar/topic UI presence after the same-PID reload (LOCK-LUI3). */
async function assertImportedNavigationUI(page: import('@playwright/test').Page): Promise<void> {
  await clickAssistantsTab(page)
  await expect(
    page.locator('[class*="home-tabs"]').getByText(PROJECTION_ASSISTANTS.first.name, { exact: true }).first(),
    'first imported assistant must be visible after the reload'
  ).toBeVisible()
  await expect(
    page.locator('[class*="home-tabs"]').getByText(PROJECTION_ASSISTANTS.second.name, { exact: true }).first(),
    'second imported assistant must be visible after the reload'
  ).toBeVisible()

  await clickTopicsTab(page)
  const item = topicItem(page, SOURCE_IDS.topic)
  await expect(item, 'the imported topic must be visible in the topic list after the reload').toBeVisible()
  await expect(item, 'the imported topic must carry its projected name').toContainText(PROJECTION_TOPICS.visible.name)
}

// ---------------------------------------------------------------------------
// Helpers — non-materialization proof (LOCK-LUI3)
// ---------------------------------------------------------------------------

/**
 * Recursively scan ONLY the given owned workspace roots and prove the
 * irrelevant `Data/Files/e2e-large/irrelevant-bulk.bin` entry was never
 * materialized: no file with that basename, no `e2e-large` directory, and no
 * path containing the exact relative entry path.
 */
function assertIrrelevantEntryNeverMaterialized(roots: string[]): void {
  const forbiddenBasename = path.basename(DEFAULT_IRRELEVANT_ENTRY_NAME)
  const forbiddenDir = 'e2e-large'
  const forbiddenRelative = DEFAULT_IRRELEVANT_ENTRY_NAME.split('/').join(path.sep)
  const violations: string[] = []
  let scannedRoots = 0
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    scannedRoots += 1
    const walk = (dir: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (error) {
        violations.push(
          `failed to read owned workspace dir ${dir}: ${error instanceof Error ? error.message : String(error)}`
        )
        return
      }
      for (const entry of entries) {
        const child = path.join(dir, entry.name)
        if (entry.isSymbolicLink()) {
          if (entry.name === forbiddenBasename || entry.name === forbiddenDir) {
            violations.push(`symlink named like the irrelevant entry materialized: ${child}`)
          }
          continue
        }
        if (entry.isDirectory()) {
          if (entry.name === forbiddenDir) violations.push(`irrelevant directory materialized: ${child}`)
          walk(child)
        } else if (entry.isFile()) {
          if (entry.name === forbiddenBasename) violations.push(`irrelevant file materialized: ${child}`)
          if (child.includes(forbiddenRelative)) violations.push(`irrelevant relative path materialized: ${child}`)
        }
      }
    }
    walk(root)
  }
  expect(
    scannedRoots,
    'the owned workspace roots (app data dir + owned temp root) must exist to prove non-materialization'
  ).toBeGreaterThan(0)
  expect(
    violations,
    'the 600 MiB irrelevant Data/Files entry must never be materialized under any owned workspace path (LOCK-LUI3)'
  ).toEqual([])
}

// ---------------------------------------------------------------------------
// Helpers — SQLite evidence (post-close)
// ---------------------------------------------------------------------------

function queryRows(dbPath: string, sql: string): Array<Record<string, unknown>> {
  const result = queryChatDbViaElectron(dbPath, sql)
  // LOCK-QDB-5: fail closed on any failure code — never `rows ?? []`.
  if (!result.ok) throw new Error(`SQLite query failed: ${result.code}`)
  return Array.from(result.rows)
}

/** The imported source records must fully replace the target chat.db. */
function assertImportedContents(dbPath: string): void {
  const topicIds = queryRows(dbPath, 'SELECT id FROM topics ORDER BY id').map((r) => String(r.id))
  expect(topicIds, `imported topic ${SOURCE_IDS.topic} must be in the target chat.db`).toContain(SOURCE_IDS.topic)

  const messages = queryRows(dbPath, 'SELECT id, topic_id FROM messages ORDER BY id')
  expect(messages).toContainEqual(expect.objectContaining({ id: TARGET_MESSAGE_ID, topic_id: SOURCE_IDS.topic }))

  const blocks = queryRows(dbPath, 'SELECT id, message_id FROM message_blocks ORDER BY id')
  expect(blocks).toContainEqual(expect.objectContaining({ id: SOURCE_IDS.block, message_id: TARGET_MESSAGE_ID }))

  const segments = queryRows(dbPath, 'SELECT id, topic_id FROM topic_segments ORDER BY id')
  expect(segments).toContainEqual(expect.objectContaining({ id: SOURCE_IDS.segment, topic_id: SOURCE_IDS.topic }))

  const memberships = queryRows(
    dbPath,
    'SELECT segment_id, message_id FROM topic_segment_messages ORDER BY segment_id, sort_order'
  )
  expect(memberships).toContainEqual(
    expect.objectContaining({ segment_id: SOURCE_IDS.segment, message_id: TARGET_MESSAGE_ID })
  )
}

/**
 * LOCK-QDB-12/17: post-close integrity/FK/count/deletedTopics evidence runs
 * through the SAME one-child `verifyChatDbViaElectronWithRetry` plan as the
 * other import specs — no generic separate integrity/count queries. The exact
 * six counts are fixture-safe: the imported source data is exactly 1/1/1/1/1
 * and the source-only f-e2e-1 file row is never persisted to the target DB
 * (LOCK-D7), so file_references is exactly 0. The exact deletedTopics sibling
 * is exactly 0 (LOCK-QDB-18: the disposable seed carries no deleted topics).
 */
async function assertSqlIntegrityAndCounts(dbPath: string): Promise<void> {
  const result = await verifyChatDbViaElectronWithRetry(dbPath)
  if (!result.ok) {
    throw new Error(`post-close chat.db verification failed: ${result.code}`)
  }
  const { integrityOk, foreignKeyViolations, counts, deletedTopics } = result.value
  // LOCK-QDB-7/9: exact one-row integrity 'ok'; FK exactly empty.
  expect(integrityOk, 'post-close SQLite integrity_check must be exactly one row with value ok').toBe(true)
  expect(foreignKeyViolations, 'post-close SQLite foreign_key_check must be exactly empty').toBe(0)
  // LOCK-QDB-18: the disposable large-container fixture carries no deleted
  // topics — the exact sibling from the same readonly snapshot is 0.
  expect(
    deletedTopics,
    'post-close deletedTopics must be exactly 0 (disposable seed has no deleted topics, LOCK-QDB-18)'
  ).toBe(0)
  // Exact fixture-safe counts.
  expect(counts.topics, 'post-close topics count must be exactly the single imported topic').toBe(1)
  expect(counts.messages, 'post-close messages count must be exactly the single imported message').toBe(1)
  expect(counts.message_blocks, 'post-close message_blocks count must be exactly the single imported block').toBe(1)
  expect(counts.topic_segments, 'post-close topic_segments count must be exactly the single imported segment').toBe(1)
  expect(
    counts.topic_segment_messages,
    'post-close membership count must be exactly the single imported membership'
  ).toBe(1)
  expect(
    counts.file_references,
    'post-close file_references must be exactly 0 (source-only diagnostic row, LOCK-D7)'
  ).toBe(0)
}

/**
 * LOCK-SNAP-2: the retained pre-import snapshot must be a regular non-symlink
 * non-empty file AND pass the bounded batched readonly verify plan (integrity
 * exactly one-row ok, FK exactly empty, exact typed six counts). Journal/
 * staging absence messages stay fixed/path-free (fixed artifact names only).
 */
async function assertRetainedPreImportSnapshot(dataDir: string): Promise<void> {
  const snapshotPath = path.join(dataDir, ROLLBACK_SNAPSHOT_FILENAME)
  // LOCK-SNAP-2: regular non-symlink non-empty file (fixed path-free checks).
  assertRetainedSnapshotFile(snapshotPath)

  // LOCK-SNAP-2: bounded readonly batched verify plan on the retained snapshot.
  const snapshotVerify = await verifyChatDbViaElectronWithRetry(snapshotPath)
  if (!snapshotVerify.ok) {
    throw new Error(`retained pre-import snapshot verification failed: ${snapshotVerify.code}`)
  }
  expect(snapshotVerify.value.integrityOk, 'retained pre-import snapshot must pass integrity_check').toBe(true)
  expect(snapshotVerify.value.foreignKeyViolations, 'retained pre-import snapshot must pass foreign_key_check').toBe(0)

  // LOCK-4436/4438: the journal and every staging sibling are durably cleaned
  // after successful recovery.
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
