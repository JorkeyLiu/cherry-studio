/**
 * E2E: L2 Cherry Studio synthetic-ZIP attachment import — full-flow regression
 * coverage for the attachment plane (LOCK-E2E-1..6).
 *
 * Builds on the genuine full-flow spec (import/reload/relaunch/post-close
 * patterns) and the real-backup spec (source-ZIP fingerprint pattern) to prove
 * the deterministic synthetic attachment scenario end to end:
 *
 *   Source scenario (LOCK-E2-FIX, seeded via
 *   `createDisposableSeedZip(..., { withAttachments: true })`):
 *   - f-e2e-att-png   image block + files catalog row + Data/Files payload (healthy);
 *   - f-e2e-att-txt   file  block + files catalog row + Data/Files payload (healthy);
 *   - f-e2e-att-missing image block + files catalog row but NO payload (degraded
 *                     `missingPayload` → the block is marked unavailable LOCK-UI-4);
 *   - f-e2e-att-orphan       files catalog row + Data/Files payload but NO block
 *                     (browser-only orphan — never referenced).
 *
 *  1. Seed the baseline target marker topic + a baseline topic/message/block
 *     that the replace-all import MUST remove (LOCK-623), mirroring the
 *     genuine spec.
 *  2. Reproducibly generate the disposable source ZIP with attachments and
 *     assert the typed attachment evidence returned by the seed helper
 *     (catalog rows, payload SHA-256s, expected classification).
 *  3. LOCK-E2E-2: capture the source ZIP fingerprint (sha256, size, mtime,
 *     inode, mode) BEFORE the import and re-assert it unchanged in `finally`
 *     — the import only ever READS the source archive.
 *  4. Drive `window.api.cherryImport.start(zipPath)` and observe the status
 *     chain THROUGH `finalizing`; assert the candidate-ready data-plane
 *     counts EXACTLY: topicCount=1, messageCount=2, blockCount=4,
 *     segmentCount=1, segmentMembershipCount=1, fileReferenceCount=3.
 *  5. LOCK-UI1: in-process main renderer reload — the original PID stays
 *     alive; wait for Redux rehydration + the one-shot navigation apply.
 *  6. LOCK-E2E-4 UI assertions:
 *     - the valid PNG visibly renders and is nonblank (DOM + canvas pixel
 *       probe — LOCK-E2E-6 supplement);
 *     - the valid text document filename is visible and its content reads
 *       exactly through the existing app-owned `fs.readText` path;
 *     - the missing attachment placeholder is visible and NO
 *       file/imageSize/base64/open/read error is emitted for it (console +
 *       pageerror capture);
 *     - the file browser (Files page) lists png/txt/orphan, excludes the
 *       missing file, and renders without Invalid Date (null-metadata-safe).
 *  7. Close the ENTIRE app and assert post-close state: SQLite integrity/FK/
 *     exact counts (file_references exactly 3), replacement contents,
 *     unavailable marker in `message_blocks.extra` (missing true / healthy
 *     absent), live Files payloads byte/hash exact + missing absent, retained
 *     pre-import snapshot + journal/staging cleanup, empty promoted candidate
 *     shells (LOCK-E2E-5).
 *  8. Relaunch against the SAME disposable profile and re-assert the imported
 *     messages, valid payload existence/hash, the unavailable marker + UI,
 *     and the file browser rows (LOCK-E2E-5).
 *  9. Close the relaunched instance and re-verify the post-close state.
 * 10. finally: exact-token cleanup, defensive process sweep, source-ZIP
 *     fingerprint post-check, seed cleanup with absence verification
 *     (LOCK-E2E-2, LOCK-C6/T1/T5).
 *
 * Evidence rules (LOCK-E2E-6): deterministic assertions only — no screenshots/
 * CDP as regression evidence. A canvas/image pixel probe MAY supplement DOM
 * assertions. The in-renderer IndexedDB `files` store read is an additional
 * app-owned deterministic oracle for the file browser catalog.
 *
 * Platform: macOS-only (production A-9 gate). Skipped clearly otherwise.
 *
 * Prerequisite (owned by the main validation phase, NOT this session): a fresh
 * production build including the chatImport window entry, the LOCK-PROD-7
 * in-process reload, the navigation projection apply, and the files-catalog
 * apply; better-sqlite3 rebuilt for the Electron ABI so
 * `queryChatDbViaElectron` (post-close file reads) loads the native module
 * under the Electron binary.
 */
import { createHash } from 'node:crypto'
import * as fs from 'fs'
import * as path from 'path'

import type { Page } from '@playwright/test'

import {
  expect,
  getChatDbPath,
  queryChatDbViaElectron,
  test,
  verifyChatDbViaElectronWithRetry
} from '../../fixtures/electron.fixture'
import { SidebarPage } from '../../pages/sidebar.page'
import {
  ATTACHMENT_BLOCK_IDS,
  ATTACHMENT_FILES,
  ATTACHMENT_MESSAGE_ID,
  ATTACHMENT_PAYLOADS,
  attachmentExpectedClassification,
  createDisposableSeedZip,
  PROJECTION_ASSISTANTS,
  SEED_NATIVE_VERSION,
  SOURCE_IDS
} from '../../utils/disposable-seed-zip'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import { expectedMessageTargetId } from '../../utils/expected-message-id'
import {
  assertOnlyEmptyPromotedCandidateShells,
  snapshotCandidateInventory
} from '../../utils/import-artifact-validation'
import { assertStateSubsequence, observeImportStatuses, REQUIRED_STATE_CHAIN } from '../../utils/import-status'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { relaunchSameProfile } from '../../utils/restart-electron-profile'
import { assertRetainedSnapshotFile } from '../../utils/snapshot-file'
import { sleep } from '../../utils/wait-helpers'

// ---------------------------------------------------------------------------
// Constants (LOCK-E2E-1: deterministic scenario facts)
// ---------------------------------------------------------------------------

/** Baseline target records the replace-all import MUST remove (LOCK-623). */
const BASELINE = { topic: 't-baseline-att', message: 'm-baseline-att', block: 'b-baseline-att' } as const

/** Deterministic pre-import marker topic (replace-all removal proof). */
const MARKER = { topic: 't-marker-att-e2e', name: 'Marker Topic' } as const

/** Fixed promotion artifact names (LOCK-4434/4436/4438). */
const ROLLBACK_SNAPSHOT_FILENAME = 'chat.db.pre-import-backup'
const ROLLBACK_SNAPSHOT_STAGING_FILENAME = 'chat.db.pre-import-backup.staging'
const PROMOTION_JOURNAL_FILENAME = 'chat-import-promotion.journal.json'
const PROMOTION_JOURNAL_STAGING_FILENAME = 'chat-import-promotion.journal.json.staging'

/** Source ZIP fingerprint baseline/fields (LOCK-E2E-2). */
interface SourceFingerprint {
  sha256: string
  size: number
  mtimeMs: number
  ino: number
  mode: number
}

/**
 * LOCK-MID-1/2: every imported source message maps to the deterministic
 * target `l2m1:<sha256>` of `(outerTopicId, legacyMessageId)`. Both the text
 * message and the attachment message are embedded in topic t-e2e-1.
 */
const TEXT_MESSAGE_TARGET_ID = expectedMessageTargetId(SOURCE_IDS.topic, SOURCE_IDS.message)
const ATTACHMENT_MESSAGE_TARGET_ID = expectedMessageTargetId(SOURCE_IDS.topic, ATTACHMENT_MESSAGE_ID)

/** Expected physical basenames of the healthy/orphan payloads (LOCK-E2-FIX-4). */
const HEALTHY_LIVE_FILES: ReadonlyArray<{ id: string; ext: string; payload: Buffer; name: string }> =
  ATTACHMENT_FILES.filter((f) => f.payloadKey !== null).map((f) => ({
    id: f.id,
    ext: f.ext,
    payload: ATTACHMENT_PAYLOADS[f.payloadKey as 'png' | 'txt' | 'orphan'],
    name: `${f.id}${f.ext}`
  }))

/** Expected live-file SHA-256 hexes, recomputed from the deterministic buffers. */
const HEALTHY_SHA256 = new Map<string, string>(
  HEALTHY_LIVE_FILES.map((f) => [f.name, createHash('sha256').update(f.payload).digest('hex')])
)

/** Expected Dexie `files` catalog ids after the replace-all apply. */
const EXPECTED_CATALOG_IDS = HEALTHY_LIVE_FILES.map((f) => f.id).sort()

/**
 * Console/pageerror capture contract (LOCK-E2E-4): while the imported
 * attachment UI is asserted, NO error may reference the missing file or the
 * file-read family (getFilePath/getImageSize/base64/open/read/ENOENT).
 */
const MISSING_PAYLOAD_ERROR_RE =
  /(seed-missing\.png|f-e2e-att-missing|missing.?payload|no such file|ENOENT|failed to (read|open)|getImageSize|base64Image|base64File)/i

test.describe('Cherry Studio synthetic-ZIP attachment import', () => {
  test.skip(
    process.platform !== 'darwin',
    'L2 import is macOS-only (LOCK-623); full-flow E2E requires darwin and session.fromPath behavior'
  )

  test('imports attachment blocks/files/references, marks the missing one unavailable, and survives a same-profile restart', async ({
    electronApp,
    mainWindow,
    userDataDir,
    ownedTmpRoot,
    mockPort
  }) => {
    // Fixture launch + seed generation + import + in-process reload + UI
    // lifecycle + close + same-profile relaunch + re-assertions exceed the
    // 60s default.
    test.setTimeout(600000)
    const page = mainWindow

    // --- 0. Original process identity + target chat.db/files location ------
    const originalPid = electronApp.process().pid
    expect(originalPid, 'original target process pid must be defined').toBeTruthy()
    const originalPidValue = originalPid as number
    const chatDbPath = getChatDbPath()
    expect(chatDbPath, 'fixture must have captured the disposable chat.db path').toBeTruthy()
    const dataDir = path.dirname(chatDbPath!)
    const filesDir = path.join(dataDir, 'Files')

    // Body + cleanup error capture (LOCK-C6: cleanup failure is a test
    // failure; a body failure is preserved for diagnosis).
    let bodyFailure: unknown = null
    const cleanupErrors: string[] = []
    let seed: Awaited<ReturnType<typeof createDisposableSeedZip>> | null = null
    let observer: Awaited<ReturnType<typeof observeImportStatuses>> | null = null
    let relaunched: Awaited<ReturnType<typeof relaunchSameProfile>> | null = null
    let sourceBefore: SourceFingerprint | null = null

    // LOCK-E2E-4: console + pageerror capture forbidding missing-payload/file
    // read errors. Install on the fixture page BEFORE the import starts.
    const missingPayloadErrors: string[] = []
    installMissingPayloadErrorCapture(page, missingPayloadErrors)

    try {
      // ─────────────────────────────────────────────────────────────────────
      // 0. Pre-import marker + deterministic marker topic (LOCK-UI3)
      // ─────────────────────────────────────────────────────────────────────
      await page.evaluate(() => {
        ;(window as any).__e2ePreImportMarker = true
      })
      await createMarkerTopic(page, MARKER.topic, MARKER.name)
      expect(
        await topicExistsInRedux(page, MARKER.topic),
        `marker ${MARKER.topic} must be in Redux before import`
      ).toBe(true)
      await clickTopicsTab(page)
      await expect(
        topicItem(page, MARKER.topic),
        'marker topic must be visible in the sidebar before import'
      ).toBeVisible()
      const markerBeforeSql = await page.evaluate(
        (topicId) => (window as any).api.chatDb.topicExists({ topicId }),
        MARKER.topic
      )
      expect(markerBeforeSql?.value, `marker topic ${MARKER.topic} must exist in SQLite before import`).toBe(true)

      // Baseline target rows (replace-all proof, LOCK-623).
      await seedBaselineTarget(page)
      const baselineTopicExists = await page.evaluate(
        (topicId) => (window as any).api.chatDb.topicExists({ topicId }),
        BASELINE.topic
      )
      expect(baselineTopicExists?.ok).toBe(true)
      expect(baselineTopicExists?.value, `baseline topic ${BASELINE.topic} must exist before import`).toBe(true)

      // --- 1. Disposable source ZIP WITH attachments (LOCK-621, LOCK-E2-FIX) --
      seed = await createDisposableSeedZip(ownedTmpRoot, { withAttachments: true })
      // Source evidence — exactly what the seed documents.
      expect(seed.evidence.nativeVersion).toBe(SEED_NATIVE_VERSION)
      for (const store of ['topics', 'message_blocks', 'topic_segments', 'files']) {
        expect(seed.evidence.stores).toContain(store)
      }
      expect(seed.evidence.verifiedKeys.files).toContain(SOURCE_IDS.file)

      // LOCK-E2-FIX-4: typed attachment evidence.
      const attachment = seed.evidence.attachment
      expect(attachment, 'attachment-variant evidence must be present').toBeDefined()
      expect(attachment!.messageId).toBe(ATTACHMENT_MESSAGE_ID)
      expect([...attachment!.blockIds]).toEqual([...ATTACHMENT_BLOCK_IDS])
      expect(attachment!.catalogRows).toHaveLength(4)
      expect(attachment!.zipDataFilesEntries).toHaveLength(3)
      expect(attachment!.zipPayloadsVerified, 'every expected Data/Files payload must be byte-identical').toBe(true)

      // LOCK-E2E-1/3: the expected attachment-plane classification derived
      // deterministically by the seed helper (source-side contract).
      expect(attachment!.expected).toEqual(attachmentExpectedClassification())
      expect(attachment!.expected.referencedFileIdCount).toBe(3)
      expect(attachment!.expected.healthyFileCount).toBe(3)
      expect(attachment!.expected.degradedMissingPayload).toBe(1)
      expect([...attachment!.expected.degradedFileIds]).toEqual(['f-e2e-att-missing'])
      expect(attachment!.expected.skippedPayloadWithoutCatalog).toBe(0)

      // Payload evidence: SHA-256s match the deterministic buffers exactly.
      for (const payload of attachment!.payloads) {
        expect(HEALTHY_SHA256.get(payload.name), `payload ${payload.name} sha256 must match the seed buffer`).toBe(
          payload.sha256
        )
        expect(payload.bytesEqual, `payload ${payload.name} must be byte-identical`).toBe(true)
      }
      console.log('[E2E] Attachment seed evidence PASS (4 catalog rows, 3 payloads verified, 1 degraded missing)')

      // LOCK-E2E-2: source ZIP fingerprint baseline (read-only, node-side).
      sourceBefore = await captureSourceFingerprint(seed.zipPath)
      console.log(`[E2E] Source ZIP fingerprint baseline (sha256[:8]=${sourceBefore.sha256.slice(0, 8)})`)

      // LOCK-E2E-5: owned candidate/temp workspace inventory BEFORE import.
      const candidateInventoryBefore = snapshotCandidateInventory(dataDir, ownedTmpRoot)

      // --- 2. Observe statuses, then start the import -----------------------
      observer = await observeImportStatuses(page)
      const startResult = await page.evaluate(
        (zipPath) => (window as any).api.cherryImport.start(zipPath),
        seed.zipPath
      )
      expect(startResult?.ok, `cherryImport.start failed: ${JSON.stringify(startResult)}`).toBe(true)
      expect(typeof startResult.sessionId).toBe('string')
      const sessionId = startResult.sessionId as string
      observer.setSessionId(sessionId)

      // --- 3. candidate-ready stats EXACT (LOCK-E2E-3) -----------------------
      // LOCK-OBS-1: resolve only once the stats-bearing candidate-ready event
      // lands (never the poll-only record with null stats).
      const ready = await observer.waitForState('candidate-ready', 120000, (record) => record.stats != null)
      expect(ready?.stats, 'candidate-ready event must carry CandidateImportStats').toBeTruthy()
      const stats = ready?.stats as Record<string, unknown>
      expect(stats.topicCount, 'candidate topicCount').toBe(1)
      expect(stats.messageCount, 'candidate messageCount (text + attachment messages)').toBe(2)
      expect(stats.blockCount, 'candidate blockCount (text + 3 attachment blocks)').toBe(4)
      expect(stats.segmentCount, 'candidate segmentCount').toBe(1)
      expect(stats.segmentMembershipCount, 'candidate segmentMembershipCount').toBe(1)
      expect(stats.fileReferenceCount, 'candidate fileReferenceCount (png/txt/missing)').toBe(3)
      console.log('[E2E] candidate-ready stats PASS (1/2/4/1/1/3)')

      // --- 4. Status progression THROUGH finalizing (LOCK-622 evidence a) ---
      const finalizing = await observer.waitForState('finalizing', 120000)
      expect(finalizing.state).toBe('finalizing')
      const observed = await observer.getStates()
      const stateNames = observed.map((s) => s.state)
      const chainError = assertStateSubsequence(stateNames, REQUIRED_STATE_CHAIN)
      expect(chainError, chainError ?? undefined).toBeNull()
      const promotedIndex = stateNames.indexOf('promoted')
      if (promotedIndex !== -1) {
        expect(promotedIndex).toBeGreaterThan(stateNames.indexOf('finalizing'))
      }
      console.log(`[E2E] Observed import states: ${stateNames.join(' -> ')}`)

      // --- 5. In-process reload — same PID stays alive (LOCK-UI1) ------------
      expect(
        electronApp.process().pid,
        `original PID ${originalPidValue} must still be alive after finalizing (LOCK-UI1)`
      ).toBe(originalPidValue)
      await page.waitForFunction(() => (window as any).__e2ePreImportMarker !== true, { timeout: 120000 })
      await waitForMainWindowReady(page)
      await waitForImportedNavigationInRedux(page)
      expect(
        electronApp.process().pid,
        `original PID ${originalPidValue} must still be alive after the in-process reload (LOCK-UI1)`
      ).toBe(originalPidValue)
      console.log(`[E2E] In-process reload observed; original PID ${originalPidValue} stayed alive (LOCK-UI1)`)

      // Detach the page-side observer (the collector was reset by the reload).
      await observer.stop()
      observer = null

      // --- 6. Post-import UI assertions (LOCK-E2E-3/4) -----------------------
      // Marker removed — Redux, UI, and SQLite planes.
      expect(await topicExistsInRedux(page, MARKER.topic), 'marker must be gone from Redux after replace-all').toBe(
        false
      )
      await expect(topicItem(page, MARKER.topic), 'marker must be gone from the sidebar').toHaveCount(0)
      const markerAfterSql = await page.evaluate(
        (topicId) => (window as any).api.chatDb.topicExists({ topicId }),
        MARKER.topic
      )
      expect(markerAfterSql?.value, 'marker must be gone from SQLite after replace-all').toBe(false)

      // Open the imported topic and assert both imported messages render.
      await openImportedTopic(page)
      await expect(messageContainer(page, TEXT_MESSAGE_TARGET_ID)).toBeVisible({ timeout: 30000 })
      await expect(messageContainer(page, ATTACHMENT_MESSAGE_TARGET_ID)).toBeVisible({ timeout: 30000 })
      const messages = await readImportedMessages(page)
      expect(messages.totalMessages, 'both imported messages must be present').toBe(2)
      expect(messages.messageIds, 'both target message ids must be exposed').toEqual([
        TEXT_MESSAGE_TARGET_ID,
        ATTACHMENT_MESSAGE_TARGET_ID
      ])

      // Valid PNG: visibly renders and is nonblank (DOM + canvas pixel probe).
      await assertPngRenderedNonBlank(page, ATTACHMENT_MESSAGE_TARGET_ID)

      // Valid text document: filename visible + content reads exactly via the
      // existing app-owned fs.readText path (LOCK-E2E-4 decision: no OS
      // external app behavior is asserted).
      const txtContainer = messageContainer(page, ATTACHMENT_MESSAGE_TARGET_ID)
      await expect(
        txtContainer.locator('.message-attachments').getByText('seed-doc.txt', { exact: true }),
        'the imported text document filename must be visible in the message'
      ).toBeVisible()
      const txtPath = path.join(filesDir, 'f-e2e-att-txt.txt')
      const txtContent = await page.evaluate((filePath) => (window as any).api.fs.readText(filePath), txtPath)
      expect(String(txtContent), 'the text document must read the exact deterministic content').toContain(
        'deterministic text attachment'
      )
      expect(String(txtContent), 'the read content must match the seeded payload byte-for-byte').toBe(
        ATTACHMENT_PAYLOADS.txt.toString('utf8')
      )

      // Missing attachment: unavailable placeholder visible (LOCK-UI-2/4).
      const missingPlaceholder = page.locator(
        `[data-message-id="${ATTACHMENT_MESSAGE_TARGET_ID}"] [data-testid="unavailable-image"]`
      )
      await expect(missingPlaceholder, 'the missing attachment placeholder must be visible').toBeVisible()
      await expect(
        missingPlaceholder,
        'the placeholder must carry the retained filename in its accessible name'
      ).toHaveAttribute('aria-label', /seed-missing\.png/)
      await expect(missingPlaceholder, 'the placeholder must render the localized unavailable status').toContainText(
        'Attachment unavailable'
      )

      // Redux marker contract (LOCK-E2E-3): missing block marker true, healthy
      // blocks false/absent.
      const markerState = await page.evaluate(() => {
        const s = (window as any).store?.getState()
        const blocks = s?.messageBlocks?.entities ?? {}
        return {
          missing: blocks['b-e2e-att-missing']?.l2AttachmentUnavailable === true,
          png: blocks['b-e2e-att-png']?.l2AttachmentUnavailable === true,
          txt: blocks['b-e2e-att-txt']?.l2AttachmentUnavailable === true
        }
      })
      expect(markerState.missing, 'the missing-attachment block must carry l2AttachmentUnavailable=true').toBe(true)
      expect(markerState.png, 'the healthy png block must NOT be marked unavailable').toBe(false)
      expect(markerState.txt, 'the healthy txt block must NOT be marked unavailable').toBe(false)

      // LOCK-E2E-4: NO file/imageSize/base64/open/read error for the missing
      // payload may have been emitted while asserting the UI.
      expect(
        missingPayloadErrors,
        'no missing-payload/file-read error may surface during the attachment UI assertions'
      ).toEqual([])

      // Dexie files catalog oracle (drives the file browser).
      const catalogRows = await readFilesStore(page)
      assertImportedCatalog(catalogRows)

      // File browser rows (LOCK-E2E-4).
      await assertFileBrowserRows(page)

      // --- 7. Close the ENTIRE app + post-close hard evidence (LOCK-E2E-5) --
      // LOCK-625: full app close (fixture-owned close + exact-token verify).
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => electronApp.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      await sleep(3000)

      // Post-close SQLite replacement + marker + reference evidence.
      assertPostCloseSqlite(chatDbPath!)
      // Post-close live Files payloads (byte/hash exact, missing absent).
      assertLiveFiles(filesDir)
      // Retained pre-import snapshot + journal/staging cleanup.
      await assertRetainedPreImportSnapshot(dataDir)
      // Empty promoted candidate shells + tmpdir deferred-recovery contract.
      assertOnlyEmptyPromotedCandidateShells(candidateInventoryBefore, dataDir, ownedTmpRoot)

      // --- 8. Relaunch against the SAME disposable profile (LOCK-E2E-5) -----
      relaunched = await relaunchSameProfile({ userDataDir, ownedTmpRoot, mockPort })
      const relaunchedPage = relaunched.page
      installMissingPayloadErrorCapture(relaunchedPage, missingPayloadErrors)
      await waitForMainWindowReady(relaunchedPage)
      await waitForImportedNavigationInRedux(relaunchedPage)

      // Re-open the imported topic: both messages + attachment UI survive.
      await openImportedTopic(relaunchedPage)
      await expect(messageContainer(relaunchedPage, TEXT_MESSAGE_TARGET_ID)).toBeVisible({ timeout: 30000 })
      await expect(messageContainer(relaunchedPage, ATTACHMENT_MESSAGE_TARGET_ID)).toBeVisible({ timeout: 30000 })
      const afterRestart = await readImportedMessages(relaunchedPage)
      expect(afterRestart.totalMessages, 'both imported messages must survive the restart').toBe(2)
      expect(afterRestart.messageIds, 'both target message ids must survive the restart').toEqual([
        TEXT_MESSAGE_TARGET_ID,
        ATTACHMENT_MESSAGE_TARGET_ID
      ])

      // Valid payloads re-verified after relaunch (LOCK-E2E-5).
      await assertPngRenderedNonBlank(relaunchedPage, ATTACHMENT_MESSAGE_TARGET_ID)
      await expect(
        messageContainer(relaunchedPage, ATTACHMENT_MESSAGE_TARGET_ID)
          .locator('.message-attachments')
          .getByText('seed-doc.txt', { exact: true }),
        'the imported text document filename must survive the restart'
      ).toBeVisible()
      const txtContentAfterRestart = await relaunchedPage.evaluate(
        (filePath) => (window as any).api.fs.readText(filePath),
        txtPath
      )
      expect(String(txtContentAfterRestart), 'the text document content must survive the restart').toBe(
        ATTACHMENT_PAYLOADS.txt.toString('utf8')
      )

      // Unavailable marker + UI survive the restart (LOCK-E2E-5).
      await expect(
        relaunchedPage.locator(`[data-message-id="${ATTACHMENT_MESSAGE_TARGET_ID}"] [data-testid="unavailable-image"]`),
        'the missing attachment placeholder must survive the restart'
      ).toBeVisible()
      const markerStateAfterRestart = await relaunchedPage.evaluate(() => {
        const s = (window as any).store?.getState()
        const blocks = s?.messageBlocks?.entities ?? {}
        return {
          missing: blocks['b-e2e-att-missing']?.l2AttachmentUnavailable === true,
          png: blocks['b-e2e-att-png']?.l2AttachmentUnavailable === true,
          txt: blocks['b-e2e-att-txt']?.l2AttachmentUnavailable === true
        }
      })
      expect(markerStateAfterRestart.missing, 'the unavailable marker must survive the restart').toBe(true)
      expect(markerStateAfterRestart.png, 'healthy png must stay unmarked after the restart').toBe(false)
      expect(markerStateAfterRestart.txt, 'healthy txt must stay unmarked after the restart').toBe(false)

      // Live payloads exist + hashes exact after relaunch (node-side read).
      assertLiveFiles(filesDir)

      // File browser catalog + rows survive the restart (LOCK-E2E-5).
      const catalogRowsAfterRestart = await readFilesStore(relaunchedPage)
      assertImportedCatalog(catalogRowsAfterRestart)
      await assertFileBrowserRows(relaunchedPage)

      // LOCK-E2E-4: no missing-payload/file-read error across BOTH pages.
      expect(
        missingPayloadErrors,
        'no missing-payload/file-read error may surface during the post-import AND post-restart attachment UI assertions'
      ).toEqual([])

      // --- 9. Close the relaunched app + final SQLite evidence ---------------
      const relaunchedToClose = relaunched
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => relaunchedToClose.app.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      relaunched = null
      await sleep(3000)
      // The same DB is quiesced again — replacement + references + marker intact.
      assertPostCloseSqlite(chatDbPath!)
      assertLiveFiles(filesDir)
    } catch (error) {
      bodyFailure = error
      throw error
    } finally {
      // ─────────────────────────────────────────────────────────────────────
      // Cleanup (LOCK-E2E-2/5, LOCK-625/624, LOCK-C6/T1/T5) — always runs.
      // ─────────────────────────────────────────────────────────────────────
      if (observer) {
        try {
          await observer.stop()
        } catch {
          // Page may already be gone — observer cleanup is best-effort.
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
      // Defensive sweep: terminate any UNKNOWN process still holding the exact
      // disposable token, excluding the fixture-owned original PID.
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

      // LOCK-E2E-2: source ZIP fingerprint POST-CHECK — runs even on failure,
      // BEFORE any owned artifact is removed.
      if (seed && sourceBefore) {
        try {
          const sourceAfter = await captureSourceFingerprint(seed.zipPath)
          const diffs = compareFingerprints(sourceBefore, sourceAfter)
          if (diffs.length > 0) {
            cleanupErrors.push(`Source ZIP immutability violated after import: ${diffs.join(', ')}`)
          } else {
            console.log(
              `[E2E] Source ZIP fingerprint post-check PASS (sha256[:8]=${sourceAfter.sha256.slice(0, 8)}; size/mtime/inode/mode unchanged)`
            )
          }
        } catch (err) {
          cleanupErrors.push(`Source ZIP post-check failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // LOCK-T1: cleanup failures must fail the test. seed.cleanup() throws on
      // unresolved owned resources; every exact seed path is verified absent.
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
// Console/pageerror capture (LOCK-E2E-4)
// ---------------------------------------------------------------------------

/** Install the forbidden missing-payload/file-read error capture on a page. */
function installMissingPayloadErrorCapture(page: Page, sink: string[]): void {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (MISSING_PAYLOAD_ERROR_RE.test(text)) sink.push(`console.error: ${text}`)
  })
  page.on('pageerror', (error) => {
    const text = error instanceof Error ? error.message : String(error)
    if (MISSING_PAYLOAD_ERROR_RE.test(text)) sink.push(`pageerror: ${text}`)
  })
}

// ---------------------------------------------------------------------------
// Helpers — pre-import setup
// ---------------------------------------------------------------------------

/** Seed the deterministic baseline topic/message/block (replace-all proof). */
async function seedBaselineTarget(page: Page): Promise<void> {
  const appended = await page.evaluate(async () => {
    const chatDb = (window as any).api.chatDb
    const createdAt = '2026-07-30T00:00:00.000Z'
    const message = {
      id: 'm-baseline-att',
      role: 'user',
      status: 'success',
      content: 'baseline attachment-spec target message',
      createdAt,
      topicId: 't-baseline-att',
      blocks: ['b-baseline-att']
    }
    const blocks = [
      {
        id: 'b-baseline-att',
        messageId: 'm-baseline-att',
        type: 'text',
        status: 'success',
        content: 'baseline attachment-spec target block',
        createdAt
      }
    ]
    return chatDb.appendMessage({ topicId: 't-baseline-att', message, blocks })
  })
  expect(appended?.ok, `baseline appendMessage failed: ${JSON.stringify(appended)}`).toBe(true)
}

/**
 * Create the deterministic marker topic in Redux (visible in the sidebar) and
 * persist it to SQLite so the replace-all import must remove it from both
 * planes (LOCK-UI3).
 */
async function createMarkerTopic(page: Page, topicId: string, name: string): Promise<void> {
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

async function topicExistsInRedux(page: Page, topicId: string): Promise<boolean> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    for (const assistant of s.assistants?.assistants ?? []) {
      if ((assistant.topics ?? []).some((t: any) => t.id === topicId)) return true
    }
    return false
  }, topicId)
}

function topicItem(page: Page, topicId: string) {
  return page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
}

function messageContainer(page: Page, messageId: string) {
  return page.locator(`[data-message-id="${messageId}"]`)
}

async function clickAssistantsTab(page: Page): Promise<void> {
  const tab = page.getByRole('button', { name: 'Assistants', exact: false })
  await tab.waitFor({ state: 'visible', timeout: 10000 })
  await tab.click()
  await page.waitForTimeout(300)
}

async function clickTopicsTab(page: Page): Promise<void> {
  const tab = page.getByRole('button', { name: 'Topics', exact: false })
  await tab.waitFor({ state: 'visible', timeout: 10000 })
  await tab.click()
  await page.waitForTimeout(300)
}

/**
 * Wait until the main window is usable again after the in-process reload or a
 * same-profile relaunch: #root attached, Redux store defined, home ready.
 */
async function waitForMainWindowReady(page: Page): Promise<void> {
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
 */
async function waitForImportedNavigationInRedux(page: Page): Promise<void> {
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

/** Open the imported conversation through the visible sidebar. */
async function openImportedTopic(page: Page): Promise<void> {
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
  totalMessages: number
}

async function readImportedMessages(page: Page): Promise<MessageSnapshot> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages?.messageIdsByTopic?.[topicId] ?? []
    return { messageIds: [...msgIds], totalMessages: msgIds.length }
  }, SOURCE_IDS.topic)
}

// ---------------------------------------------------------------------------
// Helpers — attachment UI assertions (LOCK-E2E-4)
// ---------------------------------------------------------------------------

/**
 * The valid PNG block renders a real decoded image and is nonblank. DOM
 * assertion (visible img) is supplemented by a canvas pixel probe
 * (LOCK-E2E-6): the deterministic 1x1 PNG must decode with naturalWidth===1
 * and draw to a 1x1 canvas — a broken/missing payload fails the probe.
 *
 * The selector is narrowed to the stable `.message-content-container` subtree
 * under the exact `data-message-id`: the bare `[data-message-id] img` selector
 * can match the user avatar (rendered via MessageHeader outside the content
 * container), which is not the attachment image. The SAME selector drives both
 * the locator visibility assertion and the waitForFunction probe so the
 * asserted element is the image being probed.
 */
async function assertPngRenderedNonBlank(page: Page, messageId: string): Promise<void> {
  const attachmentImgSelector = `[data-message-id="${messageId}"] .message-content-container img`
  const img = page.locator(attachmentImgSelector).first()
  await expect(img, 'the valid PNG image element must render in the attachment message').toBeVisible()
  await page.waitForFunction(
    (selector: string) => {
      const el = document.querySelector(selector) as HTMLImageElement | null
      return el !== null && el.complete && el.naturalWidth === 1 && el.naturalHeight === 1
    },
    attachmentImgSelector,
    { timeout: 15000 }
  )
  const src = await img.getAttribute('src')
  expect(src, 'the PNG img must carry a file:// source').toContain('file://')
  const probe = await page.evaluate(
    (src: string) =>
      new Promise<{ ok: boolean; width: number; height: number; pixels: number; reason?: string }>((resolve) => {
        const image = new Image()
        image.onload = () => {
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            resolve({ ok: false, width: 0, height: 0, pixels: 0, reason: 'no-2d-context' })
            return
          }
          try {
            ctx.drawImage(image, 0, 0)
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
            resolve({ ok: true, width: canvas.width, height: canvas.height, pixels: data.data.length })
          } catch (error) {
            resolve({ ok: false, width: 0, height: 0, pixels: 0, reason: String(error) })
          }
        }
        image.onerror = () => resolve({ ok: false, width: 0, height: 0, pixels: 0, reason: 'image-decode-failed' })
        image.src = src
      }),
    src ?? ''
  )
  expect(probe.ok, `PNG canvas pixel probe failed: ${probe.reason ?? ''}`).toBe(true)
  expect(probe.width, 'the PNG must decode at its deterministic 1x1 size').toBe(1)
  expect(probe.height, 'the PNG must decode at its deterministic 1x1 size').toBe(1)
  expect(probe.pixels, 'the decoded canvas must carry the full 1x1 pixel buffer').toBe(4)
}

// ---------------------------------------------------------------------------
// Helpers — file browser + Dexie catalog (LOCK-E2E-4)
// ---------------------------------------------------------------------------

/**
 * Read the LIVE Dexie `files` store (raw IndexedDB, app-owned) — the exact
 * catalog that populates the Files page. Deterministic oracle independent of
 * the rendered list.
 */
interface CatalogRowSnapshot {
  id: string
  name: string
  origin_name: string
  ext: string
  type: string | null
  created_at: string | null
  count: number
  path: string
}

async function readFilesStore(page: Page): Promise<CatalogRowSnapshot[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('CherryStudio')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    })
    try {
      return await new Promise<CatalogRowSnapshot[]>((resolve, reject) => {
        const tx = db.transaction('files', 'readonly')
        const req = tx.objectStore('files').getAll()
        req.onsuccess = () => {
          const rows = (req.result as Array<Record<string, unknown>>).map((r) => ({
            id: String(r.id ?? ''),
            name: String(r.name ?? ''),
            origin_name: String(r.origin_name ?? ''),
            ext: String(r.ext ?? ''),
            type: r.type === null || r.type === undefined ? null : String(r.type),
            created_at: r.created_at === null || r.created_at === undefined ? null : String(r.created_at),
            count: typeof r.count === 'number' ? r.count : 0,
            path: String(r.path ?? '')
          }))
          resolve(rows)
        }
        req.onerror = () => reject(req.error ?? new Error('files store read failed'))
      })
    } finally {
      db.close()
    }
  })
}

/**
 * LOCK-E2E-4: the file browser catalog lists exactly png/txt/orphan (healthy
 * rows with origin names), excludes the missing file AND the source-only
 * f-e2e-1 diagnostic row, and every row carries the canonical physical name.
 */
function assertImportedCatalog(rows: CatalogRowSnapshot[]): void {
  const ids = rows.map((r) => r.id).sort()
  expect(ids, 'the Dexie files catalog must list exactly png/txt/orphan').toEqual(EXPECTED_CATALOG_IDS)
  const byId = new Map(rows.map((r) => [r.id, r]))
  expect(byId.get('f-e2e-att-png')?.origin_name).toBe('seed-photo.png')
  expect(byId.get('f-e2e-att-txt')?.origin_name).toBe('seed-doc.txt')
  expect(byId.get('f-e2e-att-orphan')?.origin_name).toBe('seed-orphan.txt')
  // The browser-only orphan is normalized to count 1 (LOCK-FIX-6: healthy
  // unreferenced rows floor their target count at 1 so startup orphan
  // cleanup — count <= 0 — never removes them). The SOURCE fixture row
  // keeps its count 0.
  expect(byId.get('f-e2e-att-orphan')?.count, 'the browser-only orphan must carry normalized count 1').toBe(1)
  for (const row of rows) {
    // LOCK-CAT-5: the catalog apply validates the canonical physical name as
    // exactly `id + ext`; re-assert it deterministically here.
    expect(row.name, 'catalog rows must carry the canonical physical name `<id><ext>`').toBe(`${row.id}${row.ext}`)
  }
}

/**
 * LOCK-E2E-4: the rendered Files page lists png/txt/orphan, excludes the
 * missing file, and renders safely when catalog metadata is null/absent —
 * never "Invalid Date" (LOCK-BROWSE-3).
 */
async function assertFileBrowserRows(page: Page): Promise<void> {
  const sidebarPage = new SidebarPage(page)
  await sidebarPage.goToFiles()
  // The default filter (Document) hides our rows — switch to All Files.
  const allFiles = page.getByText('All Files', { exact: true }).first()
  await allFiles.waitFor({ state: 'visible', timeout: 10000 })
  await allFiles.click()
  await page.waitForTimeout(1000)

  for (const name of ['seed-photo.png', 'seed-doc.txt', 'seed-orphan.txt']) {
    await expect(page.getByText(name, { exact: true }).first(), `the file browser must list ${name}`).toBeVisible({
      timeout: 15000
    })
  }
  await expect(
    page.getByText('seed-missing.png', { exact: true }),
    'the missing file must be excluded from the file browser'
  ).toHaveCount(0)
  await expect(
    page.getByText('Invalid Date', { exact: false }),
    'catalog-imported rows must never render Invalid Date (LOCK-BROWSE-3)'
  ).toHaveCount(0)
}

// ---------------------------------------------------------------------------
// Helpers — post-close SQLite + filesystem evidence (LOCK-E2E-3/5)
// ---------------------------------------------------------------------------

function queryRows(dbPath: string, sql: string): Array<Record<string, unknown>> {
  const result = queryChatDbViaElectron(dbPath, sql)
  // LOCK-QDB-5: fail closed on any failure code — never `rows ?? []`.
  if (!result.ok) throw new Error(`SQLite query failed: ${result.code}`)
  return Array.from(result.rows)
}

/**
 * LOCK-E2E-3/5: post-close chat.db state — integrity/FK exact, replacement
 * contents (marker + baseline removed), exact counts (file_references = 3),
 * unavailable marker in `message_blocks.extra` (missing true / healthy
 * absent), and the exact file_references projection.
 */
async function assertPostCloseSqlite(dbPath: string): Promise<void> {
  const verify = await verifyChatDbViaElectronWithRetry(dbPath)
  if (!verify.ok) throw new Error(`post-close chat.db verification failed: ${verify.code}`)
  expect(verify.value.integrityOk, 'post-close integrity_check must be exactly one-row ok').toBe(true)
  expect(verify.value.foreignKeyViolations, 'post-close foreign_key_check must be exactly empty').toBe(0)
  expect(verify.value.deletedTopics, 'no deleted topics after replace-all').toBe(0)
  expect(verify.value.counts.topics, 'exactly one imported topic').toBe(1)
  expect(verify.value.counts.messages, 'exactly the two imported messages').toBe(2)
  expect(verify.value.counts.message_blocks, 'exactly the four imported blocks').toBe(4)
  expect(verify.value.counts.topic_segments, 'exactly one imported segment').toBe(1)
  expect(verify.value.counts.topic_segment_messages, 'exactly one segment membership').toBe(1)
  expect(verify.value.counts.file_references, 'exactly three file references (LOCK-E2E-3)').toBe(3)

  // Replacement contents: marker + baseline gone, imported topic only.
  const topicIds = queryRows(dbPath, 'SELECT id FROM topics ORDER BY id').map((r) => String(r.id))
  expect(topicIds, 'the imported topic must be the only topic after replace-all').toEqual([SOURCE_IDS.topic])

  // Messages: both imported target ids in source order.
  const messageIds = queryRows(dbPath, 'SELECT id FROM messages ORDER BY sort_order').map((r) => String(r.id))
  expect(messageIds, 'both imported target message ids must be persisted in order').toEqual([
    TEXT_MESSAGE_TARGET_ID,
    ATTACHMENT_MESSAGE_TARGET_ID
  ])

  // Unavailable marker: missing block extra carries the marker; healthy
  // blocks do not.
  const blockRows = queryRows(
    dbPath,
    `SELECT id, extra FROM message_blocks WHERE id IN ('b-e2e-att-png','b-e2e-att-txt','b-e2e-att-missing') ORDER BY id`
  )
  const extraById = new Map(blockRows.map((r) => [String(r.id), r.extra]))
  const missingExtra = extraById.get('b-e2e-att-missing')
  expect(missingExtra, 'the missing block must carry a non-null extra marker').not.toBeNull()
  expect(JSON.parse(String(missingExtra)).l2AttachmentUnavailable, 'missing block marker must be true').toBe(true)
  for (const healthyId of ['b-e2e-att-png', 'b-e2e-att-txt']) {
    const extra = extraById.get(healthyId)
    const hasMarker =
      extra !== null &&
      extra !== undefined &&
      String(extra).length > 0 &&
      JSON.parse(String(extra)).l2AttachmentUnavailable === true
    expect(hasMarker, `healthy block ${healthyId} must NOT carry the unavailable marker`).toBe(false)
  }

  // File references: exactly the three attachment blocks, all referencing
  // their source file ids (png/txt/missing).
  const refs = queryRows(dbPath, 'SELECT block_id, file_id FROM file_references ORDER BY block_id')
  expect(refs, 'exactly three file_references rows').toHaveLength(3)
  const refBlockIds = refs.map((r) => String(r.block_id)).sort()
  expect(refBlockIds, 'file_references must cover png/txt/missing blocks').toEqual([...ATTACHMENT_BLOCK_IDS].sort())
  const refFileIds = refs.map((r) => String(r.file_id)).sort()
  expect(refFileIds, 'file_references must reference png/txt/missing file ids').toEqual(
    ['f-e2e-att-missing', 'f-e2e-att-png', 'f-e2e-att-txt'].sort()
  )
}

/**
 * LOCK-E2E-3/5: the live Files directory holds the healthy/orphan payloads
 * byte-exact with matching SHA-256; the missing referenced payload (and the
 * source-only f-e2e-1 diagnostic row) is absent.
 */
function assertLiveFiles(filesDir: string): void {
  for (const file of HEALTHY_LIVE_FILES) {
    const filePath = path.join(filesDir, file.name)
    expect(fs.existsSync(filePath), `live file ${file.name} must exist`).toBe(true)
    const bytes = fs.readFileSync(filePath)
    expect(bytes.equals(file.payload), `live file ${file.name} must be byte-identical to the seed payload`).toBe(true)
    expect(
      createHash('sha256').update(bytes).digest('hex'),
      `live file ${file.name} sha256 must equal the seed payload sha256`
    ).toBe(HEALTHY_SHA256.get(file.name))
  }
  for (const absentName of ['f-e2e-att-missing.png', 'f-e2e-1.txt']) {
    expect(fs.existsSync(path.join(filesDir, absentName)), `live file ${absentName} must be absent`).toBe(false)
  }
}

/**
 * LOCK-SNAP-2: the retained pre-import snapshot must be a regular non-symlink
 * non-empty file AND pass the bounded readonly integrity plan. It must still
 * hold the marker + baseline records and NOT the imported topic. Journal and
 * every staging sibling are durably cleaned (LOCK-4434/4436/4438).
 */
async function assertRetainedPreImportSnapshot(dataDir: string): Promise<void> {
  const snapshotPath = path.join(dataDir, ROLLBACK_SNAPSHOT_FILENAME)
  assertRetainedSnapshotFile(snapshotPath)

  const snapshotTopics = queryRows(snapshotPath, 'SELECT id FROM topics ORDER BY id').map((r) => String(r.id))
  expect(snapshotTopics, 'the pre-import snapshot must still hold the marker topic').toContain(MARKER.topic)
  expect(snapshotTopics, 'the pre-import snapshot must still hold the baseline topic').toContain(BASELINE.topic)
  expect(snapshotTopics, 'the pre-import snapshot must NOT contain the imported topic').not.toContain(SOURCE_IDS.topic)

  const snapshotVerify = await verifyChatDbViaElectronWithRetry(snapshotPath)
  if (!snapshotVerify.ok) throw new Error(`retained pre-import snapshot verification failed: ${snapshotVerify.code}`)
  expect(snapshotVerify.value.integrityOk, 'retained pre-import snapshot must pass integrity_check').toBe(true)
  expect(snapshotVerify.value.foreignKeyViolations, 'retained pre-import snapshot must pass foreign_key_check').toBe(0)

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
// Helpers — source fingerprint (LOCK-E2E-2, pattern from the real-backup spec)
// ---------------------------------------------------------------------------

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
