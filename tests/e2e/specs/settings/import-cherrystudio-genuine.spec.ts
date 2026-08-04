/**
 * E2E: L2 Cherry Studio genuine-ZIP full-flow import — complete post-import
 * UI lifecycle (LOCK-621..625, LOCK-UI1..UI5, LOCK-PROD-2/3/5/6/7).
 *
 * Turns the genuine L2 import from SQL/process-only evidence into standard
 * UI evidence while keeping the existing data-plane hard evidence:
 *
 *   1. Reproducibly generate a disposable source ZIP (real Electron + real
 *      production Dexie-created IndexedDB, v11/native 110, closed/flushed,
 *      `IndexedDB/` + `Local Storage/leveldb/` trees only) — explicitly a
 *      SYNTHETIC seed, never claimed to be a historical user backup
 *      (LOCK-621). The Local Storage projection carries deterministic
 *      navigation metadata: two source assistants in order, one IDB-matching
 *      visible topic under the outer container (despite a DELIBERATELY STALE
 *      inner assistantId), and an LS-only deleted topic (LOCK-E3/E4, LOCK-UI3).
 *   2. Seed baseline target chat.db data + a deterministic Redux/UI target
 *      marker topic that the replace-all import MUST remove (LOCK-623,
 *      LOCK-UI3 — pre-import marker present, post-import absent).
 *   3. Drive `window.api.cherryImport.start(zipPath)` directly and observe
 *      the status events THROUGH `finalizing` (LOCK-622 evidence a) with the
 *      candidate-ready data-plane counts 1/1/1/1/1 (LOCK-UI3).
 *   4. LOCK-UI1: the import completes with an IN-PROCESS main renderer
 *      reload (LOCK-PROD-7 non-packaged restart) — the original PID stays
 *      alive; no app.relaunch/process exit is expected. Wait for the real
 *      main window + Redux rehydration, then wait for the one-shot
 *      navigation projection apply (LOCK-PROD-6).
 *   5. Post-import UI assertions (LOCK-UI3/UI4): marker absent, source
 *      assistant order/names, visible topic name/ownership/order/pinned
 *      state, LS-only deleted topic absent, no recovered shell for this
 *      fixture, and the historical message visible after opening the
 *      imported topic.
 *   6. Post-import send (LOCK-UI4): send a deterministic message through the
 *      real inputbar against the existing mock provider, wait for
 *      completion, assert the user + assistant response persisted. The
 *      completion mutates the topic's updatedAt to a fresh ISO timestamp
 *      (LOCK-TF2): capture the settled post-send value, assert it is a valid
 *      ISO timestamp later than the source projection updatedAt, and carry it
 *      into the post-restart navigation assertion. (BEFORE the send the
 *      timestamps are asserted EXACTLY equal to the source projection —
 *      LOCK-TF1.)
 *   7. Close the ENTIRE app (fixture-owned close + exact-token cleanup,
 *      LOCK-625) and relaunch a fresh Electron instance against the SAME
 *      disposable `--user-data-dir`; re-assert the imported navigation (the
 *      captured post-send updatedAt rehydrates unchanged, LOCK-TF2, while
 *      createdAt stays exactly on the source projection, LOCK-TF1) and that
 *      BOTH the historical and the new messages remain.
 *   8. Keep the existing post-close SQLite integrity evidence: replacement
 *      contents (LOCK-622 evidence c), retained pre-import snapshot +
 *      journal/staging cleanup (LOCK-4434/4436/4438), plus the new
 *      post-import message rows.
 *   9. finally: close the relaunched instance PRECISELY by the exact
 *      disposable `--user-data-dir` argv token and remove all disposable
 *      source/profile/ZIP dirs (LOCK-624). Cleanup failures and leftover
 *      exact paths fail the test (LOCK-C6/T1/T5).
 *
 * Platform: macOS-only (production A-9 gate + `session.fromPath` verified on
 * darwin). Skipped clearly on other platforms.
 *
 * Prerequisite (owned by the main validation phase): a fresh build including
 * the chatImport window entry, the LOCK-PROD-7 in-process reload, and the
 * navigation projection apply; better-sqlite3 rebuilt for the Electron ABI
 * so `queryChatDbViaElectron` (post-close file reads) can load the native
 * module under the Electron binary.
 */
import * as fs from 'fs'
import * as path from 'path'

import {
  clearRequestLog,
  expect,
  findProductRequestAfter,
  getChatDbPath,
  getRequestSequence,
  queryChatDbViaElectron,
  test,
  verifyChatDbViaElectronWithRetry
} from '../../fixtures/electron.fixture'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import {
  createDisposableSeedZip,
  PROJECTION_ASSISTANTS,
  PROJECTION_TOPICS,
  SEED_NATIVE_VERSION,
  SOURCE_IDS,
  STALE_TOPIC_ASSISTANT_ID
} from '../../utils/disposable-seed-zip'
import { expectedMessageTargetId } from '../../utils/expected-message-id'
import { assertStateSubsequence, observeImportStatuses, REQUIRED_STATE_CHAIN } from '../../utils/import-status'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { relaunchSameProfile } from '../../utils/restart-electron-profile'
import { assertRetainedSnapshotFile } from '../../utils/snapshot-file'
import { sleep } from '../../utils/wait-helpers'

/** Baseline target records the replace-all import MUST remove. */
const BASELINE = { topic: 't-baseline-1', message: 'm-baseline-1', block: 'b-baseline-1' } as const

/**
 * LOCK-MID-1/2 + LOCK-E2E-1: the imported source message does NOT retain its
 * legacy id. Every occurrence maps to the deterministic target
 * `l2m1:<sha256>` of `(outerTopicId, legacyMessageId)` — all message-identity
 * assertions (Redux/UI containers and SQLite `messages.id`,
 * `message_blocks.message_id`, `topic_segment_messages.message_id`) must
 * expect the DERIVED target. Source-side seed evidence (verifiedKeys,
 * embeddedMessageIds) legitimately keeps the legacy `SOURCE_IDS.message`.
 */
const TARGET_MESSAGE_ID = expectedMessageTargetId(SOURCE_IDS.topic, SOURCE_IDS.message)

/**
 * Deterministic pre-import target marker topic (LOCK-UI3). Created in Redux
 * (visible in the sidebar) AND persisted to SQLite before the import; the
 * replace-all import must remove it from both planes.
 */
const MARKER = { topic: 't-marker-e2e', name: 'Marker Topic' } as const

/** Deterministic post-import message sent through the mock provider (LOCK-UI4). */
const POST_IMPORT_MESSAGE = 'E2E post-import message: imported topic survives restart'

/** The reserved recovered-conversations shell assistant id (LOCK-PROD-4). */
const RECOVERED_SHELL_ASSISTANT_ID = 'import-recovered-conversations'

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

  test('imports a disposable IndexedDB ZIP, replaces chat.db, reloads in-process, and survives a same-profile restart', async ({
    electronApp,
    mainWindow,
    userDataDir,
    ownedTmpRoot,
    mockPort
  }) => {
    // Fixture launch + seed generation + import + in-process reload + UI
    // lifecycle + send + full close + same-profile relaunch + re-assertions
    // exceed the 60s default and the previous 300s budget.
    test.setTimeout(600000)
    const page = mainWindow

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
    let seed: Awaited<ReturnType<typeof createDisposableSeedZip>> | null = null
    let observer: Awaited<ReturnType<typeof observeImportStatuses>> | null = null
    let relaunched: Awaited<ReturnType<typeof relaunchSameProfile>> | null = null

    try {
      // ─────────────────────────────────────────────────────────────────────
      // 0. Pre-import marker + deterministic target marker topic (LOCK-UI3)
      // ─────────────────────────────────────────────────────────────────────
      // Reload detection marker: the in-process reload (LOCK-PROD-7) resets
      // the page context, so the marker vanishing proves the reload ran
      // (LOCK-UI1). Set BEFORE the import starts.
      await page.evaluate(() => {
        ;(window as any).__e2ePreImportMarker = true
      })

      // Deterministic marker topic in Redux (visible in the sidebar) AND
      // SQLite (data plane) — the replace-all import must remove it from both.
      await createMarkerTopic(page, MARKER.topic, MARKER.name)
      expect(
        await topicExistsInRedux(page, MARKER.topic),
        `marker ${MARKER.topic} must be in Redux before import`
      ).toBe(true)
      await clickTopicsTab(page)
      await expect(
        topicItem(page, MARKER.topic),
        `marker topic must be visible in the sidebar before import`
      ).toBeVisible()
      const markerBeforeSql = await page.evaluate(
        (topicId) => (window as any).api.chatDb.topicExists({ topicId }),
        MARKER.topic
      )
      expect(markerBeforeSql?.value, `marker topic ${MARKER.topic} must exist in SQLite before import`).toBe(true)

      // --- 1. Baseline target data (proves replace-all, LOCK-623) -----------
      await seedBaselineTarget(page)
      // LOCK-T4: the baseline topic, message AND block must all exist before
      // the import so the replace-all semantics are provable afterwards.
      const baselineTopicExists = await page.evaluate(
        (topicId) => (window as any).api.chatDb.topicExists({ topicId }),
        BASELINE.topic
      )
      expect(baselineTopicExists?.ok).toBe(true)
      expect(baselineTopicExists?.value, `baseline topic ${BASELINE.topic} must exist before import`).toBe(true)

      const baselineFetch = await page.evaluate(
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
      seed = await createDisposableSeedZip(ownedTmpRoot)
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
      // LOCK-E3: the ZIP carries the Local Storage leveldb projection subtree.
      expect(seed.evidence.zipHasLocalStorage, 'ZIP must contain Local Storage/leveldb').toBe(true)
      expect(seed.evidence.persistKey, 'seed must carry the persist:cherry-studio key').toBe('persist:cherry-studio')
      expect(seed.evidence.projectionAssistantCount).toBe(2)
      expect(seed.evidence.projectionTopicCount).toBe(2)
      console.log('[E2E] Seed ZIP evidence:', JSON.stringify(seed.evidence, null, 2))

      // --- 3. Observe statuses, then start the import -----------------------
      observer = await observeImportStatuses(page)
      const startResult = await page.evaluate(
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

      // `promoted` races the reload and is best-effort only (LOCK-622):
      // when observed it must come strictly after finalizing.
      const promotedIndex = stateNames.indexOf('promoted')
      if (promotedIndex !== -1) {
        expect(promotedIndex).toBeGreaterThan(stateNames.indexOf('finalizing'))
      }
      console.log(`[E2E] Observed import states: ${stateNames.join(' -> ')}`)

      // f-e2e-1 evidence: candidate construction stats from candidate-ready.
      // LOCK-UI3: the data-plane counts remain 1/1/1/1/1 (one IDB topic, one
      // embedded message, one block, one segment, one membership).
      const ready = observed.find((s) => s.state === 'candidate-ready')
      expect(ready?.stats, 'candidate-ready event must carry CandidateImportStats').toBeTruthy()
      expect(ready?.stats?.topicCount).toBe(1)
      expect(ready?.stats?.messageCount).toBe(1)
      expect(ready?.stats?.blockCount).toBe(1)
      expect(ready?.stats?.segmentCount).toBe(1)
      expect(ready?.stats?.segmentMembershipCount).toBe(1)

      // --- 5. In-process reload — same PID stays alive (LOCK-UI1) ------------
      // LOCK-UI1: non-packaged/E2E completes via an in-process main renderer
      // reload (LOCK-PROD-7), NOT app.relaunch/process exit. The original PID
      // must survive the whole import.
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

      // --- 6. Post-import navigation assertions (LOCK-UI3/UI4) ---------------
      // Marker absent — Redux, UI, and SQLite planes.
      expect(
        await topicExistsInRedux(page, MARKER.topic),
        `marker topic ${MARKER.topic} must be gone from Redux after replace-all`
      ).toBe(false)
      await expect(
        topicItem(page, MARKER.topic),
        `marker topic ${MARKER.topic} must be gone from the sidebar`
      ).toHaveCount(0)
      const markerAfterSql = await page.evaluate(
        (topicId) => (window as any).api.chatDb.topicExists({ topicId }),
        MARKER.topic
      )
      expect(markerAfterSql?.value, `marker topic ${MARKER.topic} must be gone from SQLite after replace-all`).toBe(
        false
      )

      // Imported navigation: assistants order/names + visible topic metadata.
      // LOCK-TF1: BEFORE any send, createdAt AND updatedAt must equal the
      // source projection values exactly.
      const nav = await readImportedNavigation(page)
      assertImportedNavigation(nav, PROJECTION_TOPICS.visible.updatedAt)
      await assertImportedNavigationUI(page)

      // Open the imported topic and see the historical content (LOCK-UI4).
      await openImportedTopic(page)
      await expect(messageContainer(page, TARGET_MESSAGE_ID)).toBeVisible({ timeout: 30000 })
      const historical = await readImportedMessages(page)
      expect(historical.messageIds, 'imported topic must expose the historical message target id').toContain(
        TARGET_MESSAGE_ID
      )
      expect(historical.blocks[SOURCE_IDS.block], 'historical message block content must be present').toContain(
        'Disposable seed block'
      )

      // --- 7. Post-import send (LOCK-UI4) ------------------------------------
      // The mock provider survived rehydration (llm slice persists); seed it
      // idempotently as a safety net, then send through the real inputbar.
      await ensureMockProviderSeeded(page, mockPort)
      clearRequestLog()
      const preSendSequence = getRequestSequence()

      await uiSendMessage(page, POST_IMPORT_MESSAGE)
      // The imported topic has 0 assistant messages before the send.
      await waitForAssistantResponseComplete(page, SOURCE_IDS.topic, 0)

      // LOCK-TF2: the assistant completion mutates the topic's updatedAt to a
      // fresh ISO timestamp (updateTopicUpdatedAt). Capture the settled
      // post-send value and verify it advanced past the source projection.
      const postSendUpdatedAt = await captureSettledTopicUpdatedAt(page)
      expect(postSendUpdatedAt, 'post-send topic.updatedAt must be defined').toBeTruthy()
      expect(new Date(postSendUpdatedAt).toISOString(), 'post-send topic.updatedAt must be a valid ISO timestamp').toBe(
        postSendUpdatedAt
      )
      expect(
        new Date(postSendUpdatedAt).getTime(),
        'post-send topic.updatedAt must advance past the source projection updatedAt (LOCK-TF2)'
      ).toBeGreaterThan(new Date(PROJECTION_TOPICS.visible.updatedAt).getTime())

      // Request-path evidence: the production AI SDK reached the mock.
      const productReq = findProductRequestAfter(preSendSequence)
      expect(
        productReq,
        'a product-originated chat completion request must reach the mock after the post-import send'
      ).not.toBeNull()
      expect((productReq!.parsed as { model?: string })?.model).toBe('mock-model')

      // Redux evidence: user + assistant messages persisted for the topic.
      const afterSend = await readImportedMessages(page)
      expect(afterSend.totalMessages, 'historical + user + assistant messages').toBe(3)
      expect(afterSend.userContents).toContain(POST_IMPORT_MESSAGE)
      expect(afterSend.assistantContents.some((c) => c.includes('[Mock mock-model]'))).toBe(true)

      // UI evidence: the new user message container and the assistant reply render.
      await expect(messageContainer(page, afterSend.newUserMessageId)).toBeVisible()
      await expect(page.getByText('[Mock mock-model] You said:', { exact: false })).toBeVisible()

      // --- 8. Close the entire app + post-close SQLite evidence ---------------
      // LOCK-UI4: full app close (fixture-owned close + exact-token verify,
      // LOCK-625), WAL flush, then the data-plane hard evidence.
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => electronApp.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      await sleep(3000)

      // Post-close chat.db replacement contents (LOCK-622 evidence c).
      assertReplacementContents(chatDbPath!)
      // Retained pre-import snapshot + journal cleanup (LOCK-4434/4436/4438).
      await assertRetainedPreImportSnapshot(dataDir)
      // NEW: the post-import user + assistant messages persisted to SQLite.
      assertPostImportMessagesInSql(chatDbPath!, POST_IMPORT_MESSAGE)

      // --- 9. Relaunch against the SAME disposable profile (LOCK-UI4) ---------
      relaunched = await relaunchSameProfile({ userDataDir, ownedTmpRoot, mockPort })
      await waitForMainWindowReady(relaunched.page)
      // The imported navigation was durably flushed by the projection apply,
      // so rehydration restores it directly (no pending one-shot row).
      await waitForImportedNavigationInRedux(relaunched.page)

      const navAfterRestart = await readImportedNavigation(relaunched.page)
      // LOCK-TF2: the SAME captured post-send updatedAt must rehydrate
      // unchanged after the full close/restart, while createdAt still equals
      // the source projection exactly (LOCK-TF1).
      assertImportedNavigation(navAfterRestart, postSendUpdatedAt)
      await assertImportedNavigationUI(relaunched.page)

      // Re-open the imported topic: historical AND new messages must remain.
      await openImportedTopic(relaunched.page)
      await expect(messageContainer(relaunched.page, TARGET_MESSAGE_ID)).toBeVisible({ timeout: 30000 })
      const afterRestart = await readImportedMessages(relaunched.page)
      expect(afterRestart.messageIds, 'historical message target id must survive the restart').toContain(
        TARGET_MESSAGE_ID
      )
      expect(afterRestart.userContents, 'post-import user message must survive the restart').toContain(
        POST_IMPORT_MESSAGE
      )
      expect(afterRestart.assistantContents.some((c) => c.includes('[Mock mock-model]'))).toBe(true)

      // --- 10. Close the relaunched app + final SQLite evidence ---------------
      const relaunchedToClose = relaunched
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => relaunchedToClose.app.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      relaunched = null
      await sleep(3000)
      // The same DB is quiesced again — replacement + post-import rows intact.
      assertReplacementContents(chatDbPath!)
      assertPostImportMessagesInSql(chatDbPath!, POST_IMPORT_MESSAGE)
    } catch (error) {
      bodyFailure = error
      throw error
    } finally {
      // ─────────────────────────────────────────────────────────────────────
      // Cleanup (LOCK-625/624, LOCK-C6/T1/T5) — always runs, even on failure.
      // ─────────────────────────────────────────────────────────────────────
      if (observer) {
        try {
          await observer.stop()
        } catch {
          // Page may already be gone — observer cleanup is best-effort.
        }
      }
      // Close the spec-launched relaunched instance by exact token.
      if (relaunched) {
        try {
          await closeElectronWithExactCleanup(userDataDir, {
            close: () => relaunched!.app.close(),
            findExactProcesses: findProcessesByUserDataDir,
            terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
          })
        } catch (err) {
          cleanupErrors.push(`relaunched app cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // Defensive sweep: terminate any UNKNOWN process still holding the exact
      // disposable token (e.g. a stale-build app.relaunch spawn), excluding the
      // fixture-owned original PID which the fixture teardown closes normally.
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
      // LOCK-T1: cleanup failures must fail the test. seed.cleanup() throws on
      // unresolved owned resources, and every exact seed path is verified
      // absent afterwards.
      if (seed) {
        try {
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
// Helpers — pre-import setup
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

/**
 * Create the deterministic target marker topic in Redux (visible in the
 * sidebar) and persist it to SQLite so the replace-all import must remove it
 * from both planes (LOCK-UI3).
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
// Helpers — Redux/UI state readers
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

function messageContainer(page: import('@playwright/test').Page, messageId: string) {
  return page.locator(`[data-message-id="${messageId}"]`)
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
 * Wait until the main window is usable again after the in-process reload or a
 * same-profile relaunch: #root attached, Redux store defined, home ready.
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
 * (post-reload) or that rehydration restored the durably flushed state
 * (post-restart).
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

interface NavigationSnapshot {
  assistants: Array<{
    id: string
    name: string
    emoji: string | null
    topics: Array<{
      id: string
      assistantId: string | null
      name: string
      createdAt: string | null
      updatedAt: string | null
      deletedAt: string | null
      pinned: boolean
      isNameManuallyEdited: boolean
    }>
  }>
  hasRecoveredShell: boolean
  hasDeletedTopic: boolean
}

async function readImportedNavigation(page: import('@playwright/test').Page): Promise<NavigationSnapshot> {
  return page.evaluate((recoveredId: string) => {
    const s = (window as any).store.getState()
    const assistants: NavigationSnapshot['assistants'] = (s.assistants?.assistants ?? []).map((a: any) => ({
      id: a.id,
      name: a.name ?? '',
      emoji: a.emoji ?? null,
      topics: (a.topics ?? []).map((t: any) => ({
        id: t.id,
        assistantId: t.assistantId ?? null,
        name: t.name ?? '',
        createdAt: t.createdAt ?? null,
        updatedAt: t.updatedAt ?? null,
        deletedAt: t.deletedAt ?? null,
        pinned: t.pinned ?? false,
        isNameManuallyEdited: t.isNameManuallyEdited ?? false
      }))
    }))
    return {
      assistants,
      hasRecoveredShell: assistants.some((a) => a.id === recoveredId),
      hasDeletedTopic: assistants.some((a) => a.topics.some((t) => t.id === 't-e2e-del-1'))
    }
  }, RECOVERED_SHELL_ASSISTANT_ID)
}

/**
 * LOCK-UI3 contract assertions: two shell assistants in source order; the
 * visible topic sits under the OUTER container (a-e2e-1) with the exported
 * metadata despite the stale inner assistantId; the LS-only deleted topic is
 * dropped; no recovered shell for this fixture (the IDB topic matches LS
 * metadata, so recoveredTopicIds is empty).
 *
 * The visible topic's updatedAt is parameterized: call with the source
 * projection updatedAt immediately after import (LOCK-TF1 — exact source
 * contract before any send), and with the captured post-send updatedAt after
 * a same-profile restart (LOCK-TF2 — the legitimate mutation must rehydrate
 * unchanged). createdAt is ALWAYS asserted exactly against the source
 * projection.
 */
function assertImportedNavigation(nav: NavigationSnapshot, expectedUpdatedAt: string): void {
  expect(
    nav.assistants.map((a) => a.id),
    'imported assistant order must be source order (LOCK-E4)'
  ).toEqual([PROJECTION_ASSISTANTS.first.id, PROJECTION_ASSISTANTS.second.id])
  expect(nav.assistants[0].name).toBe(PROJECTION_ASSISTANTS.first.name)
  expect(nav.assistants[1].name).toBe(PROJECTION_ASSISTANTS.second.name)
  expect(nav.assistants[1].topics, 'the LS-only deleted topic must be dropped (LOCK-PROD-3)').toEqual([])

  const visibleTopic = nav.assistants[0].topics.find((t) => t.id === SOURCE_IDS.topic)
  expect(visibleTopic, `visible topic ${SOURCE_IDS.topic} must be present under the first assistant`).toBeTruthy()
  expect(visibleTopic!.assistantId, 'the OUTER container owns grouping despite the stale inner assistantId').toBe(
    PROJECTION_ASSISTANTS.first.id
  )
  expect(visibleTopic!.assistantId).not.toBe(STALE_TOPIC_ASSISTANT_ID)
  expect(visibleTopic!.name).toBe(PROJECTION_TOPICS.visible.name)
  expect(visibleTopic!.pinned).toBe(PROJECTION_TOPICS.visible.pinned)
  expect(visibleTopic!.isNameManuallyEdited).toBe(PROJECTION_TOPICS.visible.isNameManuallyEdited)
  expect(visibleTopic!.createdAt).toBe(PROJECTION_TOPICS.visible.createdAt)
  expect(visibleTopic!.updatedAt).toBe(expectedUpdatedAt)
  expect(visibleTopic!.deletedAt).toBeNull()

  expect(nav.hasDeletedTopic, 'the LS-only deleted topic must not surface in navigation').toBe(false)
  expect(nav.hasRecoveredShell, 'no recovered-conversations shell for this fixture (LOCK-PROD-4)').toBe(false)
}

/** Sidebar/topic UI presence assertions (LOCK-UI4: visible interactions). */
async function assertImportedNavigationUI(page: import('@playwright/test').Page): Promise<void> {
  await clickAssistantsTab(page)
  await expect(
    page.locator('[class*="home-tabs"]').getByText(PROJECTION_ASSISTANTS.first.name, { exact: true }).first(),
    'first imported assistant must be visible in the sidebar'
  ).toBeVisible()
  await expect(
    page.locator('[class*="home-tabs"]').getByText(PROJECTION_ASSISTANTS.second.name, { exact: true }).first(),
    'second imported assistant must be visible in the sidebar'
  ).toBeVisible()

  await clickTopicsTab(page)
  const item = topicItem(page, SOURCE_IDS.topic)
  await expect(item, 'the imported topic must be visible in the topic list').toBeVisible()
  await expect(item, 'the imported topic must carry its projected name').toContainText(PROJECTION_TOPICS.visible.name)
  await expect(
    item.locator('.pin'),
    'the imported topic must render the pinned indicator (pinned metadata)'
  ).toBeVisible()
}

/**
 * Open the imported conversation through the visible sidebar: activate the
 * first imported assistant, switch to the Topics tab, and open t-e2e-1.
 */
async function openImportedTopic(page: import('@playwright/test').Page): Promise<void> {
  await clickAssistantsTab(page)
  const assistantName = page
    .locator('[class*="home-tabs"]')
    .getByText(PROJECTION_ASSISTANTS.first.name, { exact: true })
    .first()
  await assistantName.waitFor({ state: 'visible', timeout: 10000 })
  await assistantName.click()
  await clickTopicsTab(page)
  const item = topicItem(page, SOURCE_IDS.topic)
  await item.waitFor({ state: 'visible', timeout: 10000 })
  await item.click()
  // The topic must finish loading before message assertions (LOCK-UI4).
  // Absent/undefined loading flags are treated as "not loading" (same falsy
  // semantics as the ordinary-chat waitForAssistantResponseComplete helpers).
  await page.waitForFunction(
    (topicId: string) => {
      const s = (window as any).store?.getState()
      return !s?.messages?.loadingByTopic?.[topicId]
    },
    SOURCE_IDS.topic,
    { timeout: 30000 }
  )
}

interface MessageSnapshot {
  messageIds: string[]
  userContents: string[]
  assistantContents: string[]
  blocks: Record<string, string>
  newUserMessageId: string
  totalMessages: number
}

async function readImportedMessages(page: import('@playwright/test').Page): Promise<MessageSnapshot> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages?.messageIdsByTopic?.[topicId] ?? []
    const userContents: string[] = []
    const assistantContents: string[] = []
    const blocks: Record<string, string> = {}
    let newUserMessageId = ''
    for (const id of msgIds) {
      const msg = s.messages?.entities?.[id]
      if (!msg) continue
      const text = (msg.blocks ?? [])
        .map((blockId: string) => s.messageBlocks?.entities?.[blockId]?.content ?? '')
        .join('\n')
      if (msg.role === 'user') {
        userContents.push(text)
        newUserMessageId = id
      } else if (msg.role === 'assistant') {
        assistantContents.push(text)
      }
      for (const blockId of msg.blocks ?? []) {
        blocks[blockId] = s.messageBlocks?.entities?.[blockId]?.content ?? ''
      }
    }
    return {
      messageIds: [...msgIds],
      userContents,
      assistantContents,
      blocks,
      newUserMessageId,
      totalMessages: msgIds.length
    }
  }, SOURCE_IDS.topic)
}

/**
 * Read the imported topic's Redux `updatedAt` (LOCK-TF2). Returns null when
 * the topic or its timestamp is absent.
 */
async function readTopicUpdatedAt(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store?.getState()
    for (const assistant of s?.assistants?.assistants ?? []) {
      const topic = (assistant.topics ?? []).find((t: any) => t.id === topicId)
      if (topic?.updatedAt) return topic.updatedAt as string
    }
    return null
  }, SOURCE_IDS.topic)
}

/**
 * Capture the post-send topic.updatedAt once it has settled (two consecutive
 * reads 250ms apart agree). The assistant completion dispatches
 * updateTopicUpdatedAt during the final block commit; this polls past any
 * trailing RAF/throttled update so the captured value is exactly the one that
 * persists through close and rehydrates after the same-profile restart.
 */
async function captureSettledTopicUpdatedAt(page: import('@playwright/test').Page): Promise<string> {
  let previous: string | null = null
  for (let i = 0; i < 24; i++) {
    const current = await readTopicUpdatedAt(page)
    if (current !== null && previous !== null && current === previous) {
      return current
    }
    previous = current
    await page.waitForTimeout(250)
  }
  throw new Error(`[E2E] topic ${SOURCE_IDS.topic} updatedAt never settled; last read: ${previous}`)
}

// ---------------------------------------------------------------------------
// Helpers — post-import send (mirrors ordinary-chat patterns, LOCK-UI4)
// ---------------------------------------------------------------------------

/** Idempotently ensure the mock provider is present after rehydration. */
async function ensureMockProviderSeeded(page: import('@playwright/test').Page, mockPort: number): Promise<void> {
  const present = await page.evaluate(() => {
    const s = (window as any).store?.getState()
    return Boolean(
      s?.llm?.providers?.some((p: any) => p.id === 'mock-openai') && s.llm?.defaultModel?.id === 'mock-model'
    )
  })
  if (present) return
  const apiHost = `http://127.0.0.1:${mockPort}/v1/`
  await page.evaluate(
    ({ apiHost }) => {
      const store = (window as any).store
      const state = store.getState()
      const existing = state.llm.providers.find((p: any) => p.id === 'mock-openai')
      if (existing) {
        store.dispatch({
          type: 'llm/updateProvider',
          payload: { id: 'mock-openai', apiKey: 'test-key', apiHost, enabled: true }
        })
      } else {
        store.dispatch({
          type: 'llm/addProvider',
          payload: {
            id: 'mock-openai',
            type: 'openai',
            name: 'Mock OpenAI',
            apiKey: 'test-key',
            apiHost,
            models: [
              {
                id: 'mock-model',
                provider: 'mock-openai',
                name: 'Mock Model',
                group: 'mock',
                description: 'Mock model for E2E'
              }
            ],
            enabled: true,
            isSystem: false
          }
        })
      }
      const mockModel = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' }
      store.dispatch({ type: 'llm/setDefaultModel', payload: { model: mockModel } })
      store.dispatch({ type: 'llm/setQuickModel', payload: { model: mockModel } })
      store.dispatch({ type: 'llm/setTranslateModel', payload: { model: mockModel } })
    },
    { apiHost }
  )
  await page.waitForTimeout(1000)
}

/**
 * Type text into the real textarea and submit via Enter. Uses page.evaluate
 * to dispatch React-compatible input events (Ant Design controlled textarea).
 */
async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()

  await page.evaluate(
    ({ selector, text }) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement
      if (!el) throw new Error('Textarea not found')
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSetter) throw new Error('No native textarea setter')
      nativeSetter.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { selector: '.inputbar textarea, textarea[placeholder]', text }
  )

  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
}

/**
 * Wait for the assistant response to complete by monitoring Redux state:
 * assistant message count increases, reaches a terminal status, its blocks
 * are terminal, and topic loading is false.
 */
async function waitForAssistantResponseComplete(
  page: import('@playwright/test').Page,
  topicId: string,
  previousAssistantCount: number,
  timeout = 60000
): Promise<number> {
  await page.waitForFunction(
    ({ topicId, prevCount }: { topicId: string; prevCount: number }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
      let count = 0
      for (const id of msgIds) {
        const msg = s.messages.entities?.[id]
        if (msg?.role === 'assistant') count++
      }
      return count > prevCount
    },
    { topicId, prevCount: previousAssistantCount },
    { timeout }
  )

  await page.waitForFunction(
    ({ topicId }: { topicId: string }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      if (s.messages?.loadingByTopic?.[topicId]) return false
      const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
      let latestAssistantId: string | null = null
      for (let i = msgIds.length - 1; i >= 0; i--) {
        const msg = s.messages.entities?.[msgIds[i]]
        if (msg?.role === 'assistant') {
          latestAssistantId = msgIds[i]
          break
        }
      }
      if (!latestAssistantId) return false
      const assistantMsg = s.messages.entities[latestAssistantId]
      const terminalStatuses = ['success', 'error']
      if (!terminalStatuses.includes(assistantMsg.status)) return false
      const blocks = assistantMsg.blocks || []
      if (blocks.length === 0) return false
      for (const blockId of blocks) {
        const block = s.messageBlocks?.entities?.[blockId]
        if (!block) return false
        if (block.status !== 'success' && block.status !== 'error') return false
      }
      return true
    },
    { topicId },
    { timeout }
  )

  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages.messageIdsByTopic[topicId] || []
    let count = 0
    for (const id of msgIds) {
      const msg = s.messages.entities[id]
      if (msg?.role === 'assistant') count++
    }
    return count
  }, topicId)
}

// ---------------------------------------------------------------------------
// Helpers — SQLite evidence
// ---------------------------------------------------------------------------

function queryRows(dbPath: string, sql: string): Array<Record<string, unknown>> {
  const result = queryChatDbViaElectron(dbPath, sql)
  // LOCK-QDB-5: fail closed on any failure code — never `rows ?? []`.
  if (!result.ok) throw new Error(`SQLite query failed: ${result.code}`)
  return Array.from(result.rows)
}

function assertReplacementContents(dbPath: string): void {
  const topicIds = queryRows(dbPath, 'SELECT id FROM topics ORDER BY id').map((r) => String(r.id))
  expect(topicIds).toContain(SOURCE_IDS.topic)
  expect(topicIds).not.toContain(BASELINE.topic)
  expect(topicIds).not.toContain(MARKER.topic)

  const messages = queryRows(dbPath, 'SELECT id, topic_id FROM messages ORDER BY id')
  expect(messages).toContainEqual(expect.objectContaining({ id: TARGET_MESSAGE_ID, topic_id: SOURCE_IDS.topic }))
  expect(messages.map((r) => String(r.id))).not.toContain(BASELINE.message)

  const blocks = queryRows(dbPath, 'SELECT id, message_id FROM message_blocks ORDER BY id')
  expect(blocks).toContainEqual(expect.objectContaining({ id: SOURCE_IDS.block, message_id: TARGET_MESSAGE_ID }))
  expect(blocks.map((r) => String(r.id))).not.toContain(BASELINE.block)

  const segments = queryRows(dbPath, 'SELECT id, topic_id FROM topic_segments ORDER BY id')
  expect(segments).toContainEqual(expect.objectContaining({ id: SOURCE_IDS.segment, topic_id: SOURCE_IDS.topic }))

  // LOCK-T4: the installed segment→message membership relation must exist.
  const memberships = queryRows(
    dbPath,
    'SELECT segment_id, message_id FROM topic_segment_messages ORDER BY segment_id, sort_order'
  )
  expect(memberships).toContainEqual(
    expect.objectContaining({ segment_id: SOURCE_IDS.segment, message_id: TARGET_MESSAGE_ID })
  )
  expect(memberships.map((r) => String(r.message_id))).not.toContain(BASELINE.message)
}

/**
 * LOCK-SNAP-2: the retained pre-import snapshot must be a regular non-symlink
 * non-empty file AND pass the bounded batched readonly verify plan — exact
 * one-row integrity 'ok', exactly empty foreign_key_check, and exact typed
 * six counts with fixture-safe comparisons where semantically available.
 * Content queries below stay for row identity; integrity/FK/count evidence
 * runs through the shared verify plan (never generic separate queries).
 */
async function assertRetainedPreImportSnapshot(dataDir: string): Promise<void> {
  const snapshotPath = path.join(dataDir, ROLLBACK_SNAPSHOT_FILENAME)
  // LOCK-SNAP-2: regular non-symlink non-empty file (fixed path-free checks).
  assertRetainedSnapshotFile(snapshotPath)

  // The snapshot is the pre-import live DB: it must still hold the baseline
  // target records and must NOT contain the imported source records
  // (LOCK-T4: topic, message AND block in both directions).
  const snapshotTopicIds = queryRows(snapshotPath, 'SELECT id FROM topics ORDER BY id').map((r) => String(r.id))
  expect(snapshotTopicIds).toContain(BASELINE.topic)
  expect(snapshotTopicIds).not.toContain(SOURCE_IDS.topic)

  const snapshotMessageIds = queryRows(snapshotPath, 'SELECT id FROM messages ORDER BY id').map((r) => String(r.id))
  expect(snapshotMessageIds).toContain(BASELINE.message)
  expect(snapshotMessageIds).not.toContain(TARGET_MESSAGE_ID)

  const snapshotBlockIds = queryRows(snapshotPath, 'SELECT id FROM message_blocks ORDER BY id').map((r) => String(r.id))
  expect(snapshotBlockIds).toContain(BASELINE.block)
  expect(snapshotBlockIds).not.toContain(SOURCE_IDS.block)

  // LOCK-SNAP-2: bounded readonly batched verify plan on the retained snapshot.
  const snapshotVerify = await verifyChatDbViaElectronWithRetry(snapshotPath)
  if (!snapshotVerify.ok) {
    throw new Error(`retained pre-import snapshot verification failed: ${snapshotVerify.code}`)
  }
  expect(snapshotVerify.value.integrityOk, 'retained pre-import snapshot must pass integrity_check').toBe(true)
  expect(snapshotVerify.value.foreignKeyViolations, 'retained pre-import snapshot must pass foreign_key_check').toBe(0)
  // Fixture-safe pre-import counts: the spec creates only the marker + baseline
  // topics, the baseline message and its block — no segments, memberships or
  // file references can exist before the import.
  expect(snapshotVerify.value.counts.topic_segments, 'pre-import snapshot must have exactly zero topic_segments').toBe(
    0
  )
  expect(
    snapshotVerify.value.counts.topic_segment_messages,
    'pre-import snapshot must have exactly zero segment memberships'
  ).toBe(0)
  expect(
    snapshotVerify.value.counts.file_references,
    'pre-import snapshot must have exactly zero file references'
  ).toBe(0)
  expect(
    snapshotVerify.value.counts.topics,
    'pre-import snapshot must hold at least the marker + baseline topics'
  ).toBeGreaterThanOrEqual(2)
  expect(
    snapshotVerify.value.counts.messages,
    'pre-import snapshot must hold at least the baseline message'
  ).toBeGreaterThanOrEqual(1)
  expect(
    snapshotVerify.value.counts.message_blocks,
    'pre-import snapshot must hold at least the baseline block'
  ).toBeGreaterThanOrEqual(1)

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
      `promotion artifact should be absent after successful recovery: ${artifactName}`
    ).toBe(false)
  }
}

/**
 * Post-import persistence evidence: the historical message AND the new
 * user/assistant messages for the imported topic live in SQLite (LOCK-UI4).
 *
 * LOCK-GF2: the modern Message model carries no content field — text lives
 * in `message_blocks.content`. Mirroring the ordinary-chat spec, message rows
 * are asserted for identity/role/count, and text content is asserted from the
 * blocks scoped to this topic's message ids (message_id IN subquery, the same
 * query shape as the ordinary-chat post-shutdown verification).
 */
function assertPostImportMessagesInSql(dbPath: string, userContent: string): void {
  const esc = (s: string) => s.replace(/'/g, "''")
  // Message identity/role rows (LOCK-GF1: rows persisted with topic linkage
  // and correct roles after close and after same-profile restart). No content
  // column here — text is queried from blocks below (LOCK-GF2).
  const rows = queryRows(
    dbPath,
    `SELECT id, role FROM messages WHERE topic_id = '${esc(SOURCE_IDS.topic)}' ORDER BY sort_order`
  )
  const userRows = rows.filter((r) => r.role === 'user')
  const assistantRows = rows.filter((r) => r.role === 'assistant')
  expect(
    rows.map((r) => String(r.id)),
    'the historical message target id must be persisted'
  ).toContain(TARGET_MESSAGE_ID)
  expect(userRows.length, 'historical + post-import user messages must be persisted').toBeGreaterThanOrEqual(2)
  expect(assistantRows.length, 'the post-import assistant response must be persisted').toBeGreaterThanOrEqual(1)

  // LOCK-GF2: query block text scoped to this topic's messages, then
  // associate each block to its message row by message_id.
  const msgIdList = rows.map((r) => `'${esc(String(r.id))}'`).join(',')
  const blockRows = queryRows(
    dbPath,
    `SELECT id, message_id, type, content, status, sort_order FROM message_blocks WHERE message_id IN (${msgIdList}) ORDER BY sort_order`
  )
  expect(blockRows.length, 'each persisted message must carry at least one block').toBeGreaterThanOrEqual(rows.length)

  const blocksByMessage = new Map<string, string[]>()
  for (const block of blockRows) {
    const key = String(block.message_id)
    const texts = blocksByMessage.get(key) ?? []
    texts.push(String(block.content ?? ''))
    blocksByMessage.set(key, texts)
  }

  // The synthetic post-import user text must live in a block of a user row.
  expect(
    userRows.some((r) => (blocksByMessage.get(String(r.id)) ?? []).some((c) => c.includes(userContent))),
    `the post-import user message content must be persisted in message_blocks: ${userContent}`
  ).toBe(true)

  // The expected mock assistant response must live in a block of an
  // assistant row (mirrors the Redux/UI assertions on '[Mock mock-model]').
  expect(
    assistantRows.some((r) => (blocksByMessage.get(String(r.id)) ?? []).some((c) => c.includes('[Mock mock-model]'))),
    'the post-import assistant response content must be persisted in message_blocks'
  ).toBe(true)

  // Historical imported block content preserved (LOCK-UI4).
  expect(
    blockRows.some(
      (r) => String(r.id) === SOURCE_IDS.block && String(r.content ?? '').includes('Disposable seed block')
    ),
    'the historical block content must be persisted'
  ).toBe(true)
}
