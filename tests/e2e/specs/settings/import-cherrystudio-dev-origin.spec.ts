/**
 * E2E: L2 Cherry Studio dev-origin ZIP full-flow import (LOCK-DEV-1..8).
 *
 * Covers the complete chain for the L2 compatibility dev-origin path:
 *   1. Reproducibly generate a disposable dev-origin source ZIP (real
 *      Chromium at exact `http://localhost:5173`, natural origin mapping to
 *      `http_localhost_5173.indexeddb.leveldb`, no rename/copy, LOCK-DEV-1/2/8).
 *   2. Seed baseline target chat.db data that the replace-all import MUST
 *      remove (LOCK-623 replace-all semantics).
 *   3. Start an owned Vite dev server on exact port 5173 serving the
 *      chatImport entry point (LOCK-DEV-5). No external prerequisite.
 *   4. Drive `window.api.cherryImport.start(zipPath)` directly (no native
 *      file dialog automation) and observe the status events.
 *   5. Hard terminal evidence (LOCK-622):
 *        a. observed status progression THROUGH `finalizing`;
 *        b. the original target Electron process actually exits;
 *        c. post-exit chat.db contents contain the source records and the
 *           baseline target records are gone;
 *        d. the retained pre-import rollback snapshot still holds the
 *           baseline records and promotion artifacts are cleaned.
 *   6. Assert relaunched process bears exact --user-data-dir token (LOCK-7).
 *   7. finally: terminate the relaunched process PRECISELY by the exact
 *      disposable `--user-data-dir` argv token (LOCK-625) and remove all
 *      disposable source/profile/ZIP dirs (LOCK-624).
 *   8. Stop the owned Vite server (LOCK-DEV-5).
 *
 * LOCK-DEV-3: The target Cherry app must have `app.isPackaged===false` and
 * its import renderer must load from the exact dev URL
 * `http://localhost:5173/src/windows/chatImport/chatImport.html`.
 *
 * LOCK-DEV-4: Dev-origin imports are only supported in unpackaged builds.
 * The standard E2E fixture already runs with `app.isPackaged===false`
 * (electron . against electron-vite output).
 *
 * LOCK-DEV-6: classifyOriginCandidates returns `{ kind: 'dev' }` for the
 * dev-origin ZIP, and the isolated reader loads from the Vite dev server.
 *
 * LOCK-DEV-8: Candidate/temp workspace inventory before/after import.
 *   - <dataDir>/chat-import-candidates: empty promoted shells only
 *     (installCandidate renames chat.db to live; directory shell remains
 *     until age-based orphan recovery — LOCK-4423/4426/4213A).
 *   - os.tmpdir cherry-import-*: deferred-recovery contract (LOCK-L3).
 *
 * Prerequisites:
 *   - A fresh `pnpm build` (standard E2E prerequisite).
 *   - better-sqlite3 rebuilt for the Electron ABI.
 *   - NO external Vite dev server required — this spec owns the Vite lifecycle.
 *
 * Platform: macOS-only (production A-9 gate + `session.fromPath` verified
 * on darwin). Skipped clearly on other platforms.
 *
 * Evidence: B-class pattern — deterministic assertions on authoritative
 * final state (SQLite queries, process exit, filesystem). No visual UI
 * assertions.
 */
import * as fs from 'fs'
import * as path from 'path'

import { expect, getChatDbPath, queryChatDbViaElectron, test } from '../../fixtures/electron.fixture'
import {
  createDisposableDevOriginSeedZip,
  DEV_ORIGIN_DIR,
  SEED_NATIVE_VERSION,
  SOURCE_IDS
} from '../../utils/disposable-dev-origin-seed-zip'
import { assertStateSubsequence, observeImportStatuses, REQUIRED_STATE_CHAIN } from '../../utils/import-status'
import { probeChatImportEntry, startOwnedViteServer } from '../../utils/owned-vite-server'
import { terminateProcessesByUserDataDir, waitForProcessExit } from '../../utils/process-cleanup'
import {
  assertOnlyEmptyPromotedCandidateShells as validateCandidateInventory,
  snapshotCandidateInventory as snapshotOwnedCandidateInventory
} from '../../utils/import-artifact-validation'

/** Baseline target records the replace-all import MUST remove. */
const BASELINE = { topic: 't-baseline-dev-1', message: 'm-baseline-dev-1', block: 'b-baseline-dev-1' } as const

/** Fixed names produced by the promotion pipeline (Phase 4.4). */
const ROLLBACK_SNAPSHOT_FILENAME = 'chat.db.pre-import-backup'
const ROLLBACK_SNAPSHOT_STAGING_FILENAME = 'chat.db.pre-import-backup.staging'
const PROMOTION_JOURNAL_FILENAME = 'chat-import-promotion.journal.json'
const PROMOTION_JOURNAL_STAGING_FILENAME = 'chat-import-promotion.journal.json.staging'

test.describe('Cherry Studio dev-origin ZIP full-flow import', () => {
  test.skip(
    process.platform !== 'darwin',
    'L2 dev-origin import is macOS-only (LOCK-623 + session.fromPath); requires darwin'
  )

  test('imports a disposable dev-origin IndexedDB ZIP, replaces chat.db, and the original process exits', async ({
    electronApp,
    mainWindow,
    userDataDir,
    ownedTmpRoot
  }) => {
    // Finding-9: Enlarge timeout to a justified budget exceeding all sequential
    // phase bounds plus cleanup: fixture launch (120s) + seed generation (120s)
    // + Vite server startup (90s) + import flow (120s) + process exit wait (90s)
    // + termination/cleanup (60s) = 600s max. Use 660s for safety margin.
    test.setTimeout(660000)

    // --- 0. Original process identity + target chat.db location -----------
    const originalPid = electronApp.process().pid
    expect(originalPid, 'original target process pid must be defined').toBeTruthy()
    const originalPidValue = originalPid as number
    const chatDbPath = getChatDbPath()
    expect(chatDbPath, 'fixture must have captured the disposable chat.db path').toBeTruthy()
    const dataDir = path.dirname(chatDbPath!)

    // LOCK-DEV-6: Assert app.isPackaged === false (dev-origin requires unpackaged).
    const appInfo = await mainWindow.evaluate(async () => {
      const api = (window as any).api
      const info = await api.getAppInfo()
      return { isPackaged: info.isPackaged, appDataPath: info.appDataPath }
    })
    expect(appInfo.isPackaged, 'LOCK-DEV-6: dev-origin import requires app.isPackaged === false').toBe(false)

    // Body + cleanup error capture (LOCK-C6).
    let bodyFailure: unknown = null
    const cleanupErrors: string[] = []

    // LOCK-DEV-5: Owned Vite server handle (created later, stopped in finally).
    let viteServer: Awaited<ReturnType<typeof startOwnedViteServer>> | null = null

    // LOCK-L3: Test-owned tmpdir candidates to clean in finally (never pre-existing).
    // LOCK-DEV-8: Snapshot of candidate temp workspaces + chat-import-candidates before import.
    const candidateInventoryBefore = snapshotOwnedCandidateInventory(dataDir!, ownedTmpRoot)

    try {
      // --- 1. Baseline target data (proves replace-all, LOCK-623) -----------
      await seedBaselineTarget(mainWindow)
      const baselineTopicExists = await mainWindow.evaluate(
        (topicId) => (window as any).api.chatDb.topicExists({ topicId }),
        BASELINE.topic
      )
      expect(baselineTopicExists?.ok).toBe(true)
      expect(baselineTopicExists?.value, `baseline topic ${BASELINE.topic} must exist before import`).toBe(true)

      const baselineFetch = await mainWindow.evaluate(
        (topicId) => (window as any).api.chatDb.fetchMessages({ topicId }),
        BASELINE.topic
      )
      expect(baselineFetch?.ok, `fetchMessages for baseline failed: ${JSON.stringify(baselineFetch)}`).toBe(true)
      const baselineMessages = (baselineFetch?.value?.messages ?? []) as Array<Record<string, unknown>>
      const baselineBlocks = (baselineFetch?.value?.blocks ?? []) as Array<Record<string, unknown>>
      expect(
        baselineMessages.some((m) => m.id === BASELINE.message),
        `baseline message ${BASELINE.message} must exist before import`
      ).toBe(true)
      expect(
        baselineBlocks.some((b) => b.id === BASELINE.block),
        `baseline block ${BASELINE.block} must exist before import`
      ).toBe(true)

      // --- 2. Disposable dev-origin source ZIP (LOCK-DEV-1/2/8) ---------------
      const seed = await createDisposableDevOriginSeedZip(ownedTmpRoot)
      try {
        // Source evidence: exactly what is documented, nothing more.
        expect(seed.evidence.nativeVersion).toBe(SEED_NATIVE_VERSION)
        for (const store of ['topics', 'message_blocks', 'topic_segments', 'files']) {
          expect(seed.evidence.stores).toContain(store)
        }
        expect(seed.evidence.verifiedKeys.topics).toContain(SOURCE_IDS.topic)
        expect(seed.evidence.embeddedMessageIds).toContain(SOURCE_IDS.message)
        expect(seed.evidence.verifiedKeys.message_blocks).toContain(SOURCE_IDS.block)
        expect(seed.evidence.verifiedKeys.topic_segments).toContain(SOURCE_IDS.segment)
        expect(seed.evidence.verifiedKeys.files).toContain(SOURCE_IDS.file)
        expect(seed.evidence.ldbFileCount).toBeGreaterThanOrEqual(1)

        // LOCK-DEV-2: Origin directory must be EXACTLY the dev origin.
        expect(seed.evidence.originDir, 'origin directory must be the dev origin').toBe(DEV_ORIGIN_DIR)

        // LOCK-DEV-8: No file-origin entries in the ZIP.
        expect(
          seed.evidence.zipAllEntriesUnderOrigin,
          'every ZIP IndexedDB/ entry must be under the expected dev origin'
        ).toBe(true)
        expect(
          seed.evidence.zipLdbEntryCount,
          'ZIP must contain at least one .ldb entry inside the dev origin'
        ).toBeGreaterThanOrEqual(1)
        console.log('[E2E] Dev-origin seed ZIP evidence:', JSON.stringify(seed.evidence, null, 2))

        // --- 3. Start owned Vite dev server (LOCK-DEV-5) ---------------------
        // The seed server has fully stopped and port is free. Now acquire it
        // with our owned Vite server for the import reader.
        // Finding-2: __dirname is tests/e2e/specs/settings → 4 levels up to repo root.
        const projectRoot = path.resolve(__dirname, '..', '..', '..', '..')
        // Validate expected files exist before spawning.
        expect(
          fs.existsSync(path.join(projectRoot, 'package.json')),
          `repo root must contain package.json: ${projectRoot}`
        ).toBe(true)
        expect(
          fs.existsSync(path.join(projectRoot, 'electron.vite.config.ts')),
          `repo root must contain electron.vite.config.ts: ${projectRoot}`
        ).toBe(true)
        viteServer = await startOwnedViteServer(projectRoot, ownedTmpRoot)

        // Finding-4: Verify the chatImport entry point via Node-side HTTP
        // probe, NOT renderer page fetch (CORS-sensitive).
        const entryProbe = await probeChatImportEntry()
        expect(
          entryProbe.ok,
          `chatImport entry point not accessible at http://localhost:5173/src/windows/chatImport/chatImport.html: ` +
            `status=${entryProbe.status}`
        ).toBe(true)
        console.log(`[E2E] Owned Vite server verified: chatImport accessible (HTTP ${entryProbe.status})`)

        // --- 4. Observe statuses, then start the import -----------------------
        const observer = await observeImportStatuses(mainWindow)
        const startResult = await mainWindow.evaluate(
          (zipPath) => (window as any).api.cherryImport.start(zipPath),
          seed.zipPath
        )
        expect(startResult?.ok, `cherryImport.start failed: ${JSON.stringify(startResult)}`).toBe(true)
        expect(typeof startResult.sessionId).toBe('string')
        const sessionId = startResult.sessionId as string
        observer.setSessionId(sessionId)

        // --- 5. Status progression THROUGH finalizing (LOCK-622 evidence a) ---
        const finalizing = await observer.waitForState('finalizing', 120000)
        expect(finalizing.state).toBe('finalizing')
        const observed = await observer.getStates()
        const stateNames = observed.map((s) => s.state)
        const chainError = assertStateSubsequence(stateNames, REQUIRED_STATE_CHAIN)
        expect(chainError, chainError ?? undefined).toBeNull()

        // `promoted` races app.exit(0) and is best-effort only (LOCK-622).
        const promotedIndex = stateNames.indexOf('promoted')
        if (promotedIndex !== -1) {
          expect(promotedIndex).toBeGreaterThan(stateNames.indexOf('finalizing'))
        }
        console.log(`[E2E] Observed dev-origin import states: ${stateNames.join(' -> ')}`)

        // f-e2e-dev-1 evidence: candidate construction stats from candidate-ready.
        const ready = observed.find((s) => s.state === 'candidate-ready')
        expect(ready?.stats, 'candidate-ready event must carry CandidateImportStats').toBeTruthy()
        expect(ready?.stats?.topicCount).toBe(1)
        expect(ready?.stats?.messageCount).toBe(1)
        expect(ready?.stats?.blockCount).toBe(1)
        expect(ready?.stats?.segmentCount).toBe(1)
        expect(ready?.stats?.segmentMembershipCount).toBe(1)

        // --- 6. Original target process exit (LOCK-622 evidence b) ------------
        const exited = await waitForProcessExit(originalPidValue, 90000)
        expect(exited, `original target process ${originalPidValue} did not exit within 90s`).toBe(true)
        console.log(`[E2E] Original target process ${originalPidValue} exited (hard terminal evidence)`)

        // --- 7. Terminate the relaunched process by exact token (LOCK-625) ----
        // LOCK-7: Require observation of at least one relaunched process.
        const termination = await terminateProcessesByUserDataDir(userDataDir, originalPidValue)
        expect(
          termination.killedPids.length,
          'LOCK-7: at least one relaunched process bearing the exact --user-data-dir token must be observed'
        ).toBeGreaterThan(0)
        console.log(`[E2E] Terminated relaunched process(es) by profile token: ${termination.killedPids.join(', ')}`)
        expect(
          termination.remainingPids,
          `processes still alive for disposable profile token: ${termination.remainingPids.join(', ')}`
        ).toEqual([])
        expect(termination.errors).toEqual([])

        // --- 7.5 Stop owned Vite server before DB verification (LOCK-DEV-5).
        // The Vite server is only needed for the import reader. Leaving it
        // alive through DB verification risks port contention and is
        // unnecessary. stop() is idempotent — the finally block may call it
        // again safely.
        if (viteServer) {
          try {
            await viteServer.stop()
          } catch (err) {
            cleanupErrors.push(`Vite server stop failed: ${err instanceof Error ? err.message : String(err)}`)
          }
          viteServer = null
        }

        // --- 8. Post-exit chat.db replacement contents (LOCK-622 evidence c) --
        assertReplacementContents(chatDbPath!)

        // --- 9. Retained pre-import snapshot + journal cleanup (LOCK-4434/36/38)
        assertRetainedPreImportSnapshot(dataDir)

        // --- 10. LOCK-DEV-8 + LOCK-L3: Candidate workspace inventory --------
        // <dataDir>/chat-import-candidates: empty promoted shells only
        // (installCandidate renames chat.db to live; directory shell remains
        // until age-based orphan recovery — LOCK-4423/4426/4213A).
        // Owned tmp root cherry-import-*: deferred-recovery contract — capture exact
        // new paths for E2E-owned cleanup in finally.
        validateCandidateInventory(candidateInventoryBefore, dataDir, ownedTmpRoot)
      } finally {
        // LOCK-625/624: always clean up — relaunched process by exact token,
        // then the disposable seed profile + ZIP/work dirs. The fixture owns
        // root removal; the seed cleanup verifies its own artifacts and the
        // spec inventories only ownedTmpRoot (never global temp paths).
        try {
          const leftover = await terminateProcessesByUserDataDir(userDataDir, originalPidValue)
          if (leftover.remainingPids.length > 0) {
            cleanupErrors.push(`Relaunched processes remained after finally: ${leftover.remainingPids.join(', ')}`)
          }
          if (leftover.errors.length > 0) {
            cleanupErrors.push(`Process cleanup errors: ${leftover.errors.join('; ')}`)
          }
        } catch (err) {
          cleanupErrors.push(`finally process cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        try {
          // seed.cleanup() closes + exact-cleans the seed profile, then removes
          // the nested seed artifacts and verifies absence; it throws on any
          // leftover (LOCK-T1).
          await seed.cleanup()
        } catch (err) {
          cleanupErrors.push(`finally seed cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
        }

        // LOCK-DEV-5: Stop owned Vite server in finally.
        if (viteServer) {
          try {
            await viteServer.stop()
          } catch (err) {
            cleanupErrors.push(`Vite server stop failed: ${err instanceof Error ? err.message : String(err)}`)
          }
          viteServer = null
        }
      }
    } catch (error) {
      bodyFailure = error
      throw error
    } finally {
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
// Helpers
// ---------------------------------------------------------------------------

async function seedBaselineTarget(page: import('@playwright/test').Page): Promise<void> {
  const appended = await page.evaluate(async () => {
    const chatDb = (window as any).api.chatDb
    const createdAt = '2026-07-30T00:00:00.000Z'
    const message = {
      id: 'm-baseline-dev-1',
      role: 'user',
      status: 'success',
      content: 'baseline dev-origin target message',
      createdAt,
      topicId: 't-baseline-dev-1',
      blocks: ['b-baseline-dev-1']
    }
    const blocks = [
      {
        id: 'b-baseline-dev-1',
        messageId: 'm-baseline-dev-1',
        type: 'text',
        status: 'success',
        content: 'baseline dev-origin target block',
        createdAt
      }
    ]
    return chatDb.appendMessage({ topicId: 't-baseline-dev-1', message, blocks })
  })
  expect(appended?.ok, `baseline appendMessage failed: ${JSON.stringify(appended)}`).toBe(true)
}

function queryRows(dbPath: string, sql: string): Array<Record<string, unknown>> {
  const result = queryChatDbViaElectron(dbPath, sql)
  expect(result?.ok, `SQLite query failed for ${dbPath}: ${JSON.stringify(result)}`).toBe(true)
  return (result?.rows as Array<Record<string, unknown>> | undefined) ?? []
}

function assertReplacementContents(dbPath: string): void {
  const topicIds = queryRows(dbPath, 'SELECT id FROM topics ORDER BY id').map((r) => String(r.id))
  expect(topicIds).toContain(SOURCE_IDS.topic)
  expect(topicIds).not.toContain(BASELINE.topic)

  const messages = queryRows(dbPath, 'SELECT id, topic_id FROM messages ORDER BY id')
  expect(messages).toContainEqual(expect.objectContaining({ id: SOURCE_IDS.message, topic_id: SOURCE_IDS.topic }))
  expect(messages.map((r) => String(r.id))).not.toContain(BASELINE.message)

  const blocks = queryRows(dbPath, 'SELECT id, message_id FROM message_blocks ORDER BY id')
  expect(blocks).toContainEqual(expect.objectContaining({ id: SOURCE_IDS.block, message_id: SOURCE_IDS.message }))
  expect(blocks.map((r) => String(r.id))).not.toContain(BASELINE.block)

  const segments = queryRows(dbPath, 'SELECT id, topic_id FROM topic_segments ORDER BY id')
  expect(segments).toContainEqual(expect.objectContaining({ id: SOURCE_IDS.segment, topic_id: SOURCE_IDS.topic }))

  // LOCK-T4: the installed segment→message membership relation must exist.
  const memberships = queryRows(
    dbPath,
    'SELECT segment_id, message_id FROM topic_segment_messages ORDER BY segment_id, sort_order'
  )
  expect(memberships).toContainEqual(
    expect.objectContaining({ segment_id: SOURCE_IDS.segment, message_id: SOURCE_IDS.message })
  )
  expect(memberships.map((r) => String(r.message_id))).not.toContain(BASELINE.message)
}

function assertRetainedPreImportSnapshot(dataDir: string): void {
  const snapshotPath = path.join(dataDir, ROLLBACK_SNAPSHOT_FILENAME)
  expect(fs.existsSync(snapshotPath), `retained pre-import snapshot missing at ${snapshotPath}`).toBe(true)

  // The snapshot is the pre-import live DB: it must still hold the baseline
  // target records and must NOT contain the imported source records.
  const snapshotTopicIds = queryRows(snapshotPath, 'SELECT id FROM topics ORDER BY id').map((r) => String(r.id))
  expect(snapshotTopicIds).toContain(BASELINE.topic)
  expect(snapshotTopicIds).not.toContain(SOURCE_IDS.topic)

  const snapshotMessageIds = queryRows(snapshotPath, 'SELECT id FROM messages ORDER BY id').map((r) => String(r.id))
  expect(snapshotMessageIds).toContain(BASELINE.message)
  expect(snapshotMessageIds).not.toContain(SOURCE_IDS.message)

  const snapshotBlockIds = queryRows(snapshotPath, 'SELECT id FROM message_blocks ORDER BY id').map((r) => String(r.id))
  expect(snapshotBlockIds).toContain(BASELINE.block)
  expect(snapshotBlockIds).not.toContain(SOURCE_IDS.block)

  // LOCK-4436/4438: the journal and every staging sibling are durably cleaned.
  for (const artifactName of [
    PROMOTION_JOURNAL_FILENAME,
    PROMOTION_JOURNAL_STAGING_FILENAME,
    ROLLBACK_SNAPSHOT_STAGING_FILENAME
  ]) {
    const artifactPath = path.join(dataDir, artifactName)
    expect(
      fs.existsSync(artifactPath),
      `promotion artifact should be absent after successful recovery: ${artifactPath}`
    ).toBe(false)
  }
}
