/**
 * PERF-101 cache-miss topic-switch measurement (production-build Playwright E2E).
 *
 * Purpose (docs/performance-workstreams.md §2.1, PERF-TOPIC-SWITCH measurement slice +
 * orthogonal S0 matrix extension):
 *   Deterministic, bounded, correctness-first measurements of the CACHE-MISS
 *   topic-switch path — the full-topic Main load + IPC + renderer upsert +
 *   full-topic window/context work (`loadTopicMessagesThunk` →
 *   `dbService.fetchMessages` → `upsertManyBlocks` + `messagesReceived` →
 *   `createLatestMessageWindow` / `reconcileMessageWindow`, `computeContextInfo`,
 *   topic-switch cost model (docs/performance-workstreams.md §2.1)) — against a FRESH production build via the standard shared E2E
 *   fixture. The measured metric is click-to-first-useful-render: from the
 *   real sidebar topic-item click to the first deterministic target-content
 *   DOM signal proving the target topic's REAL content committed (not a
 *   loading shell, not the previous topic). The orthogonal extension adds
 *   test-only W<N profiles (N20/W10, N100/W10, N100/W50) so the TOPIC SIZE N
 *   (seeded message count; drives the O(N) full-topic Main load + renderer
 *   window/context work) can be varied independently of the VISIBLE WINDOW W
 *   (renderer `displayCount`; drives the O(W) window render fanout) — the
 *   existing diagonal/full-topic profiles (N4/W10, N20/W20, N100/W100) keep
 *   their exact meaning. This slice is MEASUREMENT-ONLY:
 *   no runtime optimization, no threshold, and no fix direction is implied
 *   (PERF-LOCK-004/005/007, docs/performance-workstreams.md §4).
 *
 * Cache-miss precondition (proven per sample BEFORE timing):
 *   - The target topic is persisted in Main (SQLite via the typed ChatDb
 *     bridge: `ensureTopic` + one `appendMessage` per seeded message) with
 *     EXACTLY the profile's deterministic message count, AND
 *   - the renderer message cache holds NO entry for it
 *     (`messages.messageIdsByTopic[targetId]` undefined; no target message id
 *     in `messages.entities`) because it was seeded but never activated.
 *   Each sample uses a DISTINCT never-activated target topic (one owned
 *   profile, N distinct seeded targets), so every measured click is a genuine
 *   cache miss — invalid cache-hit repeats are structurally impossible.
 *
 * First useful render (timing endpoint):
 *   The interval starts in the same page task as the interaction dispatch
 *   (`performance.now()` before the synthetic DOM click on the real sidebar
 *   topic item, which triggers the app's REAL onClick handler → setActiveTopic
 *   → `loadTopicMessagesThunk` — Playwright's CDP click would inject an
 *   uncontrollable round-trip into the measured interval). It ends when ALL
 *   of: (a) the target's visible-window BOUNDARY message element is rendered
 *   in `#messages` with its deterministic seed content committed in
 *   textContent — for full-topic profiles (W >= N) that is the topic's
 *   existing deterministic FIRST message (`g0-u`); for W<N windowed profiles
 *   that is the oldest message INSIDE the visible latest window
 *   (chronological index N−W, so proving the whole intended window boundary
 *   is present), (b) Redux holds the full expected target message count (all
 *   N — the full-topic load still lands even when only W render), (c) the
 *   target's loading flag is settled false, (d) `currentTopicId` is the
 *   target, and (e) the DOM shows exactly the expected visible window
 *   (min(N,W) message elements — the window never grew, no scroll expansion).
 *   The secondary `loadCommit` metric records the click → Redux full-count
 *   projection commit interval (store.subscribe-sampled, not poll-quantized),
 *   which includes the full Main load + IPC + serialization; the primary
 *   metric additionally includes the renderer upsert/render work to the first
 *   committed content. All complete-load correctness checks (full Redux topic,
 *   exact visible-window DOM membership/count, block integrity, no
 *   source-topic contamination, W stability, Main parity, no error states)
 *   run as separate gates AFTER the timing is recorded — never part of the
 *   endpoint.
 *
 * Scale profiles (`PERF101_SCALE`; unset/empty = quick). Six S0 profiles form
 * a partial N×W grid that separates the TOPIC SIZE N (seeded message count;
 * drives the O(N) full-topic Main load + renderer window/context work) from
 * the VISIBLE WINDOW W (renderer `displayCount`; drives the O(W) window
 * render fanout). Under the current renderer viewport-group model every
 * seeded message is its own viewport group (user messages and askId-carrying
 * assistant replies have distinct semantic keys —
 * `getMessageGroupSemanticKey`), so viewport-group count == message count,
 * and `displayCount` (a message-count window) caps the rendered latest window
 * at min(N,W) messages (the renderer `setDisplayCount` reducer accepts any
 * test-only W; no production change).
 *   - Diagonal / full-topic profiles (W >= N — the existing three; N and W
 *     co-vary): the whole topic renders, so the endpoint signal is the
 *     topic's deterministic FIRST message and the full-window gates assert
 *     all N messages.
 *     - quick:   N4  / W10  (renderer default window covers the whole
 *       4-message topic; NO displayCount dispatch — behavior unchanged).
 *     - s0-20:   N20 / W20  (displayCount raised to 20 before activation).
 *     - s0-100:  N100 / W100 (displayCount raised to 100 before activation).
 *   - Orthogonal windowed profiles (W < N — NEW in this slice; they separate
 *     N from W: n20-w10 pairs s0-20's N=20 with quick's W=10, n100-w10 pairs
 *     s0-100's N=100 with W=10, n100-w50 pairs s0-100's N=100 with a W=50
 *     point): only the latest min(N,W) = W messages render. The endpoint
 *     signal is the deterministic BOUNDARY message — the oldest message
 *     inside the visible latest window (chronological index N−W), proving the
 *     whole intended window boundary is present — and the window gates assert
 *     exactly the last W message ids.
 *     - n20-w10:  N20 / W10
 *     - n100-w10: N100 / W10
 *     - n100-w50: N100 / W50
 *   300+/profile-level scale points stay out of scope (LOCK-007).
 *   The scale map records profile + topic message count (N) / sample count /
 *   visible window (W = displayCount) / rendered window size (min(N,W)) — the
 *   topic-count vs visible-window distinction is preserved and now separated
 *   (docs/performance-measurement.md §5).
 *
 * Evidence classification (PERF-LOCK-003 / docs/performance-measurement.md §2):
 *   - Deterministic L1 regression evidence when run on a fresh build with the
 *     standard fixture; the numeric metrics remain L3 provisional values until
 *     re-measured per docs/performance-measurement.md §7. No thresholds are asserted (the only committed
 *     threshold remains the cold-open <500ms gate; PERF-101 has none,
 *     PERF-LOCK-005 / docs/performance-measurement.md §7).
 *
 * Instrumentation boundary (PERF-LOCK-006/008, docs/performance-program.md §1.2 non-goals):
 *   - All instrumentation lives in the test page context only: a
 *     `store.subscribe` listener and a MutationObserver installed inside
 *     `page.evaluate`. No production code is changed, no application
 *     instrumentation is added, and no Main-process wiring is touched.
 *   - Serialization rule: `page.evaluate` / `electronApp.evaluate` callbacks
 *     are serialized WITHOUT module closures — every value a callback reads
 *     arrives as an explicit evaluate argument, never as a module-scope
 *     identifier.
 *   - Main-process lifecycle tape (failure diagnostics only): installed via
 *     `electronApp.evaluate` BEFORE phase execution and disposed in `finally`.
 *     Bounded at 64 events (drop-oldest); closed field set (kind /
 *     wall+monotonic timestamp / renderer pid / reason / exitCode / fixed
 *     labels). It never enters the schema-v1 artifact; on failure a bounded
 *     JSON diagnostic is attached via `testInfo.attach` BEFORE fixture
 *     teardown (the successful path attaches nothing).
 *
 * Correctness-first and privacy:
 *   - The timing endpoint itself embeds correctness signals — the target's
 *     visible-window boundary message rendered in `#messages` with its
 *     deterministic content marker, the full Redux count (all N), the exact
 *     expected visible DOM window (min(N,W) elements), the target's loading
 *     flag settled false, and `currentTopicId` === target — so the recorded
 *     interval already ends on real target content, never a loading shell or
 *     the previous topic.
 *     The complete-load correctness gates run as separate checks AFTER the
 *     timing capture, and each sample's timing is admitted to the
 *     samples/artifact ONLY after those gates pass; any failure aborts the
 *     test, so the artifact is only written after the full pass (audit
 *     F1-style gate, docs/performance-measurement.md §3).
 *   - No message contents, credentials, paths, raw DB sizes, profile data,
 *     model IDs or other sensitive identifiers enter metrics/gates/scale —
 *     only numbers and fixed non-sensitive strings (schema v1 closed set,
 *     enforced at write time).
 *
 * Cleanup/abort:
 *   - Instrumentation is detached in `finally` blocks; the fixture owns the
 *     disposable profile/owned-temp-root cleanup (LOCK-001) and closes the
 *     app. A failed sample throws and produces NO artifact.
 *   - Bounded-run budget: profile-bounded test timeouts aligned with per-wait
 *     bounds (watchdogs 5-45s) so a hang fails with a targeted diagnostic
 *     instead of an inflated global timeout.
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

/**
 * Fixed constants shared by every profile. The sample count (one distinct
 * never-activated target topic per sample) and the source/control topic size
 * are identical across profiles so the scale curve compares only the topic
 * message count N (full-topic O(N) work) and the visible window W
 * (O(W) render fanout) — separated orthogonally by the W<N profiles.
 */
const SCALE = {
  /**
   * Source/control topic size in SEED groups — each seed group is one
   * user+assistant pair (2 messages, 1 text block each). This is a seeding
   * concept, not a viewport-group count: in the renderer window model every
   * seeded message is its own viewport group, so a seed pair spans 2 viewport
   * groups (user message keyed `message:user:<id>`, assistant reply keyed
   * `assistant:<askId>`).
   */
  sourceTopicGroups: 2,
  /** Measured cache-miss switches; each uses a distinct never-activated target. */
  samplesPerProfile: 3
} as const

type ScaleProfileKind = 'quick' | 's0-20' | 's0-100' | 'n20-w10' | 'n100-w10' | 'n100-w50'

/** One closed measurement profile — all fields are deterministic. */
interface ScaleProfile {
  kind: ScaleProfileKind
  /** Distinct safe benchmark id (schema v1 `benchmark.id`, artifact file name). */
  benchmarkId: string
  benchmarkName: string
  /** Seeded message count of every target topic (user+assistant groups × 2). */
  targetTopicMessageCount: number
  /** Source/control topic message count (fixed, untimed preparation only). */
  sourceTopicMessageCount: number
  /** Number of measured cache-miss switches (distinct target topics). */
  samplesPerProfile: number
  /**
   * Renderer viewport-window capacity (`messages.displayCount`) W in effect
   * when the target topic's window is created: quick keeps the renderer
   * default (10, no dispatch); the scaled full-topic profiles raise it to N
   * so the whole topic renders; the orthogonal W<N profiles raise it to their
   * window W (< N) so only the latest min(N,W) messages render.
   * `displayCount` is a message-count window that covers the full topic when
   * >= the topic's message count.
   */
  rendererDisplayCount: number
  testTimeoutMs: number
}

/** Opt-in env selecting the measurement profile; unset/empty = quick (default). */
const PERF101_SCALE_ENV = 'PERF101_SCALE'

/**
 * Numeric profile identity recorded in the scale map (scale is numeric-only).
 * The existing diagonal/full-topic codes 0/1/2 are UNCHANGED (their artifacts
 * keep their identity); the new orthogonal W<N profiles get distinct codes.
 */
const PROFILE_CODE: Record<ScaleProfileKind, number> = {
  quick: 0,
  's0-20': 1,
  's0-100': 2,
  'n20-w10': 3,
  'n100-w10': 4,
  'n100-w50': 5
}

/**
 * The quick profile is the DEFAULT (no env): 3 samples over 4-message target
 * topics. The renderer default viewport window (displayCount = 10) covers the
 * whole topic (each seeded message is its own viewport group; all 4 messages
 * render); no dispatch is performed (behavior unchanged).
 */
const QUICK_PROFILE: ScaleProfile = {
  kind: 'quick',
  benchmarkId: 'perf101-topic-switch',
  benchmarkName: 'PERF-101 cache-miss topic-switch measurement (production-build E2E, Electron lane)',
  targetTopicMessageCount: 4,
  sourceTopicMessageCount: SCALE.sourceTopicGroups * 2,
  samplesPerProfile: SCALE.samplesPerProfile,
  rendererDisplayCount: 10,
  testTimeoutMs: 300000
}

/**
 * Build a deterministic S0 profile over exactly `baseMessages` (20 or 100)
 * per target topic. The renderer viewport window is raised to the message
 * count — every seeded message is its own viewport group under the current
 * window model, so a displayCount equal to the message count covers the whole
 * topic (the same convention as the PERF-100 scaled profiles).
 */
function buildScaledProfile(baseMessages: 20 | 100): ScaleProfile {
  return {
    kind: baseMessages === 20 ? 's0-20' : 's0-100',
    benchmarkId: `perf101-topic-switch-s0-${baseMessages}`,
    benchmarkName: `PERF-101 S0-${baseMessages} cache-miss topic-switch scale-curve measurement (production-build E2E, Electron lane)`,
    targetTopicMessageCount: baseMessages,
    sourceTopicMessageCount: SCALE.sourceTopicGroups * 2,
    samplesPerProfile: SCALE.samplesPerProfile,
    rendererDisplayCount: baseMessages,
    testTimeoutMs: baseMessages === 100 ? 600000 : 420000
  }
}

/**
 * Build an orthogonal W<N profile: `n` seeded messages per target topic with
 * a smaller visible window `w` (`displayCount`), so only the latest
 * min(n,w) = w messages render. Distinct benchmark ids/profile codes keep the
 * artifacts collision-free from the diagonal profiles (doc suggestion:
 * `perf101-topic-switch-ortho-n20-w10` / `-n100-w10` / `-n100-w50`).
 */
function buildOrthogonalProfile(
  kind: ScaleProfileKind,
  topicMessageCount: number,
  visibleWindow: number
): ScaleProfile {
  return {
    kind,
    benchmarkId: `perf101-topic-switch-ortho-n${topicMessageCount}-w${visibleWindow}`,
    benchmarkName: `PERF-101 orthogonal N${topicMessageCount}/W${visibleWindow} cache-miss topic-switch window-profile measurement (production-build E2E, Electron lane)`,
    targetTopicMessageCount: topicMessageCount,
    sourceTopicMessageCount: SCALE.sourceTopicGroups * 2,
    samplesPerProfile: SCALE.samplesPerProfile,
    rendererDisplayCount: visibleWindow,
    testTimeoutMs: topicMessageCount === 100 ? 600000 : 420000
  }
}

/** The three new orthogonal W<N profiles (separate N from W). */
const ORTHO_N20_W10 = buildOrthogonalProfile('n20-w10', 20, 10)
const ORTHO_N100_W10 = buildOrthogonalProfile('n100-w10', 100, 10)
const ORTHO_N100_W50 = buildOrthogonalProfile('n100-w50', 100, 50)

/**
 * Resolve the measurement profile from the runner env. Unset/empty keeps the
 * default quick profile; unsupported values fail clearly BEFORE any
 * measurement (the throw happens at the top of the test body, before the
 * fixture phases run).
 */
function resolveScaleProfile(): ScaleProfile {
  const raw = (process.env[PERF101_SCALE_ENV] ?? '').trim()
  if (raw.length === 0) return QUICK_PROFILE
  const normalized = raw.toLowerCase()
  if (normalized === 's0-20') return buildScaledProfile(20)
  if (normalized === 's0-100') return buildScaledProfile(100)
  if (normalized === 'n20-w10') return ORTHO_N20_W10
  if (normalized === 'n100-w10') return ORTHO_N100_W10
  if (normalized === 'n100-w50') return ORTHO_N100_W50
  throw new Error(
    `[PERF-101] unsupported PERF101_SCALE value "${raw}" — expected "s0-20", "s0-100", "n20-w10", "n100-w10" or "n100-w50" (unset/empty keeps the default quick profile)`
  )
}

/**
 * Renderer viewport-window capacity (`messages.displayCount`) to dispatch
 * before the source topic is activated (and therefore before any target's
 * window is created). The quick profile keeps the default window (undefined =
 * no dispatch); scaled full-topic profiles raise it to N so the whole seeded
 * topic renders; the orthogonal W<N profiles raise it to their WINDOW W (not
 * N) so only the latest W messages render — the dispatch MUST precede the
 * first activation click, because the message window is created on the first
 * `messagesReceived`.
 */
function activationCapacity(profile: ScaleProfile): number | undefined {
  return profile.kind === 'quick' ? undefined : profile.rendererDisplayCount
}

/** Canonical safe command recorded in the artifact (no path segments, audit F3). */
const CANONICAL_COMMAND = 'pnpm test:e2e'

/** Fixed synthetic seed timestamps (deterministic, non-sensitive). */
const SEED_CREATED_AT = '2026-08-14T00:00:00.000Z'

// ---------------------------------------------------------------------------
// Seed factories — deterministic synthetic topics via the typed ChatDb bridge
// ---------------------------------------------------------------------------

interface SeedEntry {
  message: Record<string, unknown>
  blocks: Array<Record<string, unknown>>
}

/**
 * Build `groupCount` user+assistant groups (2 messages, 1 text block each) for
 * a deterministic seed topic. Assistant messages carry askId = the user
 * message id so the app groups them exactly like an ordinary chat turn.
 * `modelOffset` keeps model ids disjoint across topics.
 *
 * The block content is deterministic PER topic + group and PER role, so the
 * first-useful-render endpoint can prove a SPECIFIC target's real content
 * committed in the DOM (`textContent.includes(marker)`), and the
 * content-integrity gate can re-derive the exact expected content.
 */
function buildGroupSeeds(topicId: string, assistantId: string, groupCount: number, modelOffset: number): SeedEntry[] {
  const entries: SeedEntry[] = []
  for (let i = 0; i < groupCount; i++) {
    const userId = `${topicId}-g${i}-u`
    const assistantIdMsg = `${topicId}-g${i}-a`
    const userBlockId = `${topicId}-g${i}-ub`
    const assistantBlockId = `${topicId}-g${i}-ab`
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
          content: `p101 seed user ${topicId} g${i}`,
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
        model: { id: `p101-m${modelIndex}`, name: `P101 Model ${modelIndex}` },
        modelId: `p101-m${modelIndex}`,
        blocks: [assistantBlockId]
      },
      blocks: [
        {
          id: assistantBlockId,
          messageId: assistantIdMsg,
          type: 'main_text',
          status: 'success',
          content: `p101 seed assistant ${topicId} g${i}`,
          createdAt: SEED_CREATED_AT
        }
      ]
    })
  }
  return entries
}

/** Deterministic first-message id of a seeded topic (the first user message). */
function firstMessageId(topicId: string): string {
  return `${topicId}-g0-u`
}

/**
 * Visible-window message count = min(N,W): the whole topic when the window
 * covers it (W >= N), otherwise exactly W — the renderer latest-window model
 * (`createLatestMessageWindow` with groupCapacity = W) renders the last
 * min(N,W) groups.
 */
function visibleWindowMessageCount(topicMessageCount: number, rendererDisplayCount: number): number {
  return Math.min(topicMessageCount, rendererDisplayCount)
}

/**
 * Chronological index of the visible latest window's BOUNDARY message — the
 * OLDEST message inside that window (index N−W; 0 when the window covers the
 * whole topic). Each seeded message is its own viewport group, so the window
 * spans chronological indexes [max(0,N−W), N−1]; the boundary is the first of
 * them, and proving its content committed proves the whole intended window
 * boundary is present.
 */
function windowBoundaryIndex(topicMessageCount: number, rendererDisplayCount: number): number {
  return Math.max(0, topicMessageCount - rendererDisplayCount)
}

// ---------------------------------------------------------------------------
// Page-context helpers — seeding, activation, state reads
// ---------------------------------------------------------------------------

/**
 * Set the renderer viewport-group capacity (`state.messages.displayCount`)
 * through the existing Redux store BEFORE a topic is activated, so the whole
 * seeded topic renders — the message window is created on the first
 * `messagesReceived`, which the activation click triggers, so the dispatch
 * MUST precede the click. Verifies the dispatched value took effect. Scaled
 * profiles only; the quick profile keeps the renderer default and never
 * dispatches.
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
 * Persist a topic in Main (typed ChatDb bridge: ensureTopic + one
 * appendMessage per seed entry) and register it in the assistants Redux state
 * so the real sidebar renders it — WITHOUT activating it. The renderer
 * message cache is intentionally never populated: this is what makes the
 * topic a cache-miss target. Returns the seed entries (used to derive the
 * expected content map and id set for the correctness gates).
 */
async function seedTopic(
  page: Page,
  topicId: string,
  name: string,
  assistantId: string,
  entries: SeedEntry[]
): Promise<SeedEntry[]> {
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
            createdAt: '2026-08-14T00:00:00.000Z',
            updatedAt: '2026-08-14T00:00:00.000Z'
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
  if (!result.ok) throw new Error(`seedTopic(${topicId}): ${result.error}`)

  // Deterministic post-seed proof: the topic is persisted in Main with the
  // exact expected count AND the renderer message cache has no entry for it
  // (never activated — the cache-miss precondition at seed time).
  const main = await readMainTopic(page, topicId)
  expect(main.count, `seedTopic(${topicId}) must persist exactly ${entries.length} messages in Main`).toBe(
    entries.length
  )
  const reduxAbsent = await page.evaluate((topicId) => {
    const s = (window as any).store.getState()
    return !Array.isArray(s.messages?.messageIdsByTopic?.[topicId])
  }, topicId)
  expect(reduxAbsent, `seedTopic(${topicId}) must not populate the renderer message cache`).toBe(true)
  return entries
}

/**
 * Create a fresh deterministic topic (seedTopic) and make it the active topic
 * via the real sidebar item, so the app loads it into Redux and renders it
 * through the production path. When `displayCapacity` is provided (scaled
 * profiles), the renderer group window is raised BEFORE activation so the
 * whole seeded topic renders. Used for the source/control topic only —
 * target topics are seeded with seedTopic and never activated here.
 */
async function seedAndActivateTopic(
  page: Page,
  topicId: string,
  name: string,
  assistantId: string,
  entries: SeedEntry[],
  displayCapacity?: number
): Promise<void> {
  await seedTopic(page, topicId, name, assistantId, entries)

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

/**
 * Read the topic's authoritative Main state via the ChatDb bridge (a plain
 * IPC read — it never touches the renderer message cache, so the cache-miss
 * precondition and the main-parity gate can be proven without polluting the
 * measured path). Returns only counts/ownership/roles — never content.
 */
async function readMainTopic(
  page: Page,
  topicId: string
): Promise<{ count: number; allOwned: boolean; roles: string[] }> {
  return page.evaluate(async (topicId) => {
    const result = await (window as any).api.chatDb.fetchMessages({ topicId })
    if (!result?.ok) throw new Error(`fetchMessages failed for ${topicId}`)
    const messages = result.value.messages as Array<Record<string, unknown>>
    return {
      count: messages.length,
      allOwned: messages.every((m) => String(m.topicId) === topicId),
      roles: messages.map((m) => String(m.role))
    }
  }, topicId)
}

/** Read the topic's loaded state from Redux (renderer projection oracle). */
async function readReduxTopic(
  page: Page,
  topicId: string
): Promise<{
  ids: string[]
  currentTopicId: string | null
  loading: boolean
  messages: Array<{ id: string; role: string; status: string; blocks: string[] }>
  blocks: Array<{ id: string; messageId: string; status: string; content: string }>
}> {
  return page.evaluate((topicId) => {
    const s = (window as any).store.getState()
    const ids: string[] = [...(s.messages?.messageIdsByTopic?.[topicId] ?? [])]
    const messages = ids.map((id: string) => {
      const m = s.messages.entities[id] ?? {}
      return {
        id,
        role: String(m.role ?? ''),
        status: String(m.status ?? ''),
        blocks: Array.isArray(m.blocks) ? (m.blocks as string[]) : []
      }
    })
    const blocks = messages.flatMap((m) =>
      m.blocks.map((blockId: string) => {
        const b = s.messageBlocks?.entities?.[blockId] ?? {}
        return {
          id: blockId,
          messageId: String(b.messageId ?? ''),
          status: String(b.status ?? ''),
          content: String(b.content ?? '')
        }
      })
    )
    return {
      ids,
      currentTopicId: s.messages?.currentTopicId ?? null,
      loading: s.messages?.loadingByTopic?.[topicId] === true,
      messages,
      blocks
    }
  }, topicId)
}

// ---------------------------------------------------------------------------
// Cache-miss precondition + per-sample correctness gates
// ---------------------------------------------------------------------------

/**
 * Deterministic cache-miss proof for one measured target, run BEFORE its
 * timing: the target is persisted in Main with EXACTLY the expected count
 * (all owned by the target) while the renderer message cache holds no entry
 * for it and no message entity carries any exact expected target message id.
 * The expected id set is derived from the sample seed entries (no prefix
 * matching, no delimiter guessing). Returns nothing — throws on failure.
 */
async function assertCacheMissPrecondition(
  page: Page,
  targetTopicId: string,
  expectedCount: number,
  expectedMessageIds: string[]
): Promise<void> {
  const redux = await page.evaluate(
    ({ targetTopicId, expectedMessageIds }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[targetTopicId]
      const entities = s.messages?.entities ?? {}
      return {
        idsDefined: Array.isArray(ids),
        entityLeak: expectedMessageIds.some((id) => entities[id] !== undefined)
      }
    },
    { targetTopicId, expectedMessageIds }
  )
  expect(
    redux.idsDefined,
    `cache-miss precondition: ${targetTopicId} must have NO messageIdsByTopic entry before the measured click (renderer cache absent)`
  ).toBe(false)
  expect(
    redux.entityLeak,
    `cache-miss precondition: ${targetTopicId} must have no exact expected target message id (derived from the sample seed) in the renderer cache before the measured click`
  ).toBe(false)

  const main = await readMainTopic(page, targetTopicId)
  expect(
    main.count,
    `cache-miss precondition: ${targetTopicId} must be persisted in Main with exactly ${expectedCount} messages`
  ).toBe(expectedCount)
  expect(main.allOwned, `cache-miss precondition: all ${targetTopicId} Main messages must be topic-owned`).toBe(true)
}

/**
 * Complete-load correctness gates for one measured sample, run AFTER the
 * timing was recorded (the timing endpoint is deliberately narrower — first
 * useful content). Throws on failure, which aborts the test and produces no
 * artifact.
 *
 * Window semantics (derived from the production window model, not assumed):
 * `createLatestMessageWindow` renders the last min(N,W) chronological groups
 * (each seeded message is one group) newest-to-oldest in `displayMessages`.
 * So Redux always holds the FULL N (full-topic load), while the DOM holds
 * EXACTLY the expected visible window = the last min(N,W) message ids,
 * rendered in reverse chronological order. The exact count + exact set also
 * prove W STABILITY: no scroll expansion (the window never grew to N and no
 * message older than the boundary appears) without any interaction.
 */
async function assertSwitchCorrectness(
  page: Page,
  targetTopicId: string,
  expectedCount: number,
  expectedVisibleCount: number,
  expectedFirstMessageId: string,
  boundaryMessageId: string,
  expectedWindowIds: string[],
  expectedContentByMessage: Map<string, string>
): Promise<void> {
  const redux = await readReduxTopic(page, targetTopicId)

  // Full-topic Redux commit with the expected deterministic order: ALL N
  // messages are loaded even when the visible window only renders min(N,W).
  expect(
    redux.ids,
    `switch: ${targetTopicId} must be fully loaded in Redux (all ${expectedCount} messages)`
  ).toHaveLength(expectedCount)
  expect(redux.ids[0], `switch: ${targetTopicId} first id must be the seeded first user message`).toBe(
    expectedFirstMessageId
  )
  // Activation target.
  expect(redux.currentTopicId, `switch: currentTopicId must be ${targetTopicId}`).toBe(targetTopicId)
  expect(redux.loading, `switch: ${targetTopicId} loading flag must be settled false`).toBe(false)

  // Expected visible window rendered in the DOM: exactly min(N,W) messages,
  // newest-to-oldest (the column-reverse view), with no older-than-boundary
  // message and no source/previous-topic residue — W stable, no scroll
  // expansion.
  const domIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#messages [data-message-id]')).map((el) => el.getAttribute('data-message-id'))
  )
  expect(
    domIds,
    `switch: ${targetTopicId} expected visible window must render exactly ${expectedVisibleCount} messages (min(N,W))`
  ).toHaveLength(expectedVisibleCount)
  const domIdSet = new Set(domIds)
  const expectedWindowSet = new Set(expectedWindowIds)
  expect(
    domIdSet,
    `switch: ${targetTopicId} DOM ids must equal the expected latest-window id set exactly (${expectedWindowIds.length} ids; no contamination, no scroll expansion)`
  ).toEqual(expectedWindowSet)
  expect(
    domIds,
    `switch: ${targetTopicId} DOM order must be newest-to-oldest (column-reverse) over the expected latest window`
  ).toEqual([...expectedWindowIds].reverse())

  // Block/content integrity: every message's block entity is loaded with the
  // exact deterministic content, and the visible window's boundary message DOM
  // text carries the marker (real target content committed at the window
  // boundary — the topic's first message for full-topic profiles).
  expect(redux.blocks, `switch: ${targetTopicId} block entities must cover every message`).toHaveLength(expectedCount)
  for (const message of redux.messages) {
    const expectedContent = expectedContentByMessage.get(message.id)
    expect(expectedContent, `switch: seed content map must know ${message.id}`).toBeTruthy()
    expect(message.blocks, `switch: ${message.id} must own exactly one block`).toHaveLength(1)
    const block = redux.blocks.find((b) => b.id === message.blocks[0])
    expect(block, `switch: block entity for ${message.id} must be loaded`).toBeTruthy()
    expect(block!.messageId, `switch: block ${block!.id} must be owned by ${message.id}`).toBe(message.id)
    expect(block!.content, `switch: block ${block!.id} must carry the deterministic seed content`).toBe(expectedContent)
    expect(message.status, `switch: ${message.id} must not carry an error status`).toBe('success')
  }
  for (const block of redux.blocks) {
    expect(block.status, `switch: block ${block.id} must not carry an error status`).toBe('success')
  }
  const boundaryDomText = await page.evaluate((boundaryMessageId) => {
    const el = document.getElementById(`message-${boundaryMessageId}`)
    return el ? (el.textContent ?? '') : ''
  }, boundaryMessageId)
  expect(
    boundaryDomText,
    `switch: visible-window boundary message ${boundaryMessageId} DOM text must include the deterministic content marker`
  ).toContain(expectedContentByMessage.get(boundaryMessageId))

  // Main parity: SQLite still holds the exact expected full count, all
  // topic-owned.
  const main = await readMainTopic(page, targetTopicId)
  expect(main.count, `switch: Main must hold exactly ${expectedCount} messages after the load`).toBe(expectedCount)
  expect(main.allOwned, 'switch: all Main messages must remain topic-owned').toBe(true)
}

// ---------------------------------------------------------------------------
// Timed measurement helper — instrumentation lives in the page context only
// ---------------------------------------------------------------------------

interface SwitchSample {
  /** Click -> first useful render (visible-window boundary DOM content + full Redux count + exact visible DOM window, non-loading). */
  firstUsefulRenderMs: number
  /** Click -> Redux full-count projection commit (store.subscribe-sampled, not poll-quantized). */
  loadCommitMs: number
}

/**
 * Measure ONE cache-miss topic switch: a real sidebar topic-item click (the
 * app's actual onClick handler → setActiveTopic → loadTopicMessagesThunk) to
 * the target's first useful render. `performance.now()` starts in the same
 * page task as the click dispatch (Playwright's CDP click would inject an
 * uncontrollable round-trip into the measured interval).
 *
 * Endpoint (first useful render of the expected visible window; for W<N this
 * is the click-to-WINDOW-first-useful-render contract): the target's visible-
 * window BOUNDARY message element is rendered in #messages WITH its
 * deterministic seed content committed in its textContent (the topic's first
 * message when the window covers the whole topic; the oldest message inside
 * the visible latest window otherwise), Redux holds the full expected count
 * (all N), the DOM shows exactly the expected visible window (min(N,W)
 * message elements — W stable, no scroll expansion), the target's loading
 * flag is settled false, and currentTopicId is the target. The endpoint is
 * resolved by a MutationObserver on the DOM commit with a 5ms bounded poll
 * fallback (poll resolution quantizes by at most 5ms); the separate
 * `loadCommitMs` comes from a synchronous store.subscribe transition and is
 * NOT poll-quantized.
 */
function measureTopicSwitch(
  page: Page,
  targetTopicId: string,
  boundaryMessageId: string,
  marker: string,
  expectedCount: number,
  expectedVisibleCount: number
): Promise<SwitchSample> {
  return page.evaluate(
    async ({ targetTopicId, boundaryMessageId, marker, expectedCount, expectedVisibleCount }) => {
      const store = (window as any).store
      const messagesEl = document.getElementById('messages')
      const item = document.querySelector<HTMLElement>(`[data-testid="topic-item"][data-topic-id="${targetTopicId}"]`)
      if (!messagesEl) throw new Error('messages container not found')
      if (!item) throw new Error(`topic item not found: ${targetTopicId}`)

      const getCount = () => (store.getState().messages?.messageIdsByTopic?.[targetTopicId] ?? []).length
      const domMessageCount = () => document.querySelectorAll('#messages [data-message-id]').length
      const isComplete = () => {
        const el = document.getElementById(`message-${boundaryMessageId}`)
        const s = store.getState()
        return (
          !!el &&
          (el.textContent ?? '').includes(marker) &&
          getCount() === expectedCount &&
          domMessageCount() === expectedVisibleCount &&
          s.messages?.loadingByTopic?.[targetTopicId] !== true &&
          s.messages?.currentTopicId === targetTopicId
        )
      }

      // Projection-commit capture: the count transitions 0 -> expectedCount at
      // the single messagesReceived commit (the full Main load + IPC +
      // serialization has landed). Store.subscribe is synchronous per dispatch,
      // so this timestamp is not poll-quantized.
      let commitAt = -1
      let prevCount = getCount()
      const unsubscribe = store.subscribe(() => {
        const count = getCount()
        if (count === prevCount) return
        prevCount = count
        if (count === expectedCount && commitAt < 0) commitAt = performance.now()
      })

      const t0 = performance.now()
      item.click()

      try {
        const renderAt = await new Promise<number>((resolve, reject) => {
          let settled = false
          const timeout = setTimeout(() => {
            if (settled) return
            settled = true
            observer.disconnect()
            const s = store.getState()
            reject(
              new Error(
                `topic-switch completion timeout for ${targetTopicId}: ` +
                  `boundary=${!!document.getElementById(`message-${boundaryMessageId}`)}, ` +
                  `count=${getCount()}, domMessages=${domMessageCount()}, ` +
                  `loading=${String(s.messages?.loadingByTopic?.[targetTopicId])}, ` +
                  `current=${String(s.messages?.currentTopicId)}`
              )
            )
          }, 45000)
          const finish = (t: number) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            observer.disconnect()
            resolve(t)
          }
          const observer = new MutationObserver(() => {
            if (isComplete()) finish(performance.now())
          })
          observer.observe(messagesEl, { subtree: true, childList: true, characterData: true })
          // Poll fallback: the DOM content signal can land between mutations
          // in edge cases (e.g. a re-render that preserves the element).
          const poll = () => {
            if (settled) return
            if (isComplete()) return finish(performance.now())
            setTimeout(poll, 5)
          }
          poll()
        })
        return {
          firstUsefulRenderMs: renderAt - t0,
          loadCommitMs: commitAt >= 0 ? commitAt - t0 : -1
        }
      } finally {
        unsubscribe()
      }
    },
    { targetTopicId, boundaryMessageId, marker, expectedCount, expectedVisibleCount }
  )
}

// ---------------------------------------------------------------------------
// Main-process lifecycle tape (bounded, in-memory, failure diagnostics only)
// ---------------------------------------------------------------------------

/** Fixed maximum events retained by the lifecycle tape (bounded, drop-oldest). */
const LIFECYCLE_TAPE_MAX_EVENTS = 64

/** Fixed globalThis key shared between the install/read/dispose evaluate calls. */
const LIFECYCLE_TAPE_STATE_KEY = '__perf101LifecycleTapeV1__'

/** Fixed safe diagnostic code recorded when the Main-process tape read fails. */
const LIFECYCLE_TAPE_READ_FAILED = 'evaluate-failed' as const

/** One bounded lifecycle tape event. The field set is intentionally closed. */
interface LifecycleTapeEvent {
  kind: string
  t: number
  mono: number
  pid?: number
  reason?: string
  exitCode?: number
  label?: string
}

/** Bounded JSON diagnostic attached on failure before fixture teardown. */
interface LifecycleTapeDiagnostic {
  spec: string
  scope: string
  outcome: 'failure' | 'tape-read-failed'
  maxEvents: number
  events: LifecycleTapeEvent[]
  captureError?: typeof LIFECYCLE_TAPE_READ_FAILED
}

/**
 * Install the Main-process lifecycle tape BEFORE phase execution. Records
 * main-window `render-process-gone`, app `child-process-gone`, and safe
 * load/reload labels so crash/reload/context-reset is distinguishable from
 * the event sequence alone. Bounded (drop-oldest); listeners are removed via
 * disposeLifecycleTape. No URLs, paths, message content, credentials, raw DB
 * sizes, or profile data are ever stored.
 */
async function installLifecycleTape(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(
    async ({ app, BrowserWindow }, { max, stateKey }) => {
      const globalAny = globalThis as any
      if (globalAny[stateKey]) {
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

/** Deterministically remove all tape listeners and drop the Main-process state. */
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
 * nothing (progress stays in [E2E][PERF-101] console lines).
 */
async function attachLifecycleDiagnostic(testInfo: TestInfo, electronApp: ElectronApplication): Promise<void> {
  const tape = await readLifecycleTape(electronApp)
  const diagnostic: LifecycleTapeDiagnostic = {
    spec: 'perf101-topic-switch-measurement',
    scope: 'main-process lifecycle tape (in-memory, bounded, non-sensitive)',
    outcome: tape.ok ? 'failure' : 'tape-read-failed',
    maxEvents: LIFECYCLE_TAPE_MAX_EVENTS,
    events: tape.ok ? tape.events : [],
    captureError: tape.ok ? undefined : LIFECYCLE_TAPE_READ_FAILED
  }
  await testInfo.attach('perf101-lifecycle-diagnostic', {
    body: JSON.stringify(diagnostic, null, 2),
    contentType: 'application/json'
  })
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
  firstUsefulRender: number[]
  loadCommit: number[]
}

function buildBenchmarkResult(
  samples: PhaseSamples,
  environment: BenchmarkResult['environment'],
  profile: ScaleProfile
): BenchmarkResult {
  const n = profile.samplesPerProfile
  const renderedCount = Math.min(profile.targetTopicMessageCount, profile.rendererDisplayCount)
  const windowed = profile.rendererDisplayCount < profile.targetTopicMessageCount
  // Profile-aware endpoint signal: the topic's first message for full-topic
  // profiles (W >= N, unchanged diagonal semantics); the oldest message inside
  // the visible latest window for the new W<N orthogonal profiles.
  const boundarySignal = windowed
    ? `the oldest message inside the visible latest ${profile.rendererDisplayCount}-message window (chronological index N−W = ${profile.targetTopicMessageCount - profile.rendererDisplayCount})`
    : `the topic's first message (full-topic window: W=${profile.rendererDisplayCount} covers all N=${profile.targetTopicMessageCount})`
  const correctness: BenchmarkGate[] = [
    {
      id: 'switch.cacheMissPrecondition',
      name: 'every measured target was a genuine cache miss (Main-present, renderer-absent)',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples proved the target persisted in Main with exactly ${profile.targetTopicMessageCount} messages (all topic-owned) and NO renderer messageIdsByTopic entry / no exact expected target message id (derived from the sample seed) before the measured click (distinct never-activated targets; cache-hit repeats structurally impossible)`
    },
    {
      id: 'switch.firstUsefulRenderSignal',
      name: 'first useful render resolved on real target content, not a loading shell',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples ended at ${boundarySignal} rendered in #messages with its deterministic seed content committed in textContent, the full Redux count (all N=${profile.targetTopicMessageCount}), the exact expected visible DOM window (${renderedCount} message elements), loading settled false, and currentTopicId === target (window capacity ${profile.rendererDisplayCount})`
    },
    {
      id: 'switch.loadedFullTopic',
      name: 'target topic fully loaded in Redux with the exact deterministic order',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples: messageIdsByTopic[target] length === ${profile.targetTopicMessageCount} with the seeded first user message at index 0 — the full topic is held in Redux even though the visible window renders only ${renderedCount} messages`
    },
    {
      id: 'switch.renderedFullWindow',
      name: 'the target full expected visible window rendered in the DOM at the recorded window capacity',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples: #messages [data-message-id] count === ${renderedCount} (= min(N,W); the whole topic when W>=N, exactly the latest ${profile.rendererDisplayCount}-message window when W<N) — W stable: the window never grew to N, no scroll expansion (displayCount ${profile.rendererDisplayCount})`
    },
    {
      id: 'switch.contentIntegrity',
      name: 'every target message/block loaded with the exact deterministic seed content',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples: every message owns exactly one block entity whose content matches the deterministic seed content; ${boundarySignal}'s DOM text carries the deterministic content marker`
    },
    {
      id: 'switch.noSourceContamination',
      name: 'the rendered window contains exactly the target messages (no source/previous-topic residue)',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples: the DOM message-id set equals the expected visible-window id set exactly — the last ${renderedCount} chronological ids (the whole topic when W>=N), ordered newest-to-oldest per the column-reverse view; no source/previous-topic residue and no older-than-boundary message (W stable, no expansion to N)`
    },
    {
      id: 'switch.noErrorState',
      name: 'target load committed without error states',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples: loading flag settled false; no message/block in the target load carries an error/failed status`
    },
    {
      id: 'switch.mainParity',
      name: 'Main SQLite authority preserved (exact count, topic-owned rows)',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples: fetchMessages(target) returns exactly ${profile.targetTopicMessageCount} rows, all owned by the target topic (full N persisted in Main even when only ${renderedCount} render)`
    },
    {
      id: 'switch.currentTopic',
      name: 'target activation committed',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples: messages.currentTopicId === target after the switch`
    },
    {
      id: 'switch.samplesCompleted',
      name: 'all sample tasks completed with finite timing metrics',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} measured switches completed; firstUsefulRender and loadCommit recorded as finite ms for every sample`
    },
    {
      id: 'environment.abi145',
      name: 'measured runtime is the Electron ABI 145 lane with the safe canonical command',
      kind: 'correctness',
      passed: true,
      detail: `abiLane=electron, abi=${environment.abi}, command=${environment.command} (no path segments)`
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
        targetTopicMessageCount: profile.targetTopicMessageCount,
        visibleWindowMessageCount: renderedCount,
        rendererDisplayCount: profile.rendererDisplayCount,
        sourceTopicMessageCount: profile.sourceTopicMessageCount,
        targetTopicSampleCount: profile.samplesPerProfile
      }
    },
    environment,
    metrics: [
      ...statsMetrics(
        'switch.firstUsefulRender',
        windowed
          ? 'Cache-miss topic-item click -> click-to-window-first-useful-render (visible latest-window boundary content committed, full Redux N, exact visible DOM window; endpoint resolution <= 5ms poll quantize)'
          : 'Cache-miss topic-item click -> first useful render (first target content committed; endpoint resolution <= 5ms poll quantize)',
        samples.firstUsefulRender
      ),
      ...statsMetrics(
        'switch.loadCommit',
        'Cache-miss topic-item click -> Redux full-count projection commit (full Main load + IPC + serialization; store.subscribe-sampled, not poll-quantized)',
        samples.loadCommit
      )
    ],
    gates: correctness
  }
}

// ---------------------------------------------------------------------------
// The measurement test — one focused run, one artifact
// ---------------------------------------------------------------------------

test.describe('PERF-101 cache-miss topic-switch measurement', () => {
  test('measures click-to-first-useful-render for cache-miss topic switches', async ({
    electronApp,
    mainWindow
  }, testInfo) => {
    // Resolve the measurement profile BEFORE anything runs: unset/empty keeps
    // the default quick profile; an unsupported PERF101_SCALE value fails
    // clearly here, before measurement.
    const profile = resolveScaleProfile()

    // Bounded-run budget aligned with the actual per-wait bounds below
    // (watchdogs 5-45s) — a hang fails with a targeted diagnostic instead of
    // riding out an inflated global timeout.
    test.setTimeout(profile.testTimeoutMs)
    const page = mainWindow

    try {
      // Main-process lifecycle tape BEFORE phase execution: bounded, in-memory,
      // failure diagnostics only (never enters the schema-v1 artifact).
      // Installed INSIDE the diagnostic try/catch so an install failure (e.g.
      // a dead electronApp evaluate) still reaches the bounded-diagnostics
      // path below instead of skipping it.
      await installLifecycleTape(electronApp)

      const assistantId = await page.evaluate(() => (window as any).store.getState().assistants?.assistants?.[0]?.id)
      expect(assistantId, 'the fixture must provide a default assistant').toBeTruthy()

      const samples: PhaseSamples = { firstUsefulRender: [], loadCommit: [] }

      // ---- Phase 1: seed + activate the source/control topic ----------------
      await test.step('Phase 1: seed and activate the source/control topic', async () => {
        const sourceId = 'p101-src-topic'
        const sourceSeeds = buildGroupSeeds(sourceId, assistantId, SCALE.sourceTopicGroups, 0)
        await seedAndActivateTopic(page, sourceId, 'P101 Source', assistantId, sourceSeeds, activationCapacity(profile))
        console.log(`[E2E][PERF-101] source topic activated (${sourceSeeds.length} messages; profile ${profile.kind})`)
      })

      // ---- Phase 2: measured cache-miss switches (fresh target per sample) ---
      await test.step('Phase 2: measured cache-miss topic switches', async () => {
        for (let s = 0; s < profile.samplesPerProfile; s++) {
          const targetId = `p101-target-${s}`
          const expectedCount = profile.targetTopicMessageCount
          const expectedVisibleCount = visibleWindowMessageCount(expectedCount, profile.rendererDisplayCount)
          const boundaryIndex = windowBoundaryIndex(expectedCount, profile.rendererDisplayCount)

          // Seed this distinct never-activated target now (Main-persisted via
          // the ChatDb bridge, renderer cache absent) and derive the expected
          // content map, window-boundary DOM marker, and exact visible-window
          // id set FROM the same seed entries the builder produced, so gates
          // can never drift from the seed. The boundary message is the OLDEST
          // message inside the visible latest window (chronological index
          // max(0, N−W)); for full-topic profiles (W >= N) that is the topic's
          // first message — the existing diagonal endpoint is preserved.
          const targetSeeds = buildGroupSeeds(targetId, assistantId, expectedCount / 2, 1000 * (s + 1))
          await seedTopic(page, targetId, `P101 Target ${s}`, assistantId, targetSeeds)
          const firstId = firstMessageId(targetId)
          const boundaryEntry = targetSeeds[boundaryIndex]
          if (!boundaryEntry) {
            throw new Error(`seed entries must contain the window boundary at index ${boundaryIndex}`)
          }
          const boundaryId = String(boundaryEntry.message.id)
          const expectedWindowIds = targetSeeds.slice(boundaryIndex).map((entry) => String(entry.message.id))
          const expectedContentByMessage = new Map<string, string>()
          for (const entry of targetSeeds) {
            expectedContentByMessage.set(String(entry.message.id), String(entry.blocks[0]!.content))
          }
          const expectedMessageIds = targetSeeds.map((entry) => String(entry.message.id))
          const marker = expectedContentByMessage.get(boundaryId)
          expect(marker, `seed content map must know the visible-window boundary message ${boundaryId}`).toBeTruthy()

          // Cache-miss precondition BEFORE the measured click: Main-present,
          // renderer-absent (no exact expected target message id), exact
          // expected count.
          await assertCacheMissPrecondition(page, targetId, expectedCount, expectedMessageIds)

          // Untimed preparation: the sidebar item must be interactable before
          // the measured click (the measurement starts inside the click).
          const item = page.locator(`[data-testid="topic-item"][data-topic-id="${targetId}"]`)
          await item.waitFor({ state: 'visible', timeout: 15000 })

          const sample = await measureTopicSwitch(
            page,
            targetId,
            boundaryId,
            marker!,
            expectedCount,
            expectedVisibleCount
          )

          // Complete-load correctness gates run AFTER the timing capture; this
          // sample's timing is admitted to the samples/artifact only after
          // these gates pass (any failure aborts the test, no artifact).
          await assertSwitchCorrectness(
            page,
            targetId,
            expectedCount,
            expectedVisibleCount,
            firstId,
            boundaryId,
            expectedWindowIds,
            expectedContentByMessage
          )
          expect(sample.loadCommitMs, `switch: ${targetId} projection commit must land`).toBeGreaterThan(0)
          expect(sample.firstUsefulRenderMs, `switch: ${targetId} first useful render must complete`).toBeGreaterThan(0)
          expect(
            sample.firstUsefulRenderMs,
            `switch: ${targetId} first useful render must not precede its projection commit`
          ).toBeGreaterThanOrEqual(sample.loadCommitMs)

          samples.firstUsefulRender.push(sample.firstUsefulRenderMs)
          samples.loadCommit.push(sample.loadCommitMs)
        }
        console.log(
          `[E2E][PERF-101] switches: ${profile.samplesPerProfile} cache-miss samples, ` +
            `N=${profile.targetTopicMessageCount} messages per target, ` +
            `visible window W=${profile.rendererDisplayCount} (${Math.min(profile.targetTopicMessageCount, profile.rendererDisplayCount)} rendered; ` +
            `profile ${profile.kind})`
        )
      })

      // ---- Phase 3: emit the schema v1 artifact ONLY after the full pass -----
      await test.step('Phase 3: emit schema v1 artifact', async () => {
        // The measured runtime is the Electron app (ABI 145), while the
        // Playwright runner process is Node. The artifact records the MEASURED
        // runtime's Node version and ABI from the running app
        // (`electronApp.evaluate`), with the runner's pnpm metadata retained
        // from collectEnvironmentMetadata. ABI 145 is a hard gate.
        const appRuntime = await electronApp.evaluate(() => ({
          node: process.version,
          abiModules: String(process.versions.modules)
        }))
        expect(appRuntime.abiModules, 'the measured runtime must be the Electron ABI 145 binding').toBe('145')
        const environment: BenchmarkResult['environment'] = {
          ...collectEnvironmentMetadata({ command: CANONICAL_COMMAND }),
          node: appRuntime.node,
          abiLane: 'electron',
          abi: appRuntime.abiModules
        }
        const result = buildBenchmarkResult(samples, environment, profile)
        const artifactPath = writeBenchmarkResult(result)
        expect(fs.existsSync(artifactPath), 'artifact must exist after a passing run').toBe(true)
        // Only a safe basename is printed — absolute machine-local artifact
        // paths never enter logs (privacy/redaction).
        console.log(
          `[E2E][PERF-101] schema v1 artifact: ${path.basename(artifactPath)} ` +
            `(profile ${profile.kind}, N${profile.targetTopicMessageCount}/W${profile.rendererDisplayCount})`
        )
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
        console.log(`[E2E][PERF-101] lifecycle diagnostic attach failed: ${String(attachError)}`)
      }
      throw error
    } finally {
      // Deterministic listener cleanup — also covers a tape read that failed
      // after a full process death (the dispose evaluate is swallowed).
      await disposeLifecycleTape(electronApp)
    }
  })
})
