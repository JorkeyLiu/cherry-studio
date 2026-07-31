/**
 * E2E: L2 Cherry Studio genuine-ZIP full-flow import (LOCK-621..625).
 *
 * Covers the complete chain with disposable profiles only:
 *   1. Reproducibly generate a disposable source ZIP (real Electron + real
 *      production Dexie-created IndexedDB, v11/native 110, closed/flushed,
 *      `IndexedDB/` tree only) — explicitly a SYNTHETIC seed, never claimed
 *      to be a historical user backup (LOCK-621).
 *   2. Seed baseline target chat.db data that the replace-all import MUST
 *      remove (LOCK-623 replace-all semantics).
 *   3. Drive `window.api.cherryImport.start(zipPath)` directly (no native
 *      file dialog automation) and observe the status events.
 *   4. Hard terminal evidence (LOCK-622):
 *        a. observed status progression THROUGH `finalizing`
 *           (`promoted` is best-effort only and never required);
 *        b. the original target Electron process actually exits;
 *        c. post-exit chat.db contents contain the source records (incl. the
 *           installed topic_segment_messages relation, LOCK-T4) and the
 *           baseline target records are gone;
 *        d. the retained pre-import rollback snapshot still holds the
 *           baseline topic/message/block (LOCK-4434) and the promotion
 *           journal plus every .staging sibling is cleaned (LOCK-4436/4438).
 *   5. finally: terminate the relaunched process PRECISELY by the exact
 *      disposable `--user-data-dir` argv token (LOCK-625, never broad
 *      Electron process killing or substring matching) and remove all
 *      disposable source/profile/ZIP dirs (LOCK-624). Cleanup failures and
 *      leftover exact paths fail the test (LOCK-T1/T5).
 *
 * Platform: macOS-only (production A-9 gate + `session.fromPath` verified on
 * darwin). Skipped clearly on other platforms.
 *
 * Prerequisite (owned by the main validation phase): a fresh build including
 * the chatImport window entry, and better-sqlite3 rebuilt for the Electron
 * ABI so `queryChatDbViaElectron` (post-exit file reads) can load the native
 * module under the Electron binary. In-app reads (chatDb IPC) work regardless.
 */
import * as fs from 'fs'
import * as path from 'path'

import { expect, getChatDbPath, queryChatDbViaElectron, test } from '../../fixtures/electron.fixture'
import { createDisposableSeedZip, SEED_NATIVE_VERSION, SOURCE_IDS } from '../../utils/disposable-seed-zip'
import { assertStateSubsequence, observeImportStatuses, REQUIRED_STATE_CHAIN } from '../../utils/import-status'
import { terminateProcessesByUserDataDir, waitForProcessExit } from '../../utils/process-cleanup'

/** Baseline target records the replace-all import MUST remove. */
const BASELINE = { topic: 't-baseline-1', message: 'm-baseline-1', block: 'b-baseline-1' } as const

/** Fixed names produced by the promotion pipeline (Phase 4.4). */
const ROLLBACK_SNAPSHOT_FILENAME = 'chat.db.pre-import-backup'
const ROLLBACK_SNAPSHOT_STAGING_FILENAME = 'chat.db.pre-import-backup.staging'
const PROMOTION_JOURNAL_FILENAME = 'chat-import-promotion.journal.json'
const PROMOTION_JOURNAL_STAGING_FILENAME = 'chat-import-promotion.journal.json.staging'

test.describe('Cherry Studio genuine ZIP full-flow import', () => {
  test.skip(
    process.platform !== 'darwin',
    'L2 import is macOS-only (LOCK-623); full-flow E2E requires darwin and session.fromPath behavior'
  )

  test('imports a disposable IndexedDB ZIP, replaces chat.db, and the original process exits', async ({
    electronApp,
    mainWindow,
    userDataDir
  }) => {
    // The full chain (fixture launch + seed generation + import + exit +
    // post-exit verification) exceeds the 60s default timeout.
    test.setTimeout(300000)

    // --- 0. Original process identity + target chat.db location -----------
    const originalPid = electronApp.process().pid
    expect(originalPid, 'original target process pid must be defined').toBeTruthy()
    const originalPidValue = originalPid as number
    const chatDbPath = getChatDbPath()
    expect(chatDbPath, 'fixture must have captured the disposable chat.db path').toBeTruthy()
    const dataDir = path.dirname(chatDbPath!)

    // Body + cleanup error capture (LOCK-C6: cleanup failure is a test failure,
    // never a warning; a body failure is preserved for diagnosis).
    let bodyFailure: unknown = null
    const cleanupErrors: string[] = []

    try {
      // --- 1. Baseline target data (proves replace-all, LOCK-623) -----------
      await seedBaselineTarget(mainWindow)
      // LOCK-T4: the baseline topic, message AND block must all exist before
      // the import so the replace-all semantics are provable afterwards.
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

      // --- 2. Disposable source ZIP (LOCK-621) -------------------------------
      const seed = await createDisposableSeedZip()
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
        // f-e2e-1 is a source-only count-diagnostic row (LOCK-D7): it must be
        // present in the source ZIP, and it is NOT persisted to the target DB.
        expect(seed.evidence.verifiedKeys.files).toContain(SOURCE_IDS.file)
        expect(seed.evidence.ldbFileCount).toBeGreaterThanOrEqual(1)
        // LOCK-T4: the ZIP is production-format — every IndexedDB/ entry is
        // under the expected origin directory and at least one .ldb table file
        // lives inside it (intake Layer 4 would reject anything else).
        expect(seed.evidence.zipEntryCount).toBeGreaterThan(0)
        expect(
          seed.evidence.zipAllEntriesUnderOrigin,
          'every ZIP IndexedDB/ entry must be under the expected origin'
        ).toBe(true)
        expect(
          seed.evidence.zipLdbEntryCount,
          'ZIP must contain at least one .ldb entry inside the origin'
        ).toBeGreaterThanOrEqual(1)
        console.log('[E2E] Seed ZIP evidence:', JSON.stringify(seed.evidence, null, 2))

        // --- 3. Observe statuses, then start the import -----------------------
        const observer = await observeImportStatuses(mainWindow)
        const startResult = await mainWindow.evaluate(
          (zipPath) => (window as any).api.cherryImport.start(zipPath),
          seed.zipPath
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

        // `promoted` races app.exit(0) and is best-effort only (LOCK-622):
        // when observed it must come strictly after finalizing.
        const promotedIndex = stateNames.indexOf('promoted')
        if (promotedIndex !== -1) {
          expect(promotedIndex).toBeGreaterThan(stateNames.indexOf('finalizing'))
        }
        console.log(`[E2E] Observed import states: ${stateNames.join(' -> ')}`)

        // f-e2e-1 evidence: candidate construction stats from candidate-ready.
        const ready = observed.find((s) => s.state === 'candidate-ready')
        expect(ready?.stats, 'candidate-ready event must carry CandidateImportStats').toBeTruthy()
        expect(ready?.stats?.topicCount).toBe(1)
        expect(ready?.stats?.messageCount).toBe(1)
        expect(ready?.stats?.blockCount).toBe(1)
        expect(ready?.stats?.segmentCount).toBe(1)
        expect(ready?.stats?.segmentMembershipCount).toBe(1)

        // --- 5. Original target process exit (LOCK-622 evidence b) ------------
        const exited = await waitForProcessExit(originalPidValue, 90000)
        expect(exited, `original target process ${originalPidValue} did not exit within 90s`).toBe(true)
        console.log(`[E2E] Original target process ${originalPidValue} exited (hard terminal evidence)`)

        // --- 6. Terminate the relaunched process by exact token (LOCK-625) ----
        const termination = await terminateProcessesByUserDataDir(userDataDir, originalPidValue)
        if (termination.killedPids.length > 0) {
          console.log(`[E2E] Terminated relaunched process(es) by profile token: ${termination.killedPids.join(', ')}`)
        } else {
          console.warn('[E2E] No relaunched process was observed for the disposable token')
        }
        expect(
          termination.remainingPids,
          `processes still alive for disposable profile token: ${termination.remainingPids.join(', ')}`
        ).toEqual([])
        expect(termination.errors).toEqual([])

        // --- 7. Post-exit chat.db replacement contents (LOCK-622 evidence c) --
        assertReplacementContents(chatDbPath!)

        // --- 8. Retained pre-import snapshot + journal cleanup (LOCK-4434/36/38)
        assertRetainedPreImportSnapshot(dataDir)
      } finally {
        // LOCK-625/624: always clean up — relaunched process by token, then the
        // disposable seed profile + ZIP/work dirs. LOCK-C6: cleanup failure is
        // a test failure; errors are accumulated and thrown after the body.
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
          // LOCK-T1: cleanup failures must fail the test. seed.cleanup()
          // throws on unresolved owned resources, and every exact seed path
          // is verified absent afterwards.
          await seed.cleanup()
          for (const dir of [seed.workDir, seed.profileDir, seed.profileDevDir]) {
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
      id: 'm-baseline-1',
      role: 'user',
      status: 'success',
      content: 'baseline target message',
      createdAt,
      topicId: 't-baseline-1',
      blocks: ['b-baseline-1']
    }
    const blocks = [
      {
        id: 'b-baseline-1',
        messageId: 'm-baseline-1',
        type: 'text',
        status: 'success',
        content: 'baseline target block',
        createdAt
      }
    ]
    return chatDb.appendMessage({ topicId: 't-baseline-1', message, blocks })
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
  // target records and must NOT contain the imported source records
  // (LOCK-T4: topic, message AND block in both directions).
  const snapshotTopicIds = queryRows(snapshotPath, 'SELECT id FROM topics ORDER BY id').map((r) => String(r.id))
  expect(snapshotTopicIds).toContain(BASELINE.topic)
  expect(snapshotTopicIds).not.toContain(SOURCE_IDS.topic)

  const snapshotMessageIds = queryRows(snapshotPath, 'SELECT id FROM messages ORDER BY id').map((r) => String(r.id))
  expect(snapshotMessageIds).toContain(BASELINE.message)
  expect(snapshotMessageIds).not.toContain(SOURCE_IDS.message)

  const snapshotBlockIds = queryRows(snapshotPath, 'SELECT id FROM message_blocks ORDER BY id').map((r) => String(r.id))
  expect(snapshotBlockIds).toContain(BASELINE.block)
  expect(snapshotBlockIds).not.toContain(SOURCE_IDS.block)

  // LOCK-4436/4438: the journal and every staging sibling are durably cleaned
  // before relaunch (LOCK-T4 — journal AND .staging absence).
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
