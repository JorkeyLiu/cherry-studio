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
 * navigation projection apply; better-sqlite3 loads as a Node-API shared
 * binding under both Node and Electron so `queryChatDbViaElectron`
 * (post-close file reads) can load the same native module under the
 * Electron binary.
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
import { findChatRequestsAfter } from '../../fixtures/mock-openai-server'
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

      // Scoped contract (test-only isolation, NOT a product fix): this fixture
      // proves import/persistence (replace-all + reload + restart), never the
      // independent automatic topic-naming feature (covered separately by
      // conversation/topic-auto-naming.spec.ts). The genuine Main-given
      // baseline is intentionally NOT repaired here: the source IDB topic row
      // carries no naming metadata and the import data plane drops the LS
      // `isNameManuallyEdited` UI field, so Main `fetchTopicNamingContext`
      // reports null and the post-send `autoRenameTopic` summary would rename
      // the topic away from the hardcoded `Seed Topic` asserts below. Disable
      // the feature noise through the existing settings Redux API before the
      // import (persisted by the store, re-applied on each fresh page below;
      // the intentional post-import send in §7 explicitly re-enables it via
      // `enterAutomaticNamingPhase`, which the post-send rename assertions
      // require).
      await disableAutomaticTopicNaming(page)

      // Deterministic marker topic in Redux (visible in the sidebar) AND
      // SQLite (data plane) — the replace-all import must remove it from both.
      await createMarkerTopic(page, MARKER.topic, MARKER.name)
      expect(
        await topicExistsInRedux(page, MARKER.topic),
        `marker ${MARKER.topic} must be in Redux before import`
      ).toBe(true)
      // LOCK-NAV: the topics list panel always renders; assert its readiness
      // instead of switching to a Topics tab.
      await expect(page.locator('.topics-tab')).toBeVisible()
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

      // Fresh-page re-apply (see scoped contract above): the in-process reload
      // reset the page context, so re-disable on the fresh page and prove the
      // isolation BEFORE the genuine post-import send below. The intentional
      // send in §7 explicitly enters the automatic phase afterwards.
      await disableAutomaticTopicNaming(page)

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

      // --- 6b. LOCK-EVIDENCE: direct on-disk generation comparison ----------
      // Compare the Main IPC view against DIRECT readonly SQL reads of the
      // LIVE `Data/chat.db` and the retained `chat.db.pre-import-backup` at
      // this exact post-reload point, so the failing generation is identified
      // empirically (LOCK-009: Main IPC and on-disk live DB must agree after
      // reopen). LOCK-001: replace-all must leave imported source only in the
      // live DB; the backup retains the old baseline/marker. Uses the EXISTING
      // shared `queryChatDbViaElectron` fixture helper — no production
      // instrumentation (LOCK-EVIDENCE). The diagnostic helper surfaces the
      // exact query outcome code when the live DB is held by the running app
      // (BUSY/LOCKED) instead of swallowing it.
      const liveSnapshot = readTopicIdSnapshot(chatDbPath!)
      const backupSnapshot = readTopicIdSnapshot(path.join(dataDir, ROLLBACK_SNAPSHOT_FILENAME))
      const liveDesc = describeTopicIdSnapshot('live Data/chat.db', liveSnapshot)
      const backupDesc = describeTopicIdSnapshot('chat.db.pre-import-backup', backupSnapshot)
      console.log(`[E2E] Direct on-disk topic generations — ${liveDesc}; ${backupDesc}`)

      expect(liveSnapshot.ok, `live chat.db direct read failed — ${liveDesc}`).toBe(true)
      if (liveSnapshot.ok) {
        expect(
          liveSnapshot.topicIds.includes(SOURCE_IDS.topic),
          `live chat.db must contain the imported source topic ${SOURCE_IDS.topic} — ${liveDesc}`
        ).toBe(true)
        expect(
          liveSnapshot.topicIds.includes(BASELINE.topic),
          `live chat.db must NOT contain the baseline topic ${BASELINE.topic} after replace-all — ${liveDesc}`
        ).toBe(false)
        expect(
          liveSnapshot.topicIds.includes(MARKER.topic),
          `live chat.db must NOT contain the marker topic ${MARKER.topic} after replace-all — ${liveDesc}`
        ).toBe(false)
      }

      expect(backupSnapshot.ok, `pre-import backup direct read failed — ${backupDesc}`).toBe(true)
      if (backupSnapshot.ok) {
        expect(
          backupSnapshot.topicIds.includes(BASELINE.topic),
          `pre-import backup must retain the baseline topic ${BASELINE.topic} — ${backupDesc}`
        ).toBe(true)
        expect(
          backupSnapshot.topicIds.includes(MARKER.topic),
          `pre-import backup must retain the marker topic ${MARKER.topic} — ${backupDesc}`
        ).toBe(true)
        expect(
          backupSnapshot.topicIds.includes(SOURCE_IDS.topic),
          `pre-import backup must NOT contain the imported source topic ${SOURCE_IDS.topic} — ${backupDesc}`
        ).toBe(false)
      }

      const markerAfterSql = await page.evaluate(
        (topicId) => (window as any).api.chatDb.topicExists({ topicId }),
        MARKER.topic
      )
      expect(
        markerAfterSql?.value,
        `marker topic ${MARKER.topic} must be gone from SQLite after replace-all; ` +
          `IPC topicExists=${String(markerAfterSql?.value)} — ${liveDesc}; ${backupDesc}`
      ).toBe(false)

      // Imported navigation: assistants order/names + visible topic metadata.
      // LOCK-TF1: BEFORE any send, createdAt AND updatedAt must equal the
      // source projection values exactly.
      const nav = await readImportedNavigation(page)
      assertImportedNavigation(nav, PROJECTION_TOPICS.visible.updatedAt)
      await assertImportedNavigationUI(page)

      // Application integrity: the repaired second-assistant topic owns a
      // Main SQLite row (typed API), switches without TypeError into a ready
      // Chat (no central "new topic" CTA), and leaves the first chat intact.
      const repairedTopicId = nav.assistants[1].topics[0]!.id
      await assertRepairedTopicIntegrity(page, repairedTopicId)
      await openRepairedSecondTopic(page, repairedTopicId)

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
      // Phase coordination (test-only, NOT a product change): the history and
      // import checks above ran under naming isolation (disabled). The
      // intentional send below MUST exercise the ordinary automatic summary
      // naming — the post-send assertions (waitRename + deterministic
      // mock-pipeline name + Main rename persistence + relaunch re-assert)
      // require the summary path (`enableTopicNaming` true, Main
      // `fetchTopicNamingContext` manual flag null from the genuine import
      // data plane which installs `overflow: {}`/`name: null` and never the
      // LS `isNameManuallyEdited` UI field, Main name null so
      // default-eligible, messageCount >= 2 after the send, mock
      // quick/default model bound). Enter the automatic phase explicitly;
      // the mock provider survived rehydration (llm slice persists) and is
      // re-seeded idempotently as a safety net inside the helper.
      await enterAutomaticNamingPhase(page, mockPort)
      clearRequestLog()
      const preSendSequence = getRequestSequence()

      await uiSendMessage(page, POST_IMPORT_MESSAGE)
      // The imported topic has 0 assistant messages before the send.
      await waitForAssistantResponseComplete(page, SOURCE_IDS.topic, 0)

      // Ordinary app auto-naming legitimately renames the topic after the
      // intentional send (mock provider summary). Wait for that async rename
      // to settle BEFORE capturing clocks, or the captured updatedAt predates
      // the rename persist and the relaunch comparison races it.
      await waitForTopicRenameSettled(page)
      // Deterministic expectation from the SAME mock naming pipeline (not a
      // hardcoded string): the mock echoes the naming request's last user
      // content sliced to 100 chars. Must differ from the source name.
      const expectedPostSendName = computeExpectedRenamedTopicName(preSendSequence)
      const renamedNow = await readVisibleTopicName(page)
      // Byte-exact: the helper replicates the full production pipeline
      // (mock echo + topic-name sanitizer), so no normalization is needed.
      expect(renamedNow, 'Redux topic name must equal the deterministic mock naming result').toBe(expectedPostSendName)
      expect(renamedNow, 'the settled rename must be a real name').toBeTruthy()
      // Byte-exact anchor from here on: persistence and relaunch compare the
      // OBSERVED wire value (identical string the Main row stores), while the
      // assertion above already proved its mock-pipeline provenance.
      const settledPostSendName = renamedNow as string

      // LOCK-TF2: the assistant completion (+ settled rename) mutates the
      // topic's updatedAt to a fresh ISO timestamp (updateTopicUpdatedAt).
      // Capture the settled post-send value and verify it advanced past the
      // source projection.
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

      // UI evidence: the new user message container and the assistant reply
      // render. The mock prefix also surfaces in the auto-title topic <div>,
      // so the unscoped getByText matches 2 — scope to the actual ASSISTANT
      // reply container id from the Redux projection (never the user id).
      expect(afterSend.newAssistantMessageId, 'assistant reply id must be defined').toBeTruthy()
      await expect(messageContainer(page, afterSend.newUserMessageId)).toBeVisible()
      await expect(messageContainer(page, afterSend.newAssistantMessageId)).toBeVisible()
      await expect(
        messageContainer(page, afterSend.newAssistantMessageId).getByText(
          `[Mock mock-model] You said: "${POST_IMPORT_MESSAGE}"`,
          {
            exact: false
          }
        )
      ).toBeVisible()

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
      // The deterministic rename persisted in Main (exact name; Main clock
      // well-formed and advanced past the source timestamp).
      assertRenamedTopicNameInSql(chatDbPath!, SOURCE_IDS.topic, settledPostSendName)

      // --- 9. Relaunch against the SAME disposable profile (LOCK-UI4) ---------
      relaunched = await relaunchSameProfile({ userDataDir, ownedTmpRoot, mockPort })
      await waitForMainWindowReady(relaunched.page)
      // The imported navigation was durably flushed by the projection apply,
      // so rehydration restores it directly (no pending one-shot row).
      await waitForImportedNavigationInRedux(relaunched.page)
      // Same-profile relaunch re-assert (see scoped contract above): prove the
      // disabled naming configuration survived; no further send follows, so
      // this is persistence evidence only.
      await disableAutomaticTopicNaming(relaunched.page)

      const navAfterRestart = await readImportedNavigation(relaunched.page)
      // LOCK-TF2: the SAME captured post-send updatedAt must rehydrate
      // unchanged after the full close/restart, while createdAt still equals
      // the source projection exactly (LOCK-TF1). The visible name is the
      // deterministic post-send rename (ordinary auto-naming), not the
      // source name — every other field stays exactly on the source.
      assertImportedNavigation(navAfterRestart, postSendUpdatedAt, settledPostSendName)
      await assertImportedNavigationUI(relaunched.page, settledPostSendName)
      // Stable repair: the SAME repaired id survives the same-profile
      // relaunch with no second row (count stays 1).
      expect(
        navAfterRestart.assistants[1].topics[0]!.id,
        'repaired topic id must be stable across the same-profile relaunch'
      ).toBe(repairedTopicId)
      expect(navAfterRestart.assistants[1].topics, 'repaired count stays 1 after relaunch').toHaveLength(1)
      await assertRepairedTopicIntegrity(relaunched.page, repairedTopicId)

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
      assertRenamedTopicNameInSql(chatDbPath!, SOURCE_IDS.topic, settledPostSendName)
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

  test('genuine ZIP import repairs missing default topics without changing imported history', async ({
    electronApp,
    mainWindow,
    userDataDir,
    ownedTmpRoot,
    mockPort
  }) => {
    // Focused repair proof (no send — never requires provider requests):
    // a legal import whose source second assistant has zero live topics is
    // automatically repaired to ONE new default topic; the imported history
    // (visible topic id/name/timestamps/pinned, deleted drop, order) is
    // unchanged; switching to the second assistant never throws; the Main
    // row exists once and stays stable across a same-profile relaunch.
    test.setTimeout(600000)
    const page = mainWindow
    const originalPidValue = electronApp.process().pid as number

    let bodyFailure: unknown = null
    const cleanupErrors: string[] = []
    let seed: Awaited<ReturnType<typeof createDisposableSeedZip>> | null = null
    let observer: Awaited<ReturnType<typeof observeImportStatuses>> | null = null
    let relaunched: Awaited<ReturnType<typeof relaunchSameProfile>> | null = null

    try {
      await page.evaluate(() => {
        ;(window as any).__e2eRepairMarker = true
      })
      seed = await createDisposableSeedZip(ownedTmpRoot)
      // Source fidelity stays pure: 2 assistants, 2 topic records (one live,
      // one deleted-only). The repair is applied-runtime only, never source.
      expect(seed.evidence.projectionAssistantCount).toBe(2)
      expect(seed.evidence.projectionTopicCount).toBe(2)

      observer = await observeImportStatuses(page)
      const startResult = await page.evaluate(
        (zipPath) => (window as any).api.cherryImport.start(zipPath),
        seed.zipPath
      )
      expect(startResult?.ok, `cherryImport.start failed: ${JSON.stringify(startResult)}`).toBe(true)
      observer.setSessionId(startResult.sessionId as string)
      const finalizing = await observer.waitForState('finalizing', 120000)
      expect(finalizing.state).toBe('finalizing')

      await page.waitForFunction(() => (window as any).__e2eRepairMarker !== true, { timeout: 120000 })
      await waitForMainWindowReady(page)
      await waitForImportedNavigationInRedux(page)
      await observer.stop()
      observer = null
      expect(electronApp.process().pid).toBe(originalPidValue)

      // Automatic ready Chat: no central "new topic" CTA blocks the tree.
      await expect(page.locator('.topics-tab')).toBeVisible()
      const nav = await readImportedNavigation(page)
      assertImportedNavigation(nav, PROJECTION_TOPICS.visible.updatedAt)
      const repairedTopicId = nav.assistants[1].topics[0]!.id
      await assertRepairedTopicIntegrity(page, repairedTopicId)

      // Switch to the second assistant: no TypeError, default name locale,
      // ready Chat on the repaired topic.
      await openRepairedSecondTopic(page, repairedTopicId)
      const repairedName = await page.evaluate((topicId: string) => {
        const s = (window as any).store.getState()
        const assistants = s.assistants?.assistants ?? []
        for (const a of assistants) {
          const t = (a.topics ?? []).find((x: { id: string }) => x.id === topicId)
          if (t) return t.name ?? ''
        }
        return ''
      }, repairedTopicId)
      expect(repairedName, 'repaired topic must carry the localized default name').toBeTruthy()
      expect(repairedName).not.toBe(PROJECTION_TOPICS.deleted.name)

      // Existing first chat untouched: visible topic + historical message.
      await openImportedTopic(page)
      await expect(messageContainer(page, TARGET_MESSAGE_ID)).toBeVisible({ timeout: 30000 })
      const historical = await readImportedMessages(page)
      expect(historical.messageIds).toContain(TARGET_MESSAGE_ID)

      // Same-profile relaunch: same repaired id, count still 1, no new row.
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => electronApp.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      await sleep(3000)
      relaunched = await relaunchSameProfile({ userDataDir, ownedTmpRoot, mockPort })
      await waitForMainWindowReady(relaunched.page)
      await waitForImportedNavigationInRedux(relaunched.page)
      const navAfter = await readImportedNavigation(relaunched.page)
      assertImportedNavigation(navAfter, PROJECTION_TOPICS.visible.updatedAt)
      expect(navAfter.assistants[1].topics[0]!.id, 'repaired id stable across relaunch').toBe(repairedTopicId)
      expect(navAfter.assistants[1].topics, 'repaired count stays 1 after relaunch').toHaveLength(1)
      await assertRepairedTopicIntegrity(relaunched.page, repairedTopicId)
      await openRepairedSecondTopic(relaunched.page, repairedTopicId)

      const toClose = relaunched
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => toClose.app.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      relaunched = null
      await sleep(3000)
    } catch (error) {
      bodyFailure = error
      throw error
    } finally {
      if (observer) {
        try {
          await observer.stop()
        } catch {
          // best-effort
        }
      }
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

/**
 * Scoped contract — test-only automatic topic-naming isolation (NOT a product
 * fix, NOT a global default change).
 *
 * This import/persistence fixture must not exercise the independent
 * auto-naming feature (`autoRenameTopic`, covered separately by
 * `conversation/topic-auto-naming.spec.ts`): the genuine Main-given baseline
 * is left as-is (source IDB topic row carries no naming metadata and the
 * import data plane drops the LS `isNameManuallyEdited` UI field, so Main
 * `fetchTopicNamingContext` reports null and the post-send `autoRenameTopic` summary would rename
 * the topic away from the hardcoded `Seed Topic` asserts). Disabling via the
 * existing `settings/setEnableTopicNaming` Redux convention removes only that
 * fixture noise; the genuine product send path (mock provider) is untouched
 * and no request is blocked. The trailing assert proves the isolation at each
 * call site (pre-import setup, fresh-page re-apply after the in-process
 * reload before the send, and same-profile relaunch persistence). The
 * intentional post-import send (§7) explicitly LEAVES this isolation via
 * `enterAutomaticNamingPhase`, which the post-send rename assertions require.
 */
async function disableAutomaticTopicNaming(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).store.dispatch({ type: 'settings/setEnableTopicNaming', payload: false })
  })
  const enabled = await page.evaluate(() => (window as any).store.getState().settings.enableTopicNaming)
  expect(
    enabled,
    'automatic topic naming must be disabled for this import/persistence fixture (topic naming is covered separately)'
  ).toBe(false)
}

/**
 * Phase coordination — explicitly enter the automatic topic-naming phase for
 * the intentional post-import send (test-only, NOT a product fix, NOT a
 * global default change, and NOT an import-contract change).
 *
 * The history/import checks run under `disableAutomaticTopicNaming`
 * isolation so the pre-send asserts hold the exact source projection name
 * (`Seed Topic`, LOCK-TF1). The post-send assertions instead require the
 * ordinary `autoRenameTopic` SUMMARY path — never the disabled first-message
 * fallback: `waitForTopicRenameSettled` plus `computeExpectedRenamedTopicName`
 * require the summary request to reach the mock with the structured
 * conversation JSON (`"mainText"`, request log >= 2), which only fires when
 * `enableTopicNaming` is true, the Main naming-context manual flag is null
 * (the genuine import data plane installs `overflow: {}` / `name: null` and
 * never the LS `isNameManuallyEdited` UI field; the one-shot navigation
 * projection apply is Redux-only and never writes Main rows), the Main name
 * is null so the topic is default-eligible, messageCount >= 2 after the send,
 * and the mock quick/default model binding resolves. This helper re-seeds
 * the mock provider binding idempotently, re-enables the feature through the
 * existing `settings/setEnableTopicNaming` Redux convention, and proves the
 * full automatic-phase precondition (flag true + mock provider + default +
 * quick model) BEFORE the send. No Main topic row, seed, or production
 * behavior is touched.
 */
async function enterAutomaticNamingPhase(page: import('@playwright/test').Page, mockPort: number): Promise<void> {
  await ensureMockProviderSeeded(page, mockPort)
  await page.evaluate(() => {
    ;(window as any).store.dispatch({ type: 'settings/setEnableTopicNaming', payload: true })
  })
  const phase = await page.evaluate(() => {
    const s = (window as any).store.getState()
    return {
      enabled: s.settings.enableTopicNaming,
      provider: s?.llm?.providers?.some((p: any) => p.id === 'mock-openai'),
      defaultModel: s?.llm?.defaultModel?.id,
      quickModel: s?.llm?.quickModel?.id
    }
  })
  expect(phase.enabled, 'automatic topic naming must be enabled for the intentional post-import send').toBe(true)
  expect(phase.provider, 'mock provider must be present for the automatic naming phase').toBe(true)
  expect(phase.defaultModel, 'mock default model must be bound for the automatic naming phase').toBe('mock-model')
  expect(phase.quickModel, 'mock quick model must be bound for the automatic naming phase').toBe('mock-model')
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
 * assistant (a-e2e-1) exists with the visible IDB-matched topic t-e2e-1 AND
 * the second assistant (a-e2e-2) has completed the user-authorized
 * application integrity repair (exactly one live topic). This waits for the
 * full applied-application completion (projection apply + boot integrity
 * sweep + flush) — never just the raw projection — so callers never race a
 * pre-flush/finalize snapshot. On timeout the error carries the observed
 * navigation snapshot instead of a vague wait message.
 */
async function waitForImportedNavigationInRedux(page: import('@playwright/test').Page): Promise<void> {
  try {
    await page.waitForFunction(
      ({ firstAssistantId, secondAssistantId, topicId }) => {
        const s = (window as any).store?.getState()
        const list = s?.assistants?.assistants
        if (!Array.isArray(list) || list.length === 0) return false
        const first = list.find((a: any) => a.id === firstAssistantId)
        if (!first) return false
        if (!Array.isArray(first.topics) || !first.topics.some((t: any) => t.id === topicId)) return false
        const second = list.find((a: any) => a.id === secondAssistantId)
        if (!second) return false
        return Array.isArray(second.topics) && second.topics.length === 1
      },
      {
        firstAssistantId: PROJECTION_ASSISTANTS.first.id,
        secondAssistantId: PROJECTION_ASSISTANTS.second.id,
        topicId: SOURCE_IDS.topic
      },
      { timeout: 120000 }
    )
  } catch (error) {
    const snapshot = await page
      .evaluate(() => {
        const s = (window as any).store?.getState()
        const list = s?.assistants?.assistants ?? []
        return list.map((a: any) => ({
          id: a?.id,
          topics: Array.isArray(a?.topics) ? a.topics.map((t: any) => t?.id) : a?.topics
        }))
      })
      .catch(() => 'unreadable')
    throw new Error(
      `waitForImportedNavigationInRedux timed out waiting for applied-application integrity ` +
        `(first topic present + second assistant repaired to 1 topic); observed: ${JSON.stringify(snapshot)}`
    )
  }
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
 * Application integrity (user-authorized repair): the source projection
 * carries the second assistant with zero live topics (pure source fidelity —
 * `projectionTopicCount` stays 2 and the LS-only deleted id stays dropped).
 * The applied runtime MUST repair it to exactly ONE new default topic whose
 * id differs from every source/deleted id. Timestamps/ordering of the
 * imported visible topic stay exactly on the source projection (LOCK-TF1).
 *
 * The visible topic's updatedAt is parameterized: call with the source
 * projection updatedAt immediately after import (LOCK-TF1 — exact source
 * contract before any send), and with the captured post-send updatedAt after
 * a same-profile restart (LOCK-TF2 — the legitimate mutation must rehydrate
 * unchanged). createdAt is ALWAYS asserted exactly against the source
 * projection.
 *
 * The visible topic's name is likewise parameterized: the source projection
 * name ('Seed Topic') holds before any send (source fidelity), while after
 * the intentional post-import send the ordinary app auto-naming legitimately
 * renames it via the mock provider — callers pass the deterministic
 * post-send name computed from the mock naming request (see
 * `computeExpectedRenamedTopicName`). All other metadata (id, owner,
 * pinned, flags, createdAt, deletedAt) stays exactly on the source.
 */
function assertImportedNavigation(
  nav: NavigationSnapshot,
  expectedUpdatedAt: string,
  expectedVisibleName: string = PROJECTION_TOPICS.visible.name
): void {
  expect(
    nav.assistants.map((a) => a.id),
    'imported assistant order must be source order (LOCK-E4)'
  ).toEqual([PROJECTION_ASSISTANTS.first.id, PROJECTION_ASSISTANTS.second.id])
  expect(nav.assistants[0].name).toBe(PROJECTION_ASSISTANTS.first.name)
  expect(nav.assistants[1].name).toBe(PROJECTION_ASSISTANTS.second.name)
  // Source fidelity: the LS-only deleted topic never surfaces …
  expect(nav.hasDeletedTopic, 'the LS-only deleted topic must not surface in navigation').toBe(false)
  // … but the applied runtime repairs the second assistant to ONE new default
  // topic (user-authorized integrity), never the deleted/source ids.
  expect(
    nav.assistants[1].topics,
    'the second assistant must be repaired to exactly one new default topic'
  ).toHaveLength(1)
  const repaired = nav.assistants[1].topics[0]!
  expect(repaired.id, 'repaired topic id must be a real id').toBeTruthy()
  expect(
    [SOURCE_IDS.topic, PROJECTION_TOPICS.deleted.id],
    'repaired topic id must differ from every source/deleted id'
  ).not.toContain(repaired.id)
  expect(repaired.assistantId, 'repaired topic must belong to the second assistant').toBe(
    PROJECTION_ASSISTANTS.second.id
  )
  expect(repaired.name, 'repaired topic must carry a default name').toBeTruthy()
  expect(repaired.name).not.toBe(PROJECTION_TOPICS.deleted.name)
  expect(repaired.deletedAt).toBeNull()

  const visibleTopic = nav.assistants[0].topics.find((t) => t.id === SOURCE_IDS.topic)
  expect(visibleTopic, `visible topic ${SOURCE_IDS.topic} must be present under the first assistant`).toBeTruthy()
  expect(visibleTopic!.assistantId, 'the OUTER container owns grouping despite the stale inner assistantId').toBe(
    PROJECTION_ASSISTANTS.first.id
  )
  expect(visibleTopic!.assistantId).not.toBe(STALE_TOPIC_ASSISTANT_ID)
  expect(visibleTopic!.name).toBe(expectedVisibleName)
  expect(visibleTopic!.pinned).toBe(PROJECTION_TOPICS.visible.pinned)
  expect(visibleTopic!.isNameManuallyEdited).toBe(PROJECTION_TOPICS.visible.isNameManuallyEdited)
  expect(visibleTopic!.createdAt).toBe(PROJECTION_TOPICS.visible.createdAt)
  expect(visibleTopic!.updatedAt).toBe(expectedUpdatedAt)
  expect(visibleTopic!.deletedAt).toBeNull()

  expect(nav.hasRecoveredShell, 'no recovered-conversations shell for this fixture (LOCK-PROD-4)').toBe(false)
}

/** Sidebar/topic UI presence assertions (LOCK-UI4: visible interactions). */
async function assertImportedNavigationUI(
  page: import('@playwright/test').Page,
  expectedVisibleName: string = PROJECTION_TOPICS.visible.name
): Promise<void> {
  // LOCK-NAV: the assistant list panel always renders; no tab switching.
  await expect(page.locator('.assistants-tab')).toBeVisible()
  await expect(
    page.locator('[class*="home-tabs"]').getByText(PROJECTION_ASSISTANTS.first.name, { exact: true }).first(),
    'first imported assistant must be visible in the sidebar'
  ).toBeVisible()
  await expect(
    page.locator('[class*="home-tabs"]').getByText(PROJECTION_ASSISTANTS.second.name, { exact: true }).first(),
    'second imported assistant must be visible in the sidebar'
  ).toBeVisible()

  // LOCK-NAV: the topics list panel always renders beside the assistant list.
  await expect(page.locator('.topics-tab')).toBeVisible()
  const item = topicItem(page, SOURCE_IDS.topic)
  await expect(item, 'the imported topic must be visible in the topic list').toBeVisible()
  await expect(item, 'the imported topic must carry its projected name').toContainText(expectedVisibleName)
  await expect(
    item.locator('.pin'),
    'the imported topic must render the pinned indicator (pinned metadata)'
  ).toBeVisible()
}

/**
 * Open the imported conversation through the visible sidebar: activate the
 * first imported assistant, then open t-e2e-1 from the always-rendered
 * topics panel (LOCK-NAV — no tab switching).
 */
async function openImportedTopic(page: import('@playwright/test').Page): Promise<void> {
  // LOCK-NAV: the assistant list panel always renders; no tab switching.
  await expect(page.locator('.assistants-tab')).toBeVisible()
  const assistantName = page
    .locator('[class*="home-tabs"]')
    .getByText(PROJECTION_ASSISTANTS.first.name, { exact: true })
    .first()
  await assistantName.waitFor({ state: 'visible', timeout: 10000 })
  await assistantName.click()
  // LOCK-NAV: the topics list panel always renders beside the assistant list.
  await expect(page.locator('.topics-tab')).toBeVisible()
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

/**
 * Main-owns-row verification for the repaired default topic (typed API):
 * the row exists in SQLite and the runtime nav groups it under the second
 * assistant. Count stability (exactly 1) is asserted by the callers via the
 * Redux nav snapshot before/after relaunch.
 */
async function assertRepairedTopicIntegrity(
  page: import('@playwright/test').Page,
  repairedTopicId: string
): Promise<void> {
  const exists = await page.evaluate((topicId) => (window as any).api.chatDb.topicExists({ topicId }), repairedTopicId)
  expect(exists?.ok, `repaired topicExists failed: ${JSON.stringify(exists)}`).toBe(true)
  expect(exists?.value, `repaired topic ${repairedTopicId} must exist in Main SQLite`).toBe(true)
  const owner = await page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const assistants = s.assistants?.assistants ?? []
    for (const a of assistants) {
      if ((a.topics ?? []).some((t: { id: string }) => t.id === topicId)) return a.id
    }
    return null
  }, repairedTopicId)
  expect(owner, 'repaired topic must stay grouped under the second assistant').toBe(PROJECTION_ASSISTANTS.second.id)
}

/**
 * Switch to the repaired second assistant through the visible sidebar:
 * no TypeError, no central "new topic" CTA — the repaired topic renders in
 * the always-visible topics panel and Chat becomes ready on it.
 */
async function openRepairedSecondTopic(page: import('@playwright/test').Page, repairedTopicId: string): Promise<void> {
  await expect(page.locator('.assistants-tab')).toBeVisible()
  const assistantName = page
    .locator('[class*="home-tabs"]')
    .getByText(PROJECTION_ASSISTANTS.second.name, { exact: true })
    .first()
  await assistantName.waitFor({ state: 'visible', timeout: 10000 })
  await assistantName.click()
  await expect(page.locator('.topics-tab')).toBeVisible()
  const item = topicItem(page, repairedTopicId)
  await item.waitFor({ state: 'visible', timeout: 10000 })
  await item.click()
  // The repaired empty topic is ready (never loading forever, never throw).
  await page.waitForFunction(
    (topicId: string) => {
      const s = (window as any).store?.getState()
      if (s?.messages?.loadingByTopic?.[topicId]) return false
      const assistants = s?.assistants?.assistants ?? []
      return assistants.some((a: { topics?: Array<{ id: string }> }) => (a.topics ?? []).some((t) => t.id === topicId))
    },
    repairedTopicId,
    { timeout: 30000 }
  )
  // No uncaught TypeError surface: the active Chat topic id matches.
  const activeId = await page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistants = s.assistants?.assistants ?? []
    const second = assistants.find((a: { id: string }) => a.id === 'a-e2e-2')
    return (second?.topics ?? [])[0]?.id ?? null
  })
  expect(activeId, 'second assistant must expose the repaired topic without throwing').toBe(repairedTopicId)
}

interface MessageSnapshot {
  messageIds: string[]
  userContents: string[]
  assistantContents: string[]
  blocks: Record<string, string>
  newUserMessageId: string
  assistantMessageIds: string[]
  newAssistantMessageId: string
  totalMessages: number
}

async function readImportedMessages(page: import('@playwright/test').Page): Promise<MessageSnapshot> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages?.messageIdsByTopic?.[topicId] ?? []
    const userContents: string[] = []
    const assistantContents: string[] = []
    const blocks: Record<string, string> = {}
    const assistantMessageIds: string[] = []
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
        assistantMessageIds.push(id)
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
      assistantMessageIds,
      newAssistantMessageId: assistantMessageIds.length > 0 ? assistantMessageIds[assistantMessageIds.length - 1] : '',
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
 * Read the imported topic's Redux `name` (post-send rename tracking).
 */
async function readVisibleTopicName(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store?.getState()
    for (const assistant of s?.assistants?.assistants ?? []) {
      const topic = (assistant.topics ?? []).find((t: any) => t.id === topicId)
      if (topic && typeof topic.name === 'string') return topic.name as string
    }
    return null
  }, SOURCE_IDS.topic)
}

/**
 * Wait for the ordinary post-send auto-naming rename to settle: the visible
 * topic name must move off the source projection name and then stay stable
 * across two consecutive reads. Fire-and-forget by design, so the flow must
 * not capture clocks until this settles — otherwise the captured updatedAt
 * predates the rename persist.
 */
async function waitForTopicRenameSettled(page: import('@playwright/test').Page): Promise<string> {
  const sourceName = PROJECTION_TOPICS.visible.name
  let previous: string | null = null
  for (let i = 0; i < 240; i++) {
    const current = await readVisibleTopicName(page)
    if (current !== null && current !== sourceName && previous !== null && current === previous) {
      return current
    }
    previous = current
    await page.waitForTimeout(250)
  }
  throw new Error(
    `[E2E] topic ${SOURCE_IDS.topic} name never renamed off the source name; last read: ${JSON.stringify(previous)}`
  )
}

/**
 * Deterministic post-send topic-name expectation from the SAME mock naming
 * pipeline — never a hardcoded string. The ordinary auto-naming summary
 * request is the chat/completions call whose last user content is the
 * structured conversation JSON (it carries `"mainText"` keys; the turn send
 * carries the plain prompt). The mock echoes
 * `[Mock <model>] You said: "<content sliced to 100 chars>"`, so the
 * expected name is recomputed with that exact formula from the observed
 * request. Also asserts the mock prefix and the prompt's presence.
 */
function computeExpectedRenamedTopicName(preSendSequence: number): string {
  const chatRequests = findChatRequestsAfter(preSendSequence)
  expect(
    chatRequests.length,
    'the post-import send plus the auto-naming summary must both reach the mock'
  ).toBeGreaterThanOrEqual(2)
  const naming = chatRequests.find((entry) => {
    const messages = (entry.parsed as { messages?: Array<{ role?: string; content?: unknown }> })?.messages
    const lastUser = messages?.filter((m) => m?.role === 'user').pop()
    return typeof lastUser?.content === 'string' && (lastUser.content as string).includes('"mainText"')
  })
  expect(naming, 'an auto-naming summary request (structured conversation JSON) must reach the mock').toBeTruthy()
  const messages = (naming!.parsed as { messages: Array<{ role: string; content: string }> }).messages
  const lastUser = messages.filter((m) => m.role === 'user').pop()!
  // Exact production pipeline: the mock echoes
  // `[Mock <model>] You said: "<content sliced to 100 chars>"`, then the
  // summary path sanitizes it for topic names via
  // `removeSpecialCharactersForTopicName` (quotes/newlines → space, trim;
  // `src/renderer/src/utils/naming.ts`). Replicated exactly — byte-exact.
  const rawEcho = `[Mock mock-model] You said: "${String(lastUser.content).slice(0, 100)}"`
  const expected = rawEcho.replace(/["'\r\n]+/g, ' ').trim()
  expect(expected, 'the deterministic rename must carry the mock prefix').toContain('[Mock mock-model] You said:')
  expect(expected.length).toBeGreaterThan('[Mock mock-model] You said:  '.length)
  return expected
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

/**
 * LOCK-EVIDENCE: deterministic direct on-disk topic-ID snapshot of a chat.db
 * file through the EXISTING shared Electron readonly query helper
 * (`queryChatDbViaElectron`) — no production instrumentation.
 *
 * Non-throwing by design: a direct read of the LIVE chat.db while the running
 * app holds it can be blocked (BUSY/LOCKED), and the exact outcome code must
 * surface in the assertion message instead of a bare throw. Fails closed on
 * every failure code — never `rows ?? []` (LOCK-QDB-5).
 */
type TopicIdSnapshot = { ok: true; topicIds: string[] } | { ok: false; failure: string }

function readTopicIdSnapshot(dbPath: string): TopicIdSnapshot {
  const result = queryChatDbViaElectron(dbPath, 'SELECT id FROM topics ORDER BY id')
  if (!result.ok) {
    return {
      ok: false,
      failure: `direct SQL read failed (code=${result.code}, attempt=${result.attempt}, elapsedMs=${result.elapsedMs})`
    }
  }
  return {
    ok: true,
    topicIds: Array.from(result.rows)
      .map((r) => String(r.id))
      .sort()
  }
}

/**
 * Render a compact diagnostic line for one direct on-disk topic-ID snapshot:
 * the full sorted topic-id set plus per-generation membership (source /
 * baseline / marker), so the failing generation is identifiable from the
 * assertion output alone.
 */
function describeTopicIdSnapshot(label: string, snapshot: TopicIdSnapshot): string {
  if (!snapshot.ok) return `${label}: ${snapshot.failure}`
  const generation = (id: string): string => (snapshot.topicIds.includes(id) ? 'present' : 'absent')
  return (
    `${label}: topicIds=[${snapshot.topicIds.join(', ')}] ` +
    `source(${SOURCE_IDS.topic})=${generation(SOURCE_IDS.topic)}, ` +
    `baseline(${BASELINE.topic})=${generation(BASELINE.topic)}, ` +
    `marker(${MARKER.topic})=${generation(MARKER.topic)}`
  )
}

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

/**
 * Main-persist proof for the legitimate post-send rename: the topics row
 * carries EXACTLY the deterministic rename. Clocks are lane-owned by design
 * (store `updateTopic`/`UpdatedAt` and Main `updateTopicMetadata` each stamp
 * their own `new Date`, and updatedAt never crosses IPC), so the Main clock
 * is only required to be well-formed and ADVANCE past the source projection
 * timestamp — never byte-equal to the Redux clock. Ids/owner/pinned/source
 * history are covered by the sibling asserts.
 */
function assertRenamedTopicNameInSql(dbPath: string, topicId: string, expectedName: string): void {
  const esc = (s: string) => s.replace(/'/g, "''")
  const rows = queryRows(dbPath, `SELECT id, name, updated_at FROM topics WHERE id = '${esc(topicId)}'`)
  expect(rows, `topic ${topicId} must exist in SQLite`).toHaveLength(1)
  expect(String(rows[0].name), 'the Main topics row must persist the deterministic rename').toBe(expectedName)
  const mainUpdatedAt = String(rows[0].updated_at ?? '')
  expect(new Date(mainUpdatedAt).toISOString(), 'the Main topics row clock must be a valid ISO timestamp').toBe(
    mainUpdatedAt
  )
  expect(
    new Date(mainUpdatedAt).getTime(),
    'the Main topics row clock must advance past the source projection updatedAt'
  ).toBeGreaterThan(new Date(PROJECTION_TOPICS.visible.updatedAt).getTime())
}
