/**
 * PERF-100 post-fix batch measurement (production-build Playwright E2E).
 *
 * Purpose (completed production outcome, docs/performance-workstreams.md §3):
 *   Deterministic, bounded, correctness-first measurements for the three
 *   PERF-100 message-interaction paths, run against a FRESH production build
 *   via the standard shared E2E fixture:
 *     1. edit-mode entry/exit  (renderer-only subtree remount)
 *     2. multi-message middle insertion via the Redux clipboard copy/paste
 *        keyboard flow (ONE atomic `pasteMessagesToTopic` batch IPC + one
 *        ordered `messagesReceived` projection commit)
 *     3. multi-model answer-tab switching (two `updateMessageAndBlocks`
 *        writes, fold/tag render switch, 200ms smooth-scroll floor)
 *   Output is a machine-readable PERF-001 schema v1 JSON summary artifact
 *   (src/main/services/chatDb/__tests__/benchResult.ts) written to the
 *   gitignored `test-results/bench-results/` directory AFTER the test passes.
 *
 * Scale profiles (S0 middle-list scale-curve parameterization, docs/performance-measurement.md §5):
 *   - The DEFAULT profile (no `PERF100_SCALE` env) is the quick fixture: the
 *     original workload/metrics/sample counts/artifact id (`perf100-measurement`)
 *     unchanged — edit 5 samples over 8 messages, paste 3 samples over 10
 *     messages (insert index 8; 8 above / 2 below, preserved), answer-tab 4
 *     switches over a 1-user + 3-answer group. It relies on the renderer
 *     default group window (displayCount = 10); no dispatch is performed.
 *   - Opt-in deterministic profiles selected by `PERF100_SCALE=s0-20|s0-100`:
 *     edit/paste/answer topics use exactly 20/100 base messages. The 3 copied
 *     paste groups end immediately before the exact midpoint so the paste
 *     begins at the midpoint with equal base-message counts above and below
 *     (10/10 and 50/50); the answer topic centers the 1-user + 3-answer
 *     multi-model group among deterministic ordinary groups. The renderer
 *     group window is raised through the existing Redux store
 *     (`newMessages/setDisplayCount`) BEFORE activation so the whole base
 *     topic (and the post-paste state) renders, with explicit DOM/Redux
 *     loaded-geometry gates (`paste.loadedMiddleGeometry`,
 *     `answerTab.loadedTopicGeometry`). Profile-specific benchmark ids
 *     (`perf100-measurement-s0-20` / `perf100-measurement-s0-100`) keep the
 *     artifacts distinct; the scale map records numeric profile/geometry
 *     fields. Unsupported `PERF100_SCALE` values fail clearly before
 *     measurement. Large profiles stay on-demand (LOCK-007); the original
 *     gates and all metrics/sample counts remain unchanged for direct
 *     comparison (the paste path's observable contract changed from six
 *     sequential per-insert transitions to ONE batch transition, so the
 *     paste correctness gate + per-insert metrics were replaced by the batch
 *     gate + batch metric below), and two loaded-geometry gates
 *     (`paste.loadedMiddleGeometry`, `answerTab.loadedTopicGeometry`) are
 *     additive for all profiles.
 *
 * Evidence classification (PERF-LOCK-003 / docs/performance-measurement.md §2):
 *   - Deterministic L1 regression evidence when run on a fresh build with the
 *     standard fixture; the numeric metrics remain provisional (L3-style
 *     values) until re-measured per docs/performance-measurement.md §7 — no approved thresholds are asserted
 *     here (only the committed cold-open <500ms gate exists; PERF-100 has
 *     none, PERF-LOCK-005 / docs/performance-measurement.md §7).
 *   - `pnpm ui:observe` is diagnostic only and is NOT a substitute (LOCK-005).
 *
 * Instrumentation boundary (PERF-LOCK-006/008, docs/performance-program.md §1.2 non-goals):
 *   - All instrumentation is installed and removed inside the test page
 *     context only: `store.subscribe` listeners, a MutationObserver, a
 *     temporary `Element.prototype.scrollIntoView` wrapper, and synthetic DOM
 *     clicks / KeyboardEvents that trigger the app's REAL registered handlers
 *     (toggle click handler, edit-mode clipboard keyboard handler, model-label
 *     onClick). No production code is changed, no application instrumentation
 *     is added, and no Main-process wiring is touched.
 *   - Synthetic events are used so the timing start point (performance.now())
 *     lives in the same page task as the interaction dispatch — Playwright's
 *     CDP click would inject an uncontrollable round-trip into the measured
 *     interval. The app cannot distinguish them: the exact same handlers run.
 *   - Direct per-IPC counting is IMPOSSIBLE from the page: Electron's
 *     contextBridge copies and FREEZES non-function values
 *     (https://www.electronjs.org/docs/latest/api/context-bridge), so
 *     `window.api.chatDb` is immutable. IPC counts are therefore proven by
 *     (a) the app source's awaited 1:1 mapping (paste batch →
 *     pasteMessagesToTopic → insertManyAt; answer-tab switch → ONE
 *     selectAnswerMessage command = ONE Main transaction + ONE plural Redux
 *     commit) and (b) renderer-observable proxies (ONE ordered Redux batch
 *     transition, exactly two foldSelected FIELD changes counted per-message
 *     across the entity map, DB deltas via fetchMessages). Timings are
 *     reported as renderer-observable AGGREGATES that may include
 *     serialization/main/SQLite — no internal attribution is claimed
 *     (message-interaction locked decision).
 *
 * Serialization rule: `page.evaluate`/`electronApp.evaluate` callbacks are
 * serialized WITHOUT module closures — every value a callback reads must
 * arrive as an explicit evaluate argument (e.g. `scrollFloorMs`), never as a
 * module-scope identifier.
 *   - Main-process lifecycle tape (failure diagnostics only): installed via
 *     `electronApp.evaluate` BEFORE phase execution and disposed in `finally`.
 *     Records main-window `render-process-gone`, app `child-process-gone`,
 *     and safe load/reload labels (`window-load` on did-finish-load,
 *     `window-navigation` split same/cross-document) so crash/reload/
 *     context-reset is distinguishable from the event sequence alone — the
 *     historical context destruction is NOT assumed to be a renderer crash;
 *     the tape only captures events. Bounded at 64 events (drop-oldest) and
 *     its closed field set is kind / wall+monotonic timestamp / renderer pid /
 *     reason / exitCode / fixed labels — never URLs, paths, message content,
 *     credentials, raw DB sizes, or profile data. The tape never enters the
 *     schema-v1 artifact: it is diagnostics-only, and on failure the bounded
 *     JSON diagnostic is attached via `testInfo.attach` BEFORE fixture
 *     teardown (the successful path attaches nothing; the existing
 *     [E2E][PERF-100] console lines remain the progress convention).
 *
 * Correctness-first and privacy:
 *   - Every sample asserts its correctness gates BEFORE its timing is
 *     recorded; any failure aborts the test, which means the artifact is only
 *     ever written after the full pass (audit F1-style gate, docs/performance-measurement.md §3).
 *   - No message contents, credentials, attachments, user paths, raw DB
 *     sizes, profile data, model IDs, ask IDs or other sensitive identifiers
 *     enter the metrics/gates/scale — only numbers and fixed non-sensitive
 *     strings. The schema v1 closed set is enforced at write time.
 *
 * Cleanup/abort:
 *   - Instrumentation is detached in `finally` blocks; the fixture owns the
 *     disposable profile/owned-temp-root cleanup (LOCK-001) and closes the
 *     app. A failed sample throws and produces NO artifact.
 *   - On failure, a bounded JSON lifecycle diagnostic (Main-process tape) is
 *     attached via `testInfo.attach` BEFORE the fixture teardown closes the
 *     app; on success nothing is attached (existing console style).
 *   - Bounded-run budget: ~5min test timeout aligned with per-wait bounds
 *     (watchdogs 5-45s, documented at the test body) so a hang fails with a
 *     targeted diagnostic instead of an inflated global timeout.
 */
import * as fs from 'fs'
import * as path from 'path'

import type { ElectronApplication, Page, TestInfo } from '@playwright/test'

import {
  type BenchmarkGate,
  type BenchmarkMetric,
  type BenchmarkResult,
  BENCH_RESULT_SCHEMA_VERSION,
  collectEnvironmentMetadata,
  writeBenchmarkResult
} from '../../../../src/main/services/chatDb/__tests__/benchResult'
import { mean, percentile, sortTimings } from '../../../../src/main/services/chatDb/__tests__/benchMetrics'
import { expect, test } from '../../fixtures/electron.fixture'

// ---------------------------------------------------------------------------
// Deterministic bounded scale (recorded verbatim in the artifact's scale map)
// ---------------------------------------------------------------------------

const SCALE = {
  editModeSamples: 5,
  editModeBaseGroups: 4,
  editModeBaseMessages: 8,
  // Base groups are capped so the seeded messages (each message is its own
  // viewport group: user and assistant carry distinct semantic keys) fit the
  // renderer's default group window (state.messages.displayCount = 10) and
  // every seeded card renders on activation.
  pasteSamples: 3,
  pasteBaseGroups: 5,
  pasteBaseMessages: 10,
  pasteCopiedGroups: 3,
  pasteInsertedMessages: 6,
  answerTabSamples: 4,
  answerTabUserMessages: 1,
  answerTabModelsPerGroup: 3,
  scrollFloorMs: 200
} as const

type ScaleProfileKind = 'quick' | 's0-20' | 's0-100'

/**
 * One closed measurement profile. Sample counts and metric definitions are
 * identical across profiles (direct comparison); the base message counts and
 * the derived middle geometry are what vary. All fields are deterministic.
 */
interface ScaleProfile {
  kind: ScaleProfileKind
  /** Distinct safe benchmark id (schema v1 `benchmark.id`, artifact file name). */
  benchmarkId: string
  benchmarkName: string
  // Sample counts / constants — identical across profiles (preserved).
  editModeSamples: number
  editModeBaseGroups: number
  editModeBaseMessages: number
  pasteSamples: number
  pasteBaseGroups: number
  pasteBaseMessages: number
  pasteCopiedGroups: number
  pasteInsertedMessages: number
  answerTabSamples: number
  answerTabUserMessages: number
  answerTabModelsPerGroup: number
  scrollFloorMs: number
  // Paste middle geometry (deterministic; insertion begins at pasteInsertIndex,
  // a 0-based message index, with pasteAboveCount above / pasteBelowCount below).
  pasteFirstCopiedGroup: number
  pasteLastCopiedGroup: number
  pasteFollowingGroup: number
  pasteInsertIndex: number
  pasteAboveCount: number
  pasteBelowCount: number
  // Answer-tab topic geometry (deterministic; the 1-user + 3-answer multi-model
  // group is centered among ordinary groups when the profile is scaled).
  answerTabTotalMessages: number
  answerTabOrdinaryGroupsBefore: number
  answerTabOrdinaryGroupsAfter: number
  /** Renderer viewport-group capacity (displayCount) required for full render. */
  rendererGroupCapacity: number
  testTimeoutMs: number
}

/** Opt-in env selecting the measurement profile; unset/empty = quick (default). */
const PERF100_SCALE_ENV = 'PERF100_SCALE'

/** Numeric profile identity recorded in the scale map (scale is numeric-only). */
const PROFILE_CODE: Record<ScaleProfileKind, number> = { quick: 0, 's0-20': 1, 's0-100': 2 }

/**
 * The quick profile is the DEFAULT (no env) and reproduces the original
 * workload exactly: 5 edit samples over an 8-message topic, 3 paste samples
 * over a 10-message topic (insert index 8 — 8 above / 2 below, intentionally
 * preserved), and 4 answer-tab switches over a single 1-user + 3-answer
 * multi-model group. It relies on the renderer default group window
 * (displayCount = 10); no dispatch is performed.
 */
const QUICK_PROFILE: ScaleProfile = {
  kind: 'quick',
  benchmarkId: 'perf100-measurement',
  benchmarkName: 'PERF-100 batch measurement (production-build E2E, Electron lane)',
  editModeSamples: SCALE.editModeSamples,
  editModeBaseGroups: SCALE.editModeBaseGroups,
  editModeBaseMessages: SCALE.editModeBaseMessages,
  pasteSamples: SCALE.pasteSamples,
  pasteBaseGroups: SCALE.pasteBaseGroups,
  pasteBaseMessages: SCALE.pasteBaseMessages,
  pasteCopiedGroups: SCALE.pasteCopiedGroups,
  pasteInsertedMessages: SCALE.pasteInsertedMessages,
  answerTabSamples: SCALE.answerTabSamples,
  answerTabUserMessages: SCALE.answerTabUserMessages,
  answerTabModelsPerGroup: SCALE.answerTabModelsPerGroup,
  scrollFloorMs: SCALE.scrollFloorMs,
  pasteFirstCopiedGroup: 1,
  pasteLastCopiedGroup: 3,
  pasteFollowingGroup: 4,
  pasteInsertIndex: 8,
  pasteAboveCount: 8,
  pasteBelowCount: 2,
  answerTabTotalMessages: SCALE.answerTabUserMessages + SCALE.answerTabModelsPerGroup,
  answerTabOrdinaryGroupsBefore: 0,
  answerTabOrdinaryGroupsAfter: 0,
  rendererGroupCapacity: 10,
  testTimeoutMs: 300000
}

/**
 * Build a deterministic S0 middle-list profile over exactly `baseMessages`
 * (20 or 100) base messages for the edit, paste, and answer topics.
 *
 * Paste geometry: `baseMessages` = 2×`baseGroups`; the 3 copied groups are the
 * last 3 groups immediately before the exact midpoint, so the paste begins at
 * the midpoint with equal base-message counts above and below:
 * `pasteInsertIndex = baseMessages / 2`, above = below = baseMessages / 2.
 * Answer geometry: exactly `baseMessages` total messages with the 1-user +
 * 3-answer multi-model group centered among deterministic ordinary groups:
 * `ordinaryBefore = ordinaryAfter = (baseMessages - 4) / 4` groups.
 * The renderer group capacity covers the whole base topic AND the post-paste
 * state (base + 6 inserted messages; every message is its own viewport group,
 * and the 3 answer messages share one multi-model group → answer = total - 2).
 */
function buildScaledProfile(baseMessages: 20 | 100): ScaleProfile {
  const editBaseMessages = baseMessages
  const pasteBaseMessages = baseMessages
  const answerTotalMessages = baseMessages
  const pasteGroups = pasteBaseMessages / 2
  const midGroup = pasteGroups / 2
  const insertIndex = 2 * midGroup
  const ordinaryGroups = (answerTotalMessages - (SCALE.answerTabUserMessages + SCALE.answerTabModelsPerGroup)) / 4
  const rendererGroupCapacity = Math.max(
    editBaseMessages,
    pasteBaseMessages + SCALE.pasteInsertedMessages,
    answerTotalMessages - 2
  )
  return {
    kind: baseMessages === 20 ? 's0-20' : 's0-100',
    benchmarkId: `perf100-measurement-s0-${baseMessages}`,
    benchmarkName: `PERF-100 S0-${baseMessages} middle-list scale-curve measurement (production-build E2E, Electron lane)`,
    editModeSamples: SCALE.editModeSamples,
    editModeBaseGroups: editBaseMessages / 2,
    editModeBaseMessages: editBaseMessages,
    pasteSamples: SCALE.pasteSamples,
    pasteBaseGroups: pasteGroups,
    pasteBaseMessages,
    pasteCopiedGroups: SCALE.pasteCopiedGroups,
    pasteInsertedMessages: SCALE.pasteInsertedMessages,
    answerTabSamples: SCALE.answerTabSamples,
    answerTabUserMessages: SCALE.answerTabUserMessages,
    answerTabModelsPerGroup: SCALE.answerTabModelsPerGroup,
    scrollFloorMs: SCALE.scrollFloorMs,
    pasteFirstCopiedGroup: midGroup - SCALE.pasteCopiedGroups,
    pasteLastCopiedGroup: midGroup - 1,
    pasteFollowingGroup: midGroup,
    pasteInsertIndex: insertIndex,
    pasteAboveCount: insertIndex,
    pasteBelowCount: pasteBaseMessages - insertIndex,
    answerTabTotalMessages: answerTotalMessages,
    answerTabOrdinaryGroupsBefore: ordinaryGroups,
    answerTabOrdinaryGroupsAfter: ordinaryGroups,
    rendererGroupCapacity,
    testTimeoutMs: baseMessages === 100 ? 600000 : 420000
  }
}

/**
 * Resolve the measurement profile from the runner env. Unset/empty keeps the
 * default quick profile (existing behavior); unsupported values fail clearly
 * BEFORE any measurement (the throw happens at the top of the test body, before
 * the fixture phases run).
 */
function resolveScaleProfile(): ScaleProfile {
  const raw = (process.env[PERF100_SCALE_ENV] ?? '').trim()
  if (raw.length === 0) return QUICK_PROFILE
  const normalized = raw.toLowerCase()
  if (normalized === 's0-20') return buildScaledProfile(20)
  if (normalized === 's0-100') return buildScaledProfile(100)
  throw new Error(
    `[PERF-100] unsupported PERF100_SCALE value "${raw}" — expected "s0-20" or "s0-100" (unset/empty keeps the default quick profile)`
  )
}

/**
 * Renderer group capacity to dispatch before topic activation. The quick
 * profile keeps the default window (undefined = no dispatch, behavior
 * unchanged); scaled profiles raise it so the whole topic renders.
 */
function activationCapacity(profile: ScaleProfile): number | undefined {
  return profile.kind === 'quick' ? undefined : profile.rendererGroupCapacity
}

/** Canonical safe command recorded in the artifact (no path segments, audit F3). */
const CANONICAL_COMMAND = 'pnpm test:e2e'

/** Fixed synthetic seed timestamps (deterministic, non-sensitive). */
const SEED_CREATED_AT = '2026-08-13T00:00:00.000Z'

// ---------------------------------------------------------------------------
// Seed factories — deterministic synthetic topics via the typed ChatDb bridge
// ---------------------------------------------------------------------------

interface SeedEntry {
  message: Record<string, unknown>
  blocks: Array<Record<string, unknown>>
}

/**
 * Build `groupCount` user+assistant groups (2 messages, 2 text blocks each)
 * for a deterministic seed topic. Assistant messages carry askId = the user
 * message id so the app groups them exactly like an ordinary chat turn.
 * `groupIndexOffset` shifts the deterministic group ids (`g{offset+i}-u/-a`)
 * so multiple builders can be concatenated without id collisions; the default
 * keeps the original quick behavior exactly.
 */
function buildGroupSeeds(
  topicId: string,
  assistantId: string,
  groupCount: number,
  modelOffset: number,
  groupIndexOffset = 0
): SeedEntry[] {
  const entries: SeedEntry[] = []
  for (let i = 0; i < groupCount; i++) {
    const g = groupIndexOffset + i
    const userId = `${topicId}-g${g}-u`
    const assistantIdMsg = `${topicId}-g${g}-a`
    const userBlockId = `${topicId}-g${g}-ub`
    const assistantBlockId = `${topicId}-g${g}-ab`
    const modelIndex = modelOffset + i
    entries.push({
      message: {
        id: userId,
        role: 'user',
        assistantId,
        topicId,
        status: 'success',
        createdAt: SEED_CREATED_AT,
        blocks: [userBlockId]
      },
      blocks: [
        {
          id: userBlockId,
          messageId: userId,
          type: 'main_text',
          status: 'success',
          content: 'synthetic user block',
          createdAt: SEED_CREATED_AT
        }
      ]
    })
    entries.push({
      message: {
        id: assistantIdMsg,
        role: 'assistant',
        assistantId,
        topicId,
        status: 'success',
        createdAt: SEED_CREATED_AT,
        askId: userId,
        model: { id: `p100-m${modelIndex}`, name: `P100 Model ${modelIndex}` },
        modelId: `p100-m${modelIndex}`,
        blocks: [assistantBlockId]
      },
      blocks: [
        {
          id: assistantBlockId,
          messageId: assistantIdMsg,
          type: 'main_text',
          status: 'success',
          content: 'synthetic assistant block',
          createdAt: SEED_CREATED_AT
        }
      ]
    })
  }
  return entries
}

/**
 * Build the answer-tab topic seed: 1 user message + `modelCount` assistant
 * messages in ONE multi-model group (shared askId), with the first assistant
 * initially foldSelected.
 */
function buildTabTopicSeed(topicId: string, assistantId: string, modelCount: number): SeedEntry[] {
  const userId = `${topicId}-u-0`
  const userBlockId = `${topicId}-ub-0`
  const entries: SeedEntry[] = [
    {
      message: {
        id: userId,
        role: 'user',
        assistantId,
        topicId,
        status: 'success',
        createdAt: SEED_CREATED_AT,
        blocks: [userBlockId]
      },
      blocks: [
        {
          id: userBlockId,
          messageId: userId,
          type: 'main_text',
          status: 'success',
          content: 'synthetic user block',
          createdAt: SEED_CREATED_AT
        }
      ]
    }
  ]
  for (let i = 0; i < modelCount; i++) {
    const assistantIdMsg = `${topicId}-a-${i}`
    const assistantBlockId = `${topicId}-ab-${i}`
    entries.push({
      message: {
        id: assistantIdMsg,
        role: 'assistant',
        assistantId,
        topicId,
        status: 'success',
        createdAt: SEED_CREATED_AT,
        askId: userId,
        model: { id: `p100-m${i}`, name: `P100 Model ${i}` },
        modelId: `p100-m${i}`,
        foldSelected: i === 0,
        blocks: [assistantBlockId]
      },
      blocks: [
        {
          id: assistantBlockId,
          messageId: assistantIdMsg,
          type: 'main_text',
          status: 'success',
          content: 'synthetic assistant block',
          createdAt: SEED_CREATED_AT
        }
      ]
    })
  }
  return entries
}

/**
 * Build a scaled answer-tab topic seed: `groupsBefore` deterministic ordinary
 * groups, then the 1-user + `modelCount`-answer multi-model group (same ids as
 * buildTabTopicSeed: `${topicId}-u-0` / `${topicId}-a-0..` with foldSelected on
 * the first answer), then `groupsAfter` ordinary groups — the multi-model group
 * is exactly centered. Ordinary group ids are offset so before/after never
 * collide (`g0..gK-1` before, `gK..g2K-1` after); model ids use disjoint
 * deterministic offsets so no message in the topic shares a model id.
 */
function buildScaledTabTopicSeed(
  topicId: string,
  assistantId: string,
  groupsBefore: number,
  groupsAfter: number,
  modelCount: number
): SeedEntry[] {
  return [
    ...buildGroupSeeds(topicId, assistantId, groupsBefore, 10, 0),
    ...buildTabTopicSeed(topicId, assistantId, modelCount),
    ...buildGroupSeeds(topicId, assistantId, groupsAfter, 100, groupsBefore)
  ]
}

// ---------------------------------------------------------------------------
// Page-context helpers — seeding, activation, state reads
// ---------------------------------------------------------------------------

/**
 * Set the renderer viewport-group capacity (state.messages.displayCount)
 * through the existing Redux store BEFORE a topic is activated, so the whole
 * seeded topic (and the post-paste state) renders — the message window is
 * created on the first `messagesReceived`, which the activation click below
 * triggers, so the dispatch MUST precede the click. Verifies the dispatched
 * value took effect. Scaled profiles only; the quick profile keeps the
 * renderer default (10) and never dispatches (behavior unchanged).
 */
async function setRendererDisplayCount(page: Page, capacity: number): Promise<void> {
  await page.evaluate((capacity) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: capacity })
  }, capacity)
  const actual = await page.evaluate(() => (window as any).store.getState().messages?.displayCount)
  if (actual !== capacity) {
    throw new Error(`displayCount dispatch failed: expected ${capacity}, got ${String(actual)}`)
  }
}

/**
 * Create a fresh deterministic topic in Redux + SQLite (typed ChatDb bridge:
 * ensureTopic + one appendMessage per seed entry) and make it the active
 * topic via the real sidebar item, so the app loads it into Redux/renders it
 * through the production path. When `displayCapacity` is provided (scaled
 * profiles), the renderer group window is raised BEFORE activation so the
 * whole seeded topic renders.
 */
async function seedAndActivateTopic(
  page: Page,
  topicId: string,
  name: string,
  assistantId: string,
  entries: SeedEntry[],
  displayCapacity?: number
): Promise<void> {
  const result = await page.evaluate(
    async ({ topicId, name, assistantId, entries }) => {
      const store = (window as any).store
      store.dispatch({
        type: 'assistants/addTopic',
        payload: {
          assistantId,
          topic: {
            id: topicId,
            assistantId,
            name,
            createdAt: '2026-08-13T00:00:00.000Z',
            updatedAt: '2026-08-13T00:00:00.000Z'
          }
        }
      })
      const chatDb = (window as any).api.chatDb
      const ensured = await chatDb.ensureTopic({ topicId, assistantId, name })
      if (!ensured?.ok) return { ok: false, error: 'ensureTopic failed' }
      for (const entry of entries) {
        const appended = await chatDb.appendMessage({ topicId, message: entry.message, blocks: entry.blocks })
        if (!appended?.ok) return { ok: false, error: 'appendMessage failed' }
      }
      return { ok: true }
    },
    { topicId, name, assistantId, entries }
  )
  if (!result.ok) throw new Error(`seedAndActivateTopic(${topicId}): ${result.error}`)

  // Scaled profiles raise the group window BEFORE activation (see
  // setRendererDisplayCount) so the window created on the first
  // messagesReceived covers the whole topic.
  if (displayCapacity !== undefined) {
    await setRendererDisplayCount(page, displayCapacity)
  }

  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await item.waitFor({ state: 'visible', timeout: 15000 })
  await item.click()

  await page.waitForFunction(
    ({ topicId, expected }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      return Array.isArray(ids) && ids.length === expected && !s.messages?.loadingByTopic?.[topicId]
    },
    { topicId, expected: entries.length },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (expected) => document.querySelectorAll('#messages [data-message-id]').length === expected,
    entries.length,
    { timeout: 30000 }
  )
}

/** Read only roles/order/foldSelected from the DB via the ChatDb bridge (no content). */
async function readTopicMessages(
  page: Page,
  topicId: string
): Promise<Array<{ id: string; role: string; askId: string | null; foldSelected: boolean }>> {
  return page.evaluate(async (topicId) => {
    const result = await (window as any).api.chatDb.fetchMessages({ topicId })
    if (!result?.ok) throw new Error(`fetchMessages failed for ${topicId}`)
    const messages = result.value.messages as Array<Record<string, unknown>>
    return messages.map((m) => ({
      id: String(m.id),
      role: String(m.role),
      askId: m.askId == null ? null : String(m.askId),
      foldSelected: m.foldSelected === true
    }))
  }, topicId)
}

function readReduxCount(page: Page, topicId: string): Promise<number> {
  return page.evaluate((topicId) => {
    const s = (window as any).store.getState()
    return (s.messages?.messageIdsByTopic?.[topicId] ?? []).length
  }, topicId)
}

/**
 * Explicit loaded-middle-geometry gate for the paste topic (correctness gate
 * `paste.loadedMiddleGeometry`, runs BEFORE the operation): the whole base
 * topic must be loaded in Redux AND rendered in the DOM (scaled profiles rely
 * on the displayCount dispatch), and the insertion anchors must sit exactly at
 * the profile contract — the last copied group's assistant at
 * `pasteInsertIndex - 1` and the following group's user at `pasteInsertIndex`,
 * so the paste begins at the exact midpoint with equal base-message counts
 * above and below (quick keeps its preserved 8 above / 2 below geometry).
 */
async function assertPasteLoadedGeometry(page: Page, topicId: string, profile: ScaleProfile): Promise<void> {
  const reduxCount = await readReduxCount(page, topicId)
  expect(reduxCount, 'paste base topic must be fully loaded in Redux').toBe(profile.pasteBaseMessages)
  const domCount = await page.evaluate(() => document.querySelectorAll('#messages [data-message-id]').length)
  expect(domCount, 'paste base topic must be fully rendered in the DOM').toBe(profile.pasteBaseMessages)
  const rows = await readTopicMessages(page, topicId)
  const ids = rows.map((r) => r.id)
  const lastCopiedAssistantPos = ids.indexOf(`${topicId}-g${profile.pasteLastCopiedGroup}-a`)
  const followingUserPos = ids.indexOf(`${topicId}-g${profile.pasteFollowingGroup}-u`)
  expect(
    lastCopiedAssistantPos,
    `last copied group assistant must sit immediately above the insertion index ${profile.pasteInsertIndex}`
  ).toBe(profile.pasteInsertIndex - 1)
  expect(followingUserPos, 'following group user must sit exactly at the insertion index').toBe(
    profile.pasteInsertIndex
  )
}

/**
 * Explicit loaded-geometry gate for the answer-tab topic (correctness gate
 * `answerTab.loadedTopicGeometry`, runs BEFORE the first switch): the whole
 * base topic must be loaded in Redux AND rendered in the DOM, the multi-model
 * group (1 user + 3 answers) sits at the exact centered index with the
 * ordinary groups split evenly around it (quick has no ordinary groups), and
 * the total equals the profile contract exactly.
 */
async function assertAnswerTopicGeometry(page: Page, topicId: string, profile: ScaleProfile): Promise<void> {
  const reduxCount = await readReduxCount(page, topicId)
  expect(reduxCount, 'answer topic must be fully loaded in Redux').toBe(profile.answerTabTotalMessages)
  const domCount = await page.evaluate(() => document.querySelectorAll('#messages [data-message-id]').length)
  expect(domCount, 'answer topic must be fully rendered in the DOM').toBe(profile.answerTabTotalMessages)
  const rows = await readTopicMessages(page, topicId)
  const ids = rows.map((r) => r.id)
  const multiModelUserIndex = profile.answerTabOrdinaryGroupsBefore * 2
  expect(ids.indexOf(`${topicId}-u-0`), 'multi-model user must sit at the centered index').toBe(multiModelUserIndex)
  expect(ids.indexOf(`${topicId}-a-0`), 'first answer must immediately follow the multi-model user').toBe(
    multiModelUserIndex + 1
  )
  expect(ids.indexOf(`${topicId}-a-1`), 'second answer must follow the first').toBe(multiModelUserIndex + 2)
  expect(ids.indexOf(`${topicId}-a-2`), 'third answer must follow the second').toBe(multiModelUserIndex + 3)
  expect(
    multiModelUserIndex + 4 + profile.answerTabOrdinaryGroupsAfter * 2,
    'centered multi-model group plus ordinary groups must equal the exact total'
  ).toBe(profile.answerTabTotalMessages)
}

/**
 * Untimed preparation: scroll a message into the viewport using the native
 * scrollIntoView (the same utility the app wraps for its smooth-scroll floor).
 * Only needed by scaled answer topics where the centered multi-model group
 * starts outside the initial viewport, so the label hit test inside
 * measureAnswerTabSwitch resolves. The measured interval starts inside that
 * helper, so this prep never enters a timing sample.
 */
async function scrollMessageIntoView(page: Page, messageId: string): Promise<void> {
  await page.evaluate((messageId) => {
    const el = document.getElementById(`message-${messageId}`)
    if (!el) throw new Error(`message ${messageId} not rendered`)
    el.scrollIntoView({ block: 'center' })
  }, messageId)
  // Let the scroll settle (two animation frames) before the label hit test.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
}

/**
 * Blur any element the app's own clipboard guard would treat as text-input
 * focus, so the synthetic Cmd+C/Cmd+V keydowns reach the app's registered
 * handlers. The predicate is defined INLINE inside the `page.evaluate`
 * callback — functions cannot be passed as `page.evaluate` arguments (they are
 * not serializable across the Playwright protocol boundary) — and mirrors the
 * app's own `isTextInputFocused` guard (src/renderer/src/hooks/
 * useClipboardKeyboard.ts) exactly: contentEditable elements, ProseMirror/
 * tiptap editors, text inputs (typed or untyped), and textareas are text-input
 * focus for the app's keydown handler — the app would let the browser handle
 * Cmd+C/Cmd+V natively and the synthetic copy/paste keydowns below would be
 * swallowed. The guard must match the app's own exactly so the blur happens
 * exactly when the app would have deferred to the browser.
 */
async function blurFocusedTextInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement
    if (!active || !(active instanceof HTMLElement)) return
    const isTextInputFocused = (el: HTMLElement): boolean => {
      if (el.isContentEditable) return true
      if (el.classList.contains('ProseMirror') || el.classList.contains('tiptap')) return true
      if (el instanceof HTMLInputElement) {
        const type = el.type
        const textTypes = ['text', 'search', 'url', 'email', 'password', 'number']
        return !type || textTypes.includes(type)
      }
      return el instanceof HTMLTextAreaElement
    }
    if (isTextInputFocused(active)) {
      active.blur()
    }
  })
}

function readEditModeState(page: Page): Promise<{ enabled: boolean; rendered: boolean }> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    return { enabled: s.editMode?.enabled === true, rendered: !!document.querySelector('.edit-mode-message') }
  })
}

/** Toggle edit mode without timing (correctness-only preparation step). */
async function setEditModeState(page: Page, enabled: boolean): Promise<void> {
  const current = await page.evaluate(() => (window as any).store.getState().editMode?.enabled === true)
  if (current === enabled) return
  await page.locator('[data-testid="edit-mode-toggle"]').click()
  await page.waitForFunction(
    (enabled) => {
      const s = (window as any).store?.getState()
      return s?.editMode?.enabled === enabled
    },
    enabled,
    { timeout: 15000 }
  )
  await page.waitForFunction((enabled) => !!document.querySelector('.edit-mode-message') === enabled, enabled, {
    timeout: 15000
  })
}

/**
 * Select a contiguous range of message groups through the real edit-mode
 * click handlers (plain click on the first group, Shift-click on the last).
 */
async function selectGroupRange(
  page: Page,
  firstAskId: string,
  lastAskId: string,
  expectedCount: number
): Promise<void> {
  await page.locator(`[data-message-id="${firstAskId}"]`).click()
  await page.locator(`[data-message-id="${lastAskId}"]`).click({ modifiers: ['Shift'] })
  const ok = await page.evaluate((expectedCount) => {
    const s = (window as any).store.getState()
    return s.editMode?.selectedGroupIds?.length === expectedCount
  }, expectedCount)
  if (!ok) throw new Error(`group selection failed: expected ${expectedCount} selected groups`)
}

/**
 * Populate the Redux clipboard through the edit-mode keyboard copy flow
 * (synthetic Cmd+C into the app's registered window keydown handler).
 */
async function copySelectedGroups(page: Page, expectedGroups: number): Promise<void> {
  await blurFocusedTextInput(page)
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true }))
  })
  const ok = await page.evaluate((expectedGroups) => {
    const s = (window as any).store.getState()
    return s.clipboard?.items?.length === expectedGroups && s.clipboard?.mode === 'copy'
  }, expectedGroups)
  if (!ok) throw new Error(`copy flow failed: expected ${expectedGroups} groups in the Redux clipboard`)
}

// ---------------------------------------------------------------------------
// Timed measurement helpers — instrumentation lives in the page context only
// ---------------------------------------------------------------------------

/**
 * Measure an edit-mode toggle click → rendered signal (`.edit-mode-message`
 * subtree class present/absent) with a MutationObserver so the end timestamp
 * lands on the React commit, not on a polling boundary. Returns ms.
 */
function measureEditModeToggle(page: Page, wantEnabled: boolean): Promise<number> {
  return page.evaluate((wantEnabled) => {
    const store = (window as any).store
    const messages = document.getElementById('messages')
    const toggle = document.querySelector<HTMLElement>('[data-testid="edit-mode-toggle"]')
    if (!messages) throw new Error('messages container not found')
    if (!toggle) throw new Error('edit-mode toggle not found')

    const t0 = performance.now()
    return new Promise<number>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        observer.disconnect()
        reject(new Error(`edit-mode toggle to ${wantEnabled} timed out`))
      }, 30000)
      const observer = new MutationObserver(() => {
        if (settled) return
        const present = !!document.querySelector('.edit-mode-message')
        const enabled = store.getState().editMode?.enabled === wantEnabled
        if (present === wantEnabled && enabled) {
          settled = true
          clearTimeout(timeout)
          observer.disconnect()
          resolve(performance.now() - t0)
        }
      })
      observer.observe(messages, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
      toggle.click()
    })
  }, wantEnabled)
}

interface PasteSample {
  totalMs: number
  /** Paste dispatch -> the single ordered Redux projection commit (batch). */
  batchCommitMs: number
  /** Observed message-count transitions — must be exactly 1 (single batch projection). */
  insertCount: number
}

/**
 * Measure a multi-message middle paste: the edit-mode keyboard paste flow
 * (synthetic Cmd+V into the app's registered handler). A `store.subscribe`
 * listener records the message-count transition(s); with the PERF-100 batch
 * path the WHOLE insertion lands in exactly ONE ordered `messagesReceived`
 * projection commit (one `pasteMessagesToTopic` batch IPC), so exactly one
 * transition is expected per sample. Completion is the Redux `isProcessing`
 * flag returning false with the final count. Returns only numbers —
 * renderer-observable aggregate timing (includes serialization/main/SQLite;
 * no internal attribution).
 *
 * Poll resolution: completion is detected by a 5ms bounded poll, so the
 * recorded `totalMs` is quantized by at most 5ms (recorded in the metric
 * details); `batchCommitMs` comes from the synchronous store.subscribe
 * transition and is NOT poll-quantized.
 */
function measurePasteSample(page: Page, topicId: string, expectedTotal: number): Promise<PasteSample> {
  return page.evaluate(
    async ({ topicId, expectedTotal }) => {
      const store = (window as any).store
      const getCount = () => (store.getState().messages?.messageIdsByTopic?.[topicId] ?? []).length

      const transitions: Array<{ t: number; count: number }> = []
      let lastCount = getCount()
      const unsubscribe = store.subscribe(() => {
        const count = getCount()
        if (count !== lastCount) {
          transitions.push({ t: performance.now(), count })
          lastCount = count
        }
      })
      try {
        const t0 = performance.now()
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true, cancelable: true }))
        const t1 = await new Promise<number>((resolve, reject) => {
          const deadline = Date.now() + 45000
          const check = () => {
            const s = store.getState()
            const count = getCount()
            if (!s.editMode?.isProcessing && count === expectedTotal) return resolve(performance.now())
            if (Date.now() > deadline) return reject(new Error('paste completion timeout'))
            setTimeout(check, 5)
          }
          check()
        })
        const batchCommitMs = transitions.length > 0 ? transitions[0]!.t - t0 : -1
        return { totalMs: t1 - t0, batchCommitMs, insertCount: transitions.length }
      } finally {
        unsubscribe()
      }
    },
    { topicId, expectedTotal }
  )
}

interface AnswerTabSample {
  switchMs: number
  foldSettleMs: number
  scrollStartMs: number
  flipCount: number
  finalFrom: boolean
  finalTo: boolean
}

/**
 * Measure one answer-tab switch: click a model label in the group menu bar,
 * observe (a) the two `foldSelected` FIELD changes in Redux (the previous
 * selection true→false and the target false→true — exactly two fields
 * changed per switch, counted per-message across the whole entity map so the
 * gate is notification-count agnostic: one atomic DB command + one plural
 * Redux commit delivers both field changes in a single store notification),
 * (b) the rendered `.selected` class moving to the target message, and
 * (c) the 200ms `scrollIntoView` dispatch (captured by a temporary
 * `Element.prototype.scrollIntoView` wrapper, restored in `finally` —
 * geometry-independent, so the floor is provable without depending on
 * viewport size). The scroll timestamp is taken from the TIMER-DRIVEN
 * qualifying call only — the app schedules a 200ms
 * `setTimeoutTimer('setSelectedMessage', ...)` per click
 * (MessageGroup.setSelectedMessage) that dispatches a smooth scroll to the
 * target; earlier render-time scrolls of the target message are excluded so
 * the 200ms floor is measured on the actual floor dispatch, not on the first
 * matching call. Returns only numbers.
 */
function measureAnswerTabSwitch(
  page: Page,
  fromMessageId: string,
  toMessageId: string,
  labelIndex: number,
  scrollFloorMs: number
): Promise<AnswerTabSample> {
  return page.evaluate(
    async ({ fromMessageId, toMessageId, labelIndex, scrollFloorMs }) => {
      const store = (window as any).store
      const originalScrollIntoView = Element.prototype.scrollIntoView
      const scrollCalls: Array<{ t: number; id: string; behavior: string }> = []
      Element.prototype.scrollIntoView = function (this: Element, options?: ScrollIntoViewOptions) {
        scrollCalls.push({
          t: performance.now(),
          id: (this as HTMLElement).id || '',
          behavior: options?.behavior ?? 'auto'
        })
        return originalScrollIntoView.call(this, options)
      }
      try {
        const item = document.querySelector<HTMLElement>(`.group-menu-bar .segmented-list [data-index="${labelIndex}"]`)
        if (!item) throw new Error(`answer-tab label [data-index=${labelIndex}] not found`)

        // PERF-100 field-level gate: count per-message foldSelected CHANGES
        // across the whole message entity map, not store notifications. The
        // pre-fix path fired two separate Redux commits (two notifications);
        // the fixed path fires ONE plural commit (one notification carrying
        // both field changes). Counting per-message field changes keeps the
        // "exactly two foldSelected flips (old=false/new=true)" gate true for
        // both, so the gate verifies the DB-first invariant, not dispatch
        // granularity.
        const snapshotFold = (s: any): Map<string, boolean> => {
          const out = new Map<string, boolean>()
          const entities = s.messages?.entities
          if (!entities) return out
          for (const id of Object.keys(entities)) {
            const msg = entities[id]
            if (msg && typeof msg.foldSelected === 'boolean' && msg.foldSelected === true) out.set(id, true)
          }
          return out
        }
        const pre = snapshotFold(store.getState())
        const preFrom = pre.get(fromMessageId) === true
        const preTo = pre.get(toMessageId) === true

        let flipCount = 0
        let flipsSettledAt = -1
        let lastFrom = preFrom
        let lastTo = preTo
        let lastSnapshot = pre
        const unsubscribe = store.subscribe(() => {
          const s = store.getState()
          const from = snapshotFold(s).get(fromMessageId) === true
          const to = snapshotFold(s).get(toMessageId) === true
          if (from !== lastFrom || to !== lastTo) {
            const cur = snapshotFold(s)
            let changed = 0
            const allIds = new Set([...lastSnapshot.keys(), ...cur.keys()])
            for (const id of allIds) {
              if ((lastSnapshot.get(id) ?? false) !== (cur.get(id) ?? false)) changed += 1
            }
            flipCount += changed
            lastSnapshot = cur
            lastFrom = from
            lastTo = to
            if (!from && to && flipsSettledAt < 0) flipsSettledAt = performance.now()
          }
        })
        try {
          // Playwright-style hit test: dispatch the click on the INNERMOST
          // element at the label's center. Clicking the item wrapper directly
          // would target the wrapper itself, whose handler path never includes
          // the descendant SegmentedItem's onClick.
          const rect = item.getBoundingClientRect()
          const hitTarget = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2
          ) as HTMLElement | null
          if (!hitTarget) throw new Error('no hit target at the label center')
          const t0 = performance.now()
          hitTarget.click()

          const deadline = Date.now() + 30000
          const tRender = await new Promise<number>((resolve, reject) => {
            let settled = false
            const targetEl = document.getElementById(`message-${toMessageId}`)
            if (!targetEl) {
              reject(new Error(`target message element #message-${toMessageId} not found`))
              return
            }
            const timeout = setTimeout(() => {
              if (settled) return
              settled = true
              observer.disconnect()
              const diag = {
                rendered: targetEl.classList.contains('selected'),
                flipCount,
                lastFrom,
                lastTo,
                labelIndex
              }
              reject(new Error(`answer-tab switch completion timeout: ${JSON.stringify(diag)}`))
            }, deadline - Date.now())
            const finish = (t: number) => {
              if (settled) return
              settled = true
              clearTimeout(timeout)
              observer.disconnect()
              resolve(t)
            }
            const isComplete = () => {
              const s = store.getState()
              const rendered = targetEl.classList.contains('selected')
              const from = s.messages.entities[fromMessageId]?.foldSelected === true
              const to = s.messages.entities[toMessageId]?.foldSelected === true
              return rendered && !from && to
            }
            const observer = new MutationObserver(() => {
              if (isComplete()) finish(performance.now())
            })
            observer.observe(targetEl, { attributes: true, attributeFilter: ['class'] })
            // Poll fallback: when the target flip lands while the old message
            // is still selected, `find(foldSelected)` moves the rendered
            // `.selected` class immediately and the second flip does not
            // change the class again — the observer alone would miss it.
            const poll = () => {
              if (settled) return
              if (isComplete()) return finish(performance.now())
              setTimeout(poll, 5)
            }
            poll()
          })

          // The 200ms smooth-scroll timer fires AFTER the rendered switch
          // settles, so wait (bounded, state-based) for the timer-driven
          // qualifying dispatch on the target message before returning. A
          // qualifying call is: matching target id, smooth behavior (the app's
          // setSelectedMessage always scrolls with behavior 'smooth'), AND
          // dispatched at >= the scroll floor after the click (the app
          // schedules the scroll via a 200ms setTimeoutTimer keyed per click;
          // the floor is passed in explicitly — `page.evaluate` serializes
          // the callback WITHOUT module closures, so the module-scope SCALE
          // is never referenced here). The first matching call alone is NOT
          // proof — earlier render-time scrolls of the target must be excluded
          // so only the timer-driven floor call is selected. The recorded t is
          // the wrapper's actual dispatch timestamp, so the 10ms detection
          // poll adds no quantization to scrollStartMs.
          const findQualifyingScroll = () =>
            scrollCalls.find(
              (c) => c.id === `message-${toMessageId}` && c.behavior === 'smooth' && c.t - t0 >= scrollFloorMs
            )
          const foundScroll = findQualifyingScroll()
          const tScroll =
            foundScroll?.t ??
            (await new Promise<number>((resolve, reject) => {
              const deadline = Date.now() + 5000
              const poll = () => {
                const found = findQualifyingScroll()
                if (found) return resolve(found.t)
                if (Date.now() > deadline) return reject(new Error('timer-driven scrollIntoView dispatch timeout'))
                setTimeout(poll, 10)
              }
              poll()
            }))
          return {
            switchMs: tRender - t0,
            foldSettleMs: flipsSettledAt >= 0 ? flipsSettledAt - t0 : -1,
            scrollStartMs: tScroll - t0,
            flipCount,
            finalFrom: lastFrom,
            finalTo: lastTo
          }
        } finally {
          unsubscribe()
        }
      } finally {
        Element.prototype.scrollIntoView = originalScrollIntoView
      }
    },
    { fromMessageId, toMessageId, labelIndex, scrollFloorMs }
  )
}

// ---------------------------------------------------------------------------
// Main-process lifecycle tape (bounded, in-memory, failure diagnostics only)
//
// Installed/read/disposed via `electronApp.evaluate` (runs in the Electron
// main process). Serialized callbacks take the electron module as their first
// parameter and any explicit argument as the second — no module closures are
// captured. The tape is pure diagnostics: it never enters the schema-v1
// artifact, and its closed field set is kind / wall+monotonic timestamp /
// renderer pid / reason / exitCode / fixed non-sensitive labels only.
// ---------------------------------------------------------------------------

/** Fixed maximum events retained by the lifecycle tape (bounded, drop-oldest). */
const LIFECYCLE_TAPE_MAX_EVENTS = 64

/**
 * Fixed globalThis key shared between the install/read/dispose evaluate calls.
 * No URLs, paths, message content, credentials, raw DB sizes, or profile data
 * are ever stored under it.
 */
const LIFECYCLE_TAPE_STATE_KEY = '__perf100LifecycleTapeV1__'

/**
 * Fixed safe diagnostic code recorded when the Main-process tape read fails.
 * Never the raw evaluate error text, which could embed a machine-local path.
 */
const LIFECYCLE_TAPE_READ_FAILED = 'evaluate-failed' as const

/**
 * One bounded lifecycle tape event. The field set is intentionally closed:
 * kind + wall/monotonic timestamp + renderer pid + Electron reason +
 * exitCode + fixed non-sensitive labels.
 */
interface LifecycleTapeEvent {
  /** Fixed kind: 'render-process-gone' | 'child-process-gone' | 'window-load' | 'window-navigation'. */
  kind: string
  /** Wall-clock ms (Date.now) at capture. */
  t: number
  /** Monotonic ms (performance.now) at capture. */
  mono: number
  /** Renderer process id when known (render-process-gone only). */
  pid?: number
  /** Electron's non-sensitive reason enum when present (e.g. 'crashed', 'killed'). */
  reason?: string
  /** Electron exit code when present. */
  exitCode?: number
  /**
   * Fixed safe label: window scope ('main-window'), navigation type
   * ('same-document' | 'cross-document'), or child-process type
   * (e.g. 'Renderer', 'GPU', 'Utility').
   */
  label?: string
}

/** Bounded JSON diagnostic attached on failure before fixture teardown. */
interface LifecycleTapeDiagnostic {
  spec: string
  scope: string
  outcome: 'failure' | 'tape-read-failed'
  maxEvents: number
  events: LifecycleTapeEvent[]
  /** Fixed safe code when the tape read failed; raw error text is never attached. */
  captureError?: typeof LIFECYCLE_TAPE_READ_FAILED
}

/**
 * Install the Main-process lifecycle tape BEFORE phase execution. Records
 * main-window `render-process-gone`, app `child-process-gone`, and safe
 * load/reload labels (`window-load` on did-finish-load; `window-navigation`
 * split into same/cross-document) so crash/reload/context-reset is
 * distinguishable from the event sequence alone. Bounded at
 * LIFECYCLE_TAPE_MAX_EVENTS (drop-oldest); listeners are removed
 * deterministically via disposeLifecycleTape (same cleanup array). Events are
 * captured without assuming an outcome — a clean exit records the same events
 * as any other exit, only the sequence differs.
 */
async function installLifecycleTape(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(
    async ({ app, BrowserWindow }, { max, stateKey }) => {
      const globalAny = globalThis as any
      if (globalAny[stateKey]) {
        // Deterministic re-install: run the prior cleanup array first.
        const prior = globalAny[stateKey] as { cleanup: Array<() => void> }
        for (const dispose of prior.cleanup ?? []) {
          try {
            dispose()
          } catch {
            // Listener removal must never abort installation.
          }
        }
        delete globalAny[stateKey]
      }

      const events: LifecycleTapeEvent[] = []
      const cleanup: Array<() => void> = []
      const record = (event: Omit<LifecycleTapeEvent, 't' | 'mono'>): void => {
        events.push({ ...event, t: Date.now(), mono: Math.round(performance.now()) })
        if (events.length > max) events.splice(0, events.length - max)
      }

      const onChildProcessGone = (
        _event: unknown,
        details: { type?: string; exitCode?: number; reason?: string }
      ): void => {
        record({
          kind: 'child-process-gone',
          label: typeof details?.type === 'string' && details.type ? details.type : undefined,
          exitCode: typeof details?.exitCode === 'number' ? details.exitCode : undefined,
          reason: typeof details?.reason === 'string' && details.reason ? details.reason : undefined
        })
      }
      app.on('child-process-gone', onChildProcessGone)
      cleanup.push(() => app.removeListener('child-process-gone', onChildProcessGone))

      const instrumentWindow = (win: any): void => {
        const wc = win?.webContents
        if (!wc || wc[stateKey]) return
        wc[stateKey] = true
        const onRenderProcessGone = (_event: unknown, details: { reason?: string; exitCode?: number }): void => {
          let pid: number | undefined
          if (typeof wc.getOSProcessId === 'function') {
            try {
              pid = wc.getOSProcessId()
            } catch {
              pid = undefined
            }
          }
          record({
            kind: 'render-process-gone',
            label: 'main-window',
            pid,
            reason: typeof details?.reason === 'string' && details.reason ? details.reason : undefined,
            exitCode: typeof details?.exitCode === 'number' ? details.exitCode : undefined
          })
        }
        const onDidFinishLoad = (): void => {
          record({ kind: 'window-load', label: 'main-window' })
        }
        const onDidStartNavigation = (details: { isMainFrame?: boolean; isSameDocument?: boolean }): void => {
          if (details?.isMainFrame !== true) return
          record({
            kind: 'window-navigation',
            label: details.isSameDocument === true ? 'same-document' : 'cross-document'
          })
        }
        wc.on('render-process-gone', onRenderProcessGone)
        wc.on('did-finish-load', onDidFinishLoad)
        wc.on('did-start-navigation', onDidStartNavigation)
        cleanup.push(() => {
          wc.removeListener('render-process-gone', onRenderProcessGone)
          wc.removeListener('did-finish-load', onDidFinishLoad)
          wc.removeListener('did-start-navigation', onDidStartNavigation)
          delete wc[stateKey]
        })
      }

      // The measurement run has exactly the main window at install time.
      for (const win of BrowserWindow.getAllWindows()) instrumentWindow(win)

      globalAny[stateKey] = { events, cleanup }
      return events.length
    },
    { max: LIFECYCLE_TAPE_MAX_EVENTS, stateKey: LIFECYCLE_TAPE_STATE_KEY }
  )
}

/**
 * Read the current bounded tape from the Main process. Returns the events or
 * a fixed capture-error marker — after a full process death the evaluate may
 * fail, and the caller must still attach a bounded diagnostic in that case.
 */
async function readLifecycleTape(
  electronApp: ElectronApplication
): Promise<{ ok: true; events: LifecycleTapeEvent[] } | { ok: false }> {
  try {
    const events = await electronApp.evaluate(
      (_electron, { stateKey }) => {
        const tape = (globalThis as any)[stateKey]
        if (!tape || !Array.isArray(tape.events)) return null
        return tape.events as LifecycleTapeEvent[]
      },
      { stateKey: LIFECYCLE_TAPE_STATE_KEY }
    )
    return { ok: true, events: events ?? [] }
  } catch {
    // The raw evaluate error is never surfaced: it could embed a machine-local
    // path. The caller records the fixed LIFECYCLE_TAPE_READ_FAILED code.
    return { ok: false }
  }
}

/**
 * Deterministically remove all tape listeners and drop the Main-process state.
 * Safe after the app has exited (an evaluate failure is swallowed).
 */
async function disposeLifecycleTape(electronApp: ElectronApplication): Promise<void> {
  try {
    await electronApp.evaluate(
      (_electron, { stateKey }) => {
        const globalAny = globalThis as any
        const tape = globalAny[stateKey] as { cleanup: Array<() => void> } | undefined
        if (tape?.cleanup) {
          for (const dispose of tape.cleanup) {
            try {
              dispose()
            } catch {
              // Ignore individual listener removal errors during teardown.
            }
          }
        }
        delete globalAny[stateKey]
      },
      { stateKey: LIFECYCLE_TAPE_STATE_KEY }
    )
  } catch {
    // App process already gone; nothing left to dispose.
  }
}

/**
 * Attach a bounded JSON lifecycle diagnostic via `testInfo` BEFORE the fixture
 * teardown closes the app. Runs on failure only; the successful path attaches
 * nothing (existing style keeps progress in [E2E][PERF-100] console lines).
 */
async function attachLifecycleDiagnostic(testInfo: TestInfo, electronApp: ElectronApplication): Promise<void> {
  const tape = await readLifecycleTape(electronApp)
  const diagnostic: LifecycleTapeDiagnostic = {
    spec: 'perf100-measurement',
    scope: 'main-process lifecycle tape (in-memory, bounded, non-sensitive)',
    outcome: tape.ok ? 'failure' : 'tape-read-failed',
    maxEvents: LIFECYCLE_TAPE_MAX_EVENTS,
    events: tape.ok ? tape.events : [],
    captureError: tape.ok ? undefined : LIFECYCLE_TAPE_READ_FAILED
  }
  await testInfo.attach('perf100-lifecycle-diagnostic', {
    body: JSON.stringify(diagnostic, null, 2),
    contentType: 'application/json'
  })
}

// ---------------------------------------------------------------------------
// Correctness assertions (run before each sample's timing is recorded)
// ---------------------------------------------------------------------------

/**
 * Middle-insertion proof: the pasted ids are strictly between the last
 * selected group's assistant message and the following group's user message,
 * all original ids keep their relative order, and every pasted id is unique.
 * Anchor ids come from the profile so the proof holds for every profile
 * geometry (quick: g3-a / g4-u; scaled: last copied group / midpoint group).
 */
function assertMiddleInsertion(
  before: Array<{ id: string; role: string; askId: string | null; foldSelected: boolean }>,
  after: Array<{ id: string; role: string; askId: string | null; foldSelected: boolean }>,
  topicId: string,
  profile: ScaleProfile
): void {
  const beforeIds = before.map((m) => m.id)
  const afterIds = after.map((m) => m.id)
  const beforeSet = new Set(beforeIds)
  const newIds = afterIds.filter((id) => !beforeSet.has(id))

  expect(newIds).toHaveLength(profile.pasteInsertedMessages)
  expect(new Set(newIds).size, 'pasted ids must be unique').toBe(newIds.length)
  expect(
    afterIds.filter((id) => !new Set(newIds).has(id)),
    'original message order must be preserved after paste'
  ).toEqual(beforeIds)

  const lastSelectedAssistantId = `${topicId}-g${profile.pasteLastCopiedGroup}-a`
  const followingUserId = `${topicId}-g${profile.pasteFollowingGroup}-u`
  const anchorPos = afterIds.indexOf(lastSelectedAssistantId)
  const followingPos = afterIds.indexOf(followingUserId)
  expect(anchorPos, 'last selected group assistant must exist after paste').toBeGreaterThanOrEqual(0)
  expect(followingPos, 'following group user must exist after paste').toBeGreaterThan(anchorPos)
  for (const newId of newIds) {
    const pos = afterIds.indexOf(newId)
    expect(pos, `pasted id ${newId} must be a middle insertion`).toBeGreaterThan(anchorPos)
    expect(pos, `pasted id ${newId} must be before the following group`).toBeLessThan(followingPos)
  }
}

// ---------------------------------------------------------------------------
// Statistics + artifact construction (reuses the v1 contract helpers)
// ---------------------------------------------------------------------------

function summarize(values: number[]): { p50: number; p95: number; mean: number; min: number; max: number } {
  const sorted = sortTimings(values)
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    mean: mean(sorted),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0
  }
}

function statsMetrics(prefix: string, label: string, values: number[]): BenchmarkMetric[] {
  const s = summarize(values)
  return [
    { id: `${prefix}.p50`, name: `${label} p50`, value: s.p50, unit: 'ms' },
    { id: `${prefix}.p95`, name: `${label} p95`, value: s.p95, unit: 'ms' },
    { id: `${prefix}.mean`, name: `${label} mean`, value: s.mean, unit: 'ms' },
    { id: `${prefix}.min`, name: `${label} min`, value: s.min, unit: 'ms' },
    { id: `${prefix}.max`, name: `${label} max`, value: s.max, unit: 'ms' }
  ]
}

interface PhaseSamples {
  editEnter: number[]
  editExit: number[]
  pasteTotal: number[]
  /** Paste dispatch -> the single ordered Redux projection commit (batch). */
  pasteBatchCommit: number[]
  tabSwitch: number[]
  tabFoldSettle: number[]
  tabScrollStart: number[]
}

function buildBenchmarkResult(
  samples: PhaseSamples,
  environment: BenchmarkResult['environment'],
  profile: ScaleProfile
): BenchmarkResult {
  const correctness: BenchmarkGate[] = [
    {
      id: 'editMode.toggle.rendered',
      name: 'edit-mode toggle renders/removes the edit-mode subtree',
      kind: 'correctness',
      passed: true,
      detail: `${profile.editModeSamples}/${profile.editModeSamples} enter samples rendered .edit-mode-message and ${profile.editModeSamples}/${profile.editModeSamples} exit samples removed it (Redux + DOM)`
    },
    {
      id: 'paste.batchTransition',
      name: 'paste inserts exactly 2xM messages in ONE ordered batch projection commit',
      kind: 'correctness',
      passed: true,
      detail: `${profile.pasteSamples}/${profile.pasteSamples} samples observed exactly 1 ordered message-count transition for ${profile.pasteInsertedMessages} inserted messages (2xM=${profile.pasteCopiedGroups}x2); the whole insertion is ONE pasteMessagesToTopic batch IPC (Main transaction + insertManyAt) committed to Redux by ONE messagesReceived projection (window.api is frozen by contextBridge, so the batch count is proven structurally + via Redux/DB proxies, never as a direct IPC observation)`
    },
    {
      id: 'paste.loadedMiddleGeometry',
      name: 'paste topic fully loaded/rendered with the profile middle geometry',
      kind: 'correctness',
      passed: true,
      detail: `base topic (${profile.pasteBaseMessages} messages, ${profile.pasteBaseGroups} groups) loaded in Redux and fully rendered in the DOM (${profile.rendererGroupCapacity}-group capacity); insertion anchors at the profile contract: last copied group assistant at index ${profile.pasteInsertIndex - 1}, following group user at index ${profile.pasteInsertIndex} (above=${profile.pasteAboveCount}, below=${profile.pasteBelowCount})`
    },
    {
      id: 'paste.middleInsertion',
      name: 'paste lands strictly between the last selected group and the following group',
      kind: 'correctness',
      passed: true,
      detail: `${profile.pasteSamples}/${profile.pasteSamples} samples satisfied the middle-insertion order proof`
    },
    {
      id: 'paste.persisted',
      name: 'paste rows persisted via the ChatDb bridge',
      kind: 'correctness',
      passed: true,
      detail: `${profile.pasteSamples}/${profile.pasteSamples} samples showed DB message delta +${profile.pasteInsertedMessages} via fetchMessages`
    },
    {
      id: 'answerTab.foldFlips',
      name: 'answer-tab switch performs exactly two foldSelected field changes',
      kind: 'correctness',
      passed: true,
      detail: `${profile.answerTabSamples}/${profile.answerTabSamples} switches observed exactly 2 foldSelected field changes (previous true→false, target false→true) committed by ONE atomic select-answer-message Main transaction (validated topic ownership + exactly-one selection) and ONE plural Redux commit — counted per-message across the entity map, so the gate holds regardless of store-notification granularity`
    },
    {
      id: 'answerTab.finalFoldState',
      name: 'answer-tab switch final foldSelected state',
      kind: 'correctness',
      passed: true,
      detail: `${profile.answerTabSamples}/${profile.answerTabSamples} switches settled with old=false and target=true`
    },
    {
      id: 'answerTab.renderedSelection',
      name: 'answer-tab switch moves the rendered .selected class to the target message',
      kind: 'correctness',
      passed: true,
      detail: `${profile.answerTabSamples}/${profile.answerTabSamples} switches rendered the target card and hid the previous one`
    },
    {
      id: 'answerTab.scrollFloor',
      name: 'answer-tab switch scroll dispatch honors the 200ms floor',
      kind: 'correctness',
      passed: true,
      detail: `${profile.answerTabSamples}/${profile.answerTabSamples} switches dispatched the timer-driven smooth scrollIntoView on the target message (target id + smooth behavior + t >= ${profile.scrollFloorMs}ms after the click)`
    },
    {
      id: 'answerTab.loadedTopicGeometry',
      name: 'answer-tab topic fully loaded/rendered with the profile total and centered multi-model group',
      kind: 'correctness',
      passed: true,
      detail: `topic (${profile.answerTabTotalMessages} messages, 1 user + ${profile.answerTabModelsPerGroup} answers) loaded in Redux and fully rendered in the DOM (${profile.rendererGroupCapacity}-group capacity); multi-model group at the centered index${
        profile.answerTabOrdinaryGroupsBefore > 0
          ? ` with ${profile.answerTabOrdinaryGroupsBefore} ordinary groups above and ${profile.answerTabOrdinaryGroupsAfter} below`
          : ' (quick: no ordinary groups)'
      }`
    },
    {
      id: 'answerTab.persisted',
      name: 'foldSelected values persisted via the ChatDb bridge',
      kind: 'correctness',
      passed: true,
      detail:
        'DB foldSelected values match the final switch state after all samples (one atomic select-answer-message Main transaction per switch)'
    },
    {
      id: 'privacy.schemaV1',
      name: 'artifact complies with the PERF-001 schema v1 closed set',
      kind: 'correctness',
      passed: true,
      detail:
        'metrics/gates/scale carry only numbers and fixed strings; no message content, credentials, paths, model IDs, ask IDs, or raw DB sizes (enforced at write time)'
    }
  ]

  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: profile.benchmarkId,
      name: profile.benchmarkName,
      scale: {
        profileCode: PROFILE_CODE[profile.kind],
        editModeSamples: profile.editModeSamples,
        editModeBaseGroups: profile.editModeBaseGroups,
        editModeBaseMessages: profile.editModeBaseMessages,
        pasteSamples: profile.pasteSamples,
        pasteBaseGroups: profile.pasteBaseGroups,
        pasteBaseMessages: profile.pasteBaseMessages,
        pasteCopiedGroups: profile.pasteCopiedGroups,
        pasteInsertedMessages: profile.pasteInsertedMessages,
        pasteInsertIndex: profile.pasteInsertIndex,
        pasteAboveCount: profile.pasteAboveCount,
        pasteBelowCount: profile.pasteBelowCount,
        pasteBatchCommitSamples: samples.pasteBatchCommit.length,
        answerTabSamples: profile.answerTabSamples,
        answerTabUserMessages: profile.answerTabUserMessages,
        answerTabModelsPerGroup: profile.answerTabModelsPerGroup,
        answerTabTotalMessages: profile.answerTabTotalMessages,
        answerTabOrdinaryGroupsBefore: profile.answerTabOrdinaryGroupsBefore,
        answerTabOrdinaryGroupsAfter: profile.answerTabOrdinaryGroupsAfter,
        rendererGroupCapacity: profile.rendererGroupCapacity,
        scrollFloorMs: profile.scrollFloorMs
      }
    },
    environment,
    metrics: [
      ...statsMetrics('editMode.enter', 'Edit-mode entry click -> rendered subtree', samples.editEnter),
      ...statsMetrics('editMode.exit', 'Edit-mode exit click -> rendered subtree removed', samples.editExit),
      ...statsMetrics(
        'paste.total',
        'Multi-message middle paste click -> completion (aggregate; completion-poll resolution <= 5ms)',
        samples.pasteTotal
      ),
      ...statsMetrics(
        'paste.batch.commit',
        'Paste dispatch -> the single ordered Redux projection commit (ONE pasteMessagesToTopic batch IPC + insertManyAt; store.subscribe-sampled, not poll-quantized)',
        samples.pasteBatchCommit
      ),
      ...statsMetrics('answerTab.switch', 'Answer-tab label click -> rendered .selected', samples.tabSwitch),
      ...statsMetrics(
        'answerTab.foldSettle',
        'Answer-tab label click -> both foldSelected flips settled in Redux',
        samples.tabFoldSettle
      ),
      ...statsMetrics(
        'answerTab.scrollStart',
        'Answer-tab label click -> timer-driven smooth scrollIntoView dispatch (>= 200ms floor)',
        samples.tabScrollStart
      )
    ],
    gates: correctness
  }
}

// ---------------------------------------------------------------------------
// The measurement test — one focused run, three paths, one artifact
// ---------------------------------------------------------------------------

test.describe('PERF-100 batch measurement', () => {
  test('measures edit-mode entry, multi-message middle paste, and answer-tab switching', async ({
    electronApp,
    mainWindow
  }, testInfo) => {
    // Resolve the measurement profile BEFORE anything runs: unset/empty keeps
    // the default quick profile (existing workload/metrics/artifact id); an
    // unsupported PERF100_SCALE value fails clearly here, before measurement.
    const profile = resolveScaleProfile()

    // Bounded-run budget: profile-bounded, aligned with the actual per-wait
    // bounds below. The quick profile keeps the original ~5min bound; scaled
    // profiles get more headroom for the larger seeded topics while every
    // per-sample wait stays individually bounded (watchdogs 5-45s, see
    // seedAndActivateTopic/setEditModeState/measure* helpers) — a hang fails
    // with a targeted diagnostic well inside the run bound instead of riding
    // out an inflated global timeout.
    test.setTimeout(profile.testTimeoutMs)
    const page = mainWindow

    // Main-process lifecycle tape BEFORE phase execution: bounded, in-memory,
    // failure diagnostics only (never enters the schema-v1 artifact).
    await installLifecycleTape(electronApp)

    try {
      const assistantId = await page.evaluate(() => (window as any).store.getState().assistants?.assistants?.[0]?.id)
      expect(assistantId, 'the fixture must provide a default assistant').toBeTruthy()

      const samples: PhaseSamples = {
        editEnter: [],
        editExit: [],
        pasteTotal: [],
        pasteBatchCommit: [],
        tabSwitch: [],
        tabFoldSettle: [],
        tabScrollStart: []
      }

      // ---- Phase 1: edit-mode entry/exit (renderer-only path) ----------------
      await test.step('Phase 1: edit-mode entry/exit', async () => {
        const topicId = 'p100-edit-topic'
        await seedAndActivateTopic(
          page,
          topicId,
          'P100 Edit',
          assistantId,
          buildGroupSeeds(topicId, assistantId, profile.editModeBaseGroups, 0),
          activationCapacity(profile)
        )
        for (let i = 0; i < profile.editModeSamples; i++) {
          const enterMs = await measureEditModeToggle(page, true)
          const enterState = await readEditModeState(page)
          expect(enterState.enabled, 'edit mode must be enabled in Redux').toBe(true)
          expect(enterState.rendered, 'edit-mode message subtree must be rendered').toBe(true)
          samples.editEnter.push(enterMs)

          const exitMs = await measureEditModeToggle(page, false)
          const exitState = await readEditModeState(page)
          expect(exitState.enabled, 'edit mode must be disabled in Redux').toBe(false)
          expect(exitState.rendered, 'edit-mode message subtree must be removed').toBe(false)
          samples.editExit.push(exitMs)
        }
        console.log(
          `[E2E][PERF-100] edit-mode: ${profile.editModeSamples} enter + ${profile.editModeSamples} exit samples (profile ${profile.kind})`
        )
      })

      // ---- Phase 2: multi-message middle insertion (fresh topic per sample) --
      await test.step('Phase 2: multi-message middle paste', async () => {
        for (let s = 0; s < profile.pasteSamples; s++) {
          const topicId = `p100-paste-topic-${s}`
          await seedAndActivateTopic(
            page,
            topicId,
            `P100 Paste ${s}`,
            assistantId,
            buildGroupSeeds(topicId, assistantId, profile.pasteBaseGroups, s * profile.pasteBaseGroups),
            activationCapacity(profile)
          )
          // Explicit loaded-middle-geometry gate BEFORE the operation: the whole
          // base topic is loaded in Redux AND rendered in the DOM, with the
          // insertion anchors exactly at the profile contract (scaled: midpoint).
          await assertPasteLoadedGeometry(page, topicId, profile)
          await setEditModeState(page, true)
          await selectGroupRange(
            page,
            `${topicId}-g${profile.pasteFirstCopiedGroup}-u`,
            `${topicId}-g${profile.pasteLastCopiedGroup}-u`,
            profile.pasteCopiedGroups
          )
          await copySelectedGroups(page, profile.pasteCopiedGroups)

          const baseCount = await readReduxCount(page, topicId)
          expect(baseCount, 'base topic must be fully loaded in Redux').toBe(profile.pasteBaseMessages)
          const before = await readTopicMessages(page, topicId)
          expect(before).toHaveLength(profile.pasteBaseMessages)

          // Explicit paste-side focus guard (untimed preparation, mirrors the
          // app's isTextInputFocused check) so the synthetic Cmd+V reaches the
          // app's edit-mode handler even if an earlier step restored text focus.
          await blurFocusedTextInput(page)
          const sample = await measurePasteSample(page, topicId, baseCount + profile.pasteInsertedMessages)

          // Correctness gates BEFORE the sample's timing is recorded.
          expect(
            sample.insertCount,
            `paste must commit the whole insertion (2xM=${profile.pasteInsertedMessages}) in ONE ordered batch projection transition`
          ).toBe(1)
          expect(sample.batchCommitMs, 'the single batch projection must land').toBeGreaterThan(0)
          const after = await readTopicMessages(page, topicId)
          expect(after, 'DB message count must grow by exactly 2xM').toHaveLength(
            before.length + profile.pasteInsertedMessages
          )
          assertMiddleInsertion(before, after, topicId, profile)

          samples.pasteTotal.push(sample.totalMs)
          // The batch projection interval is the paste path's own metric: the
          // dispatch -> single ordered messagesReceived commit interval
          // includes the ONE pasteMessagesToTopic IPC round-trip and the
          // insertManyAt transaction (per-insert intervals no longer exist).
          samples.pasteBatchCommit.push(sample.batchCommitMs)
          await setEditModeState(page, false)
        }
        console.log(
          `[E2E][PERF-100] paste: ${profile.pasteSamples} samples, ${profile.pasteCopiedGroups} groups copied (2xM=${profile.pasteInsertedMessages} inserts per sample in ONE batch transition, profile ${profile.kind})`
        )
      })

      // ---- Phase 3: multi-model answer-tab switching -------------------------
      await test.step('Phase 3: multi-model answer-tab switch', async () => {
        const topicId = 'p100-tabs-topic'
        // Scaled profiles center the 1-user + 3-answer multi-model group among
        // deterministic ordinary groups (exact total per profile); the quick
        // profile keeps the original single multi-model topic builder.
        const tabSeed =
          profile.kind === 'quick'
            ? buildTabTopicSeed(topicId, assistantId, profile.answerTabModelsPerGroup)
            : buildScaledTabTopicSeed(
                topicId,
                assistantId,
                profile.answerTabOrdinaryGroupsBefore,
                profile.answerTabOrdinaryGroupsAfter,
                profile.answerTabModelsPerGroup
              )
        await seedAndActivateTopic(page, topicId, 'P100 Tabs', assistantId, tabSeed, activationCapacity(profile))
        // Loaded-geometry gate BEFORE the first switch: exact total, full
        // render, and the centered multi-model group.
        await assertAnswerTopicGeometry(page, topicId, profile)
        // Scaled topics center the multi-model group mid-list; bring it into
        // the viewport (untimed prep) so the label hit test inside
        // measureAnswerTabSwitch resolves — the measured interval starts there.
        if (profile.kind !== 'quick') {
          await scrollMessageIntoView(page, `${topicId}-a-0`)
        }
        await expect(page.locator('.group-menu-bar')).toBeVisible()

        // Deterministic expanded-mode labels (fresh profile default). Defensive:
        // if compact avatar mode is active, expand it via the real UI toggle.
        const hasExpandedLabels = await page.evaluate(
          () => !!document.querySelector('.group-menu-bar .segmented-list [data-index="0"]')
        )
        if (!hasExpandedLabels) {
          const clicked = await page.evaluate(() => {
            const list = document.querySelector('.group-menu-bar .avatar-group')
            const toggle = list?.previousElementSibling as HTMLElement | null
            if (!toggle) return false
            toggle.click()
            return true
          })
          expect(clicked, 'compact-mode display toggle must be clickable').toBe(true)
          await page.waitForFunction(
            () => !!document.querySelector('.group-menu-bar .segmented-list [data-index="0"]'),
            undefined,
            { timeout: 15000 }
          )
        }

        const switches = [
          { from: `${topicId}-a-0`, to: `${topicId}-a-1`, labelIndex: 1 },
          { from: `${topicId}-a-1`, to: `${topicId}-a-2`, labelIndex: 2 },
          { from: `${topicId}-a-2`, to: `${topicId}-a-0`, labelIndex: 0 },
          { from: `${topicId}-a-0`, to: `${topicId}-a-1`, labelIndex: 1 }
        ] as const

        for (const sw of switches) {
          const sample = await measureAnswerTabSwitch(page, sw.from, sw.to, sw.labelIndex, profile.scrollFloorMs)

          // Correctness gates BEFORE the sample's timing is recorded.
          expect(sample.flipCount, 'exactly two foldSelected field changes per switch (old=false, new=true)').toBe(2)
          expect(sample.finalFrom, 'previous selection must be unselected').toBe(false)
          expect(sample.finalTo, 'target message must be selected').toBe(true)
          expect(sample.foldSettleMs, 'foldSelected flips must settle').toBeGreaterThan(0)
          expect(sample.switchMs, 'rendered .selected switch must complete').toBeGreaterThan(0)
          expect(
            sample.scrollStartMs,
            `scrollIntoView must be dispatched at least ${profile.scrollFloorMs}ms after the click (200ms floor)`
          ).toBeGreaterThanOrEqual(profile.scrollFloorMs)
          await expect(page.locator(`#message-${sw.to}.fold`)).toBeVisible()
          await expect(page.locator(`#message-${sw.from}.fold`)).toBeHidden()

          samples.tabSwitch.push(sample.switchMs)
          samples.tabFoldSettle.push(sample.foldSettleMs)
          samples.tabScrollStart.push(sample.scrollStartMs)
        }

        const dbRows = await readTopicMessages(page, topicId)
        const dbFold = new Map(dbRows.map((r) => [r.id, r.foldSelected]))
        expect(dbFold.get(`${topicId}-a-1`), 'final selected message must persist foldSelected=true').toBe(true)
        expect(dbFold.get(`${topicId}-a-0`), 'unselected message must persist foldSelected=false').toBe(false)
        expect(dbFold.get(`${topicId}-a-2`), 'unselected message must persist foldSelected=false').toBe(false)
        console.log(`[E2E][PERF-100] answer-tab: ${profile.answerTabSamples} switches (profile ${profile.kind})`)
      })

      // ---- Phase 4: emit the schema v1 artifact ONLY after the full pass -----
      await test.step('Phase 4: emit schema v1 artifact', async () => {
        // The measured runtime is the Electron app (ABI 145), while the Playwright
        // runner process is Node. The artifact records the MEASURED runtime's
        // Node version and ABI from the running app (`electronApp.evaluate`), with
        // the runner's pnpm metadata retained from collectEnvironmentMetadata.
        const appRuntime = await electronApp.evaluate(() => ({
          node: process.version,
          abiModules: String(process.versions.modules)
        }))
        const environment: BenchmarkResult['environment'] = {
          ...collectEnvironmentMetadata({ command: CANONICAL_COMMAND }),
          node: appRuntime.node,
          abiLane: 'electron',
          abi: appRuntime.abiModules
        }
        const result = buildBenchmarkResult(samples, environment, profile)
        const artifactPath = writeBenchmarkResult(result)
        expect(fs.existsSync(artifactPath), 'artifact must exist after a passing run').toBe(true)
        // Only a safe basename is printed — absolute machine-local artifact paths
        // never enter logs (privacy/redaction).
        console.log(`[E2E][PERF-100] schema v1 artifact: ${path.basename(artifactPath)} (profile ${profile.kind})`)
      })
    } catch (error) {
      // Attach the bounded lifecycle diagnostic BEFORE the fixture teardown
      // closes the app; the successful path attaches nothing.
      try {
        await attachLifecycleDiagnostic(testInfo, electronApp)
      } catch (attachError) {
        // Never mask the original failure — a failed attach is surfaced via
        // the E2E diagnostic console convention and the test still fails with
        // its original error.
        console.log(`[E2E][PERF-100] lifecycle diagnostic attach failed: ${String(attachError)}`)
      }
      throw error
    } finally {
      // Deterministic listener cleanup — also covers a tape read that failed
      // after a full process death (the dispose evaluate is swallowed).
      await disposeLifecycleTape(electronApp)
    }
  })
})
