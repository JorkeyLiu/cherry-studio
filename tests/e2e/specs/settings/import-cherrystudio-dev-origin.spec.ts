/**
 * E2E: L2 Cherry Studio dev-origin ZIP import — same-PID in-process reload +
 * real Local Storage projection UI (LOCK-DEV-1..8, LOCK-UI1/UI3, LOCK-PROD-6/7).
 *
 * Covers the L2 compatibility dev-origin path end to end, with the principal
 * behavior being (1) the EXACT dev origin `http://localhost:5173` and (2) the
 * non-packaged same-PID in-process reload that no longer exits into a blank
 * process (LOCK-PROD-7):
 *
 *   1. Reproducibly generate a disposable dev-origin source ZIP (real
 *      Chromium at exact `http://localhost:5173`, natural origin mapping to
 *      `http_localhost_5173.indexeddb.leveldb`, no rename/copy, LOCK-DEV-1/2/8).
 *      The ZIP carries the version-215 `persist:cherry-studio` Local Storage
 *      projection with deterministic navigation metadata (DEV_NAV_METADATA).
 *   2. Seed baseline target chat.db data + a deterministic Redux/UI/SQLite
 *      marker topic that the replace-all import MUST remove (LOCK-623,
 *      LOCK-UI3 — pre-import marker present, post-import absent).
 *   3. Start an owned Vite dev server on exact port 5173 serving the
 *      chatImport entry point (LOCK-DEV-5). The server stays alive through
 *      the reload and UI assertions (LOCK-DUI1) and is stopped only after
 *      they finish.
 *   4. Drive `window.api.cherryImport.start(zipPath)` directly (no native
 *      file dialog automation) and observe the status events.
 *   5. Hard terminal evidence (LOCK-622 evidence a): observed status
 *      progression THROUGH `finalizing` with the candidate-ready data-plane
 *      counts 1/1/1/1/1.
 *   6. LOCK-UI1: the import completes with an IN-PROCESS main renderer
 *      reload — the original PID stays alive; no app.relaunch/process exit.
 *      Wait for the reload (pre-import marker vanishes), the real main
 *      window + Redux rehydration, and the one-shot navigation projection
 *      apply (LOCK-PROD-6), then assert the SAME PID again.
 *   7. Post-import UI assertions (LOCK-UI3): marker absent from Redux, the
 *      sidebar, and SQLite; imported assistant/topic name/ownership/order
 *      from the exported DEV_NAV_METADATA; the visible imported topic and
 *      the historical message rendered; no recovered-conversations shell;
 *      the one-shot projection row acked/absent via the getProjection query
 *      seam (LOCK-PROD-6).
 *   8. Stop the owned Vite server, then close the ENTIRE app (fixture-owned
 *      close + exact-token cleanup, LOCK-625) and assert the post-close
 *      SQLite hard evidence: replacement contents (LOCK-622 evidence c),
 *      retained pre-import snapshot + journal/staging cleanup
 *      (LOCK-4434/4436/4438), and the candidate workspace inventory
 *      (LOCK-DEV-8 + LOCK-L3).
 *   9. finally: exact-token defensive sweep (LOCK-625), seed cleanup
 *      (LOCK-624), and owned Vite stop (LOCK-DEV-5). Cleanup failures and
 *      leftover exact paths fail the test (LOCK-C6/T1).
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
 *   - A fresh `pnpm build` (standard E2E prerequisite) including the
 *     LOCK-PROD-7 in-process reload and the navigation projection apply.
 *   - better-sqlite3 rebuilt for the Electron ABI.
 *   - NO external Vite dev server required — this spec owns the Vite lifecycle.
 *
 * Platform: macOS-only (production A-9 gate + `session.fromPath` verified
 * on darwin). Skipped clearly on other platforms.
 *
 * Evidence: B-class pattern with UI evidence — deterministic assertions on
 * authoritative final state (SQLite queries, same-PID survival, Redux/UI
 * projection state) plus rendered/interactive navigation assertions.
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
  createDisposableDevOriginSeedZip,
  DEV_NAV_METADATA,
  DEV_ORIGIN_DIR,
  SEED_NATIVE_VERSION,
  SOURCE_IDS
} from '../../utils/disposable-dev-origin-seed-zip'
import { expectedMessageTargetId } from '../../utils/expected-message-id'
import { assertStateSubsequence, observeImportStatuses, REQUIRED_STATE_CHAIN } from '../../utils/import-status'
import { probeChatImportEntry, startOwnedViteServer } from '../../utils/owned-vite-server'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { sleep } from '../../utils/wait-helpers'
import {
  assertOnlyEmptyPromotedCandidateShells as validateCandidateInventory,
  snapshotCandidateInventory as snapshotOwnedCandidateInventory
} from '../../utils/import-artifact-validation'
import { assertRetainedSnapshotFile } from '../../utils/snapshot-file'

/** Baseline target records the replace-all import MUST remove. */
const BASELINE = { topic: 't-baseline-dev-1', message: 'm-baseline-dev-1', block: 'b-baseline-dev-1' } as const

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
 * replace-all import must remove it from all three planes.
 */
const MARKER = { topic: 't-marker-e2e-dev', name: 'Dev Origin Marker Topic' } as const

/** The reserved recovered-conversations shell assistant id (LOCK-PROD-4). */
const RECOVERED_SHELL_ASSISTANT_ID = 'import-recovered-conversations'

/** Fixed names produced by the promotion pipeline (Phase 4.4). */
const ROLLBACK_SNAPSHOT_FILENAME = 'chat.db.pre-import-backup'
const ROLLBACK_SNAPSHOT_STAGING_FILENAME = 'chat.db.pre-import-backup.staging'
const PROMOTION_JOURNAL_FILENAME = 'chat-import-promotion.journal.json'
const PROMOTION_JOURNAL_STAGING_FILENAME = 'chat-import-promotion.journal.json.staging'

/** One-shot navigation projection key in `migration_state` (LOCK-PROD-6). */
const NAVIGATION_PROJECTION_STATE_KEY = 'import_navigation_projection_v1'

test.describe('Cherry Studio dev-origin ZIP import with same-PID in-process reload', () => {
  test.skip(
    process.platform !== 'darwin',
    'L2 dev-origin import is macOS-only (LOCK-623 + session.fromPath); requires darwin'
  )

  test('imports a disposable dev-origin ZIP, replaces chat.db, reloads in-process on the same PID, and shows the projected navigation', async ({
    electronApp,
    mainWindow,
    userDataDir,
    ownedTmpRoot
  }) => {
    // Fixture launch (120s) + seed generation (120s) + Vite startup (90s) +
    // import flow (120s) + in-process reload + UI lifecycle (120s) + app
    // close + post-close SQL evidence (90s) + cleanup (60s) = 720s budget.
    test.setTimeout(720000)
    const page = mainWindow

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

    // Page-side import status observer (detached after the reload resets it).
    let observer: Awaited<ReturnType<typeof observeImportStatuses>> | null = null

    // LOCK-L3: Test-owned tmpdir candidates to clean in finally (never pre-existing).
    // LOCK-DEV-8: Snapshot of candidate temp workspaces + chat-import-candidates before import.
    const candidateInventoryBefore = snapshotOwnedCandidateInventory(dataDir!, ownedTmpRoot)

    try {
      // ─────────────────────────────────────────────────────────────────────
      // 0. Pre-import marker + deterministic marker topic (LOCK-UI3)
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
        // LOCK-D2/LOCK-DUI3: the ZIP carries the Local Storage projection under
        // the exact persist key — the real UI projection source for this spec.
        expect(seed.evidence.zipHasLocalStorage, 'ZIP must contain Local Storage/leveldb').toBe(true)
        expect(seed.evidence.persistKey, 'seed must carry the persist:cherry-studio key').toBe(
          DEV_NAV_METADATA.persistKey
        )
        console.log('[E2E] Dev-origin seed ZIP evidence:', JSON.stringify(seed.evidence, null, 2))

        // LOCK-N8/N11/LOCK-F2: Verify explicit undefined own-properties
        // survive real Chromium IndexedDB readback. The fixture THROWS inside
        // Chromium if either predicate fails, so a passing seed proves
        // survival; the assertions below re-require both durable booleans to
        // be true on the returned evidence (LOCK-F3).
        expect(
          seed.evidence.readbackUndefinedEvidence.length,
          'readback evidence must cover all undefined fields'
        ).toBeGreaterThan(0)

        // LOCK-F3: The E2E must assert BOTH booleans `.toBe(true)` for every
        // entry. hasOwnProperty and valueIsUndefined are durable booleans
        // that safely cross the serialization boundary (LOCK-C2).
        for (const entry of seed.evidence.readbackUndefinedEvidence) {
          expect(
            entry.hasOwnProperty,
            `LOCK-F3: evidence[${entry.store}/${entry.field}].hasOwnProperty must be true after readback`
          ).toBe(true)
          expect(
            entry.valueIsUndefined,
            `LOCK-F3: evidence[${entry.store}/${entry.field}].valueIsUndefined must be true after readback`
          ).toBe(true)
          expect(entry.store, `evidence[${entry.store}/${entry.field}].store must be truthy`).toBeTruthy()
          expect(entry.field, `evidence[${entry.store}/${entry.field}].field must be truthy`).toBeTruthy()
          expect(entry.recordId, `evidence[${entry.store}/${entry.field}].recordId must be truthy`).toBeTruthy()
          // Expose the actual readback behavior for evidence.
          console.log(
            `[E2E] LOCK-N8 readback: store=${entry.store} field=${entry.field} ` +
              `hasOwnProperty=${entry.hasOwnProperty} valueIsUndefined=${entry.valueIsUndefined}`
          )
        }

        // At least the message nested fields and block field must be covered.
        // LOCK-C3: multiModelMessageStyle is the canonical application field name.
        const readbackFields = seed.evidence.readbackUndefinedEvidence.map((e) => `${e.store}/${e.field}`)
        expect(readbackFields, 'must cover assistantId in messages').toContain('topics.messages[0]/assistantId')
        expect(readbackFields, 'must cover multiModelMessageStyle in messages').toContain(
          'topics.messages[0]/multiModelMessageStyle'
        )
        expect(readbackFields, 'must cover error in message_blocks').toContain('message_blocks/error')

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
        observer = await observeImportStatuses(mainWindow)
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

        // `promoted` races the in-process reload and is best-effort only
        // (LOCK-622): when observed it must come strictly after finalizing.
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

        // --- 6. In-process reload — same PID stays alive (LOCK-UI1) -----------
        // LOCK-UI1: non-packaged/E2E completes via an in-process main renderer
        // reload (LOCK-PROD-7), NOT app.relaunch/process exit. The original PID
        // must survive the whole import — this spec's principal assertion.
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

        // --- 7. Post-import assertions (LOCK-UI3) ------------------------------
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

        // Imported navigation: assistant order/name/emoji + visible topic
        // metadata from the exported DEV_NAV_METADATA (LOCK-DUI3).
        const nav = await readImportedNavigation(page)
        assertImportedNavigation(nav)
        await assertImportedNavigationUI(page)

        // Open the imported topic and see the historical content (LOCK-UI3).
        await openImportedTopic(page)
        await expect(messageContainer(page, TARGET_MESSAGE_ID)).toBeVisible({ timeout: 30000 })
        const historical = await readImportedMessages(page)
        expect(historical.messageIds, 'imported topic must expose the historical message target id').toContain(
          TARGET_MESSAGE_ID
        )
        expect(historical.blocks[SOURCE_IDS.block], 'historical message block content must be present').toContain(
          'Disposable dev-origin seed block'
        )

        // LOCK-PROD-6: the one-shot navigation projection row must be acked
        // (absent) after the apply + durable flush. getProjection is the live
        // query seam — after the ack it returns { ok: true, projection: null }.
        await waitForProjectionAcked(page)
        console.log('[E2E] Navigation projection one-shot acked (getProjection → null)')

        // --- 8. Stop owned Vite server (LOCK-DEV-5) ---------------------------
        // The Vite server was only needed for the import reader and must stay
        // alive until the assertions above finished (LOCK-DUI1). stop() is
        // idempotent — the finally block may call it again safely.
        if (viteServer) {
          try {
            await viteServer.stop()
          } catch (err) {
            cleanupErrors.push(`Vite server stop failed: ${err instanceof Error ? err.message : String(err)}`)
          }
          viteServer = null
        }

        // --- 9. Close the ENTIRE app + post-close SQLite evidence ---------------
        // LOCK-625: fixture-owned close + exact-token verify, WAL flush, then
        // the data-plane hard evidence (the live DB must be quiesced before the
        // file-level queries).
        await closeElectronWithExactCleanup(userDataDir, {
          close: () => electronApp.close(),
          findExactProcesses: findProcessesByUserDataDir,
          terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
        })
        await sleep(3000)

        // Post-close chat.db replacement contents (LOCK-622 evidence c) +
        // the acked projection row absence (LOCK-PROD-6).
        assertReplacementContents(chatDbPath!)
        // Retained pre-import snapshot + journal cleanup (LOCK-4434/36/38).
        await assertRetainedPreImportSnapshot(dataDir)
        // LOCK-DEV-8 + LOCK-L3: Candidate workspace inventory — empty promoted
        // shells only and owned tmp root cherry-import-* deferred-recovery.
        validateCandidateInventory(candidateInventoryBefore, dataDir, ownedTmpRoot)
      } finally {
        // LOCK-625/624: always clean up — exact-token defensive sweep (the
        // original PID is already closed and excluded), then the disposable
        // seed profile + ZIP/work dirs, then the owned Vite server. The
        // fixture owns root removal; the seed cleanup verifies its own
        // artifacts and the spec inventories only ownedTmpRoot (never global
        // temp paths).
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

        // Detach the page-side import status observer if the body never
        // reached the post-reload detach (best-effort — the page may already
        // be gone after the app close or a mid-body failure).
        if (observer) {
          try {
            await observer.stop()
          } catch {
            // Page may already be gone — observer cleanup is best-effort.
          }
          observer = null
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
// Helpers — pre-import setup
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
 * Wait until the imported navigation is present in Redux: the dev-origin
 * assistant (DEV_NAV_METADATA.assistant.id) exists with the visible topic
 * (DEV_NAV_METADATA.topic.id). This is the authoritative signal that the
 * one-shot projection applied on rehydration (LOCK-PROD-6).
 */
async function waitForImportedNavigationInRedux(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    ({ assistantId, topicId }) => {
      const s = (window as any).store?.getState()
      const list = s?.assistants?.assistants
      if (!Array.isArray(list) || list.length === 0) return false
      const first = list.find((a: any) => a.id === assistantId)
      if (!first) return false
      return Array.isArray(first.topics) && first.topics.some((t: any) => t.id === topicId)
    },
    { assistantId: DEV_NAV_METADATA.assistant.id, topicId: DEV_NAV_METADATA.topic.id },
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
      hasDeletedTopic: assistants.some((a) => a.topics.some((t) => t.deletedAt !== null))
    }
  }, RECOVERED_SHELL_ASSISTANT_ID)
}

/**
 * LOCK-UI3 contract assertions against the exported DEV_NAV_METADATA: the
 * single dev-origin assistant shell in source order with the visible topic
 * under the OUTER container, carrying the exact exported metadata; no
 * recovered-conversations shell (the IDB topic matches LS metadata, so
 * recoveredTopicIds is empty) and no deleted topic surfaced.
 */
function assertImportedNavigation(nav: NavigationSnapshot): void {
  expect(
    nav.assistants.map((a) => a.id),
    'imported assistant order must be source order'
  ).toEqual([DEV_NAV_METADATA.assistant.id])
  expect(nav.assistants[0].name).toBe(DEV_NAV_METADATA.assistant.name)
  expect(nav.assistants[0].emoji).toBe(DEV_NAV_METADATA.assistant.emoji)

  const visibleTopic = nav.assistants[0].topics.find((t) => t.id === DEV_NAV_METADATA.topic.id)
  expect(
    visibleTopic,
    `visible topic ${DEV_NAV_METADATA.topic.id} must be present under the first assistant`
  ).toBeTruthy()
  expect(visibleTopic!.assistantId, 'the OUTER container owns grouping').toBe(DEV_NAV_METADATA.assistant.id)
  expect(visibleTopic!.name).toBe(DEV_NAV_METADATA.topic.name)
  expect(visibleTopic!.pinned).toBe(DEV_NAV_METADATA.topic.pinned)
  expect(visibleTopic!.isNameManuallyEdited).toBe(DEV_NAV_METADATA.topic.isNameManuallyEdited)
  expect(visibleTopic!.createdAt).toBe(DEV_NAV_METADATA.topic.createdAt)
  expect(visibleTopic!.updatedAt).toBe(DEV_NAV_METADATA.topic.updatedAt)
  expect(visibleTopic!.deletedAt).toBeNull()

  expect(nav.hasDeletedTopic, 'no deleted topic may surface in navigation').toBe(false)
  expect(nav.hasRecoveredShell, 'no recovered-conversations shell for this fixture (LOCK-PROD-4)').toBe(false)
}

/** Sidebar/topic UI presence assertions (LOCK-UI3: visible interactions). */
async function assertImportedNavigationUI(page: import('@playwright/test').Page): Promise<void> {
  await clickAssistantsTab(page)
  await expect(
    page.locator('[class*="home-tabs"]').getByText(DEV_NAV_METADATA.assistant.name, { exact: true }).first(),
    'imported assistant must be visible in the sidebar'
  ).toBeVisible()

  await clickTopicsTab(page)
  const item = topicItem(page, DEV_NAV_METADATA.topic.id)
  await expect(item, 'the imported topic must be visible in the topic list').toBeVisible()
  await expect(item, 'the imported topic must carry its projected name').toContainText(DEV_NAV_METADATA.topic.name)
  await expect(
    item.locator('.pin'),
    'the imported topic must NOT render the pinned indicator (pinned=false metadata)'
  ).toHaveCount(0)
}

/**
 * Open the imported conversation through the visible sidebar: activate the
 * imported assistant, switch to the Topics tab, and open the dev-origin topic.
 */
async function openImportedTopic(page: import('@playwright/test').Page): Promise<void> {
  await clickAssistantsTab(page)
  const assistantName = page
    .locator('[class*="home-tabs"]')
    .getByText(DEV_NAV_METADATA.assistant.name, { exact: true })
    .first()
  await assistantName.waitFor({ state: 'visible', timeout: 10000 })
  await assistantName.click()
  await clickTopicsTab(page)
  const item = topicItem(page, DEV_NAV_METADATA.topic.id)
  await item.waitFor({ state: 'visible', timeout: 10000 })
  await item.click()
  // The topic must finish loading before message assertions. Absent/undefined
  // loading flags are treated as "not loading" (same falsy semantics as the
  // ordinary-chat waitForAssistantResponseComplete helpers).
  await page.waitForFunction(
    (topicId: string) => {
      const s = (window as any).store?.getState()
      return !s?.messages?.loadingByTopic?.[topicId]
    },
    DEV_NAV_METADATA.topic.id,
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
  }, DEV_NAV_METADATA.topic.id)
}

/**
 * Wait until the one-shot navigation projection row is acked: the live
 * getProjection query seam (LOCK-PROD-6) returns { ok: true, projection: null }
 * after the renderer applied the projection and durably flushed redux-persist.
 */
async function waitForProjectionAcked(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const api = (window as any).api?.cherryImport
      if (!api || typeof api.getProjection !== 'function') return false
      try {
        const result = await api.getProjection()
        return result?.ok === true && (result?.projection ?? null) === null
      } catch {
        return false
      }
    },
    undefined,
    { timeout: 60000 }
  )
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

  // LOCK-PROD-6/LOCK-DUI3: the one-shot navigation projection row must be
  // acked (absent) after the renderer applied it and flushed redux-persist.
  const projectionRows = queryRows(
    dbPath,
    `SELECT key FROM migration_state WHERE key = '${NAVIGATION_PROJECTION_STATE_KEY}'`
  )
  expect(
    projectionRows,
    'the one-shot navigation projection row must be acked/absent after apply (LOCK-PROD-6)'
  ).toEqual([])
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
  // target records and must NOT contain the imported source records.
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

  // LOCK-4436/4438: the journal and every staging sibling are durably cleaned.
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
