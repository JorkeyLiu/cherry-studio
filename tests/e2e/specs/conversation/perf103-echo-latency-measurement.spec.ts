/**
 * PERF-103 echo-latency measurement (production-build Playwright E2E).
 *
 * Purpose (docs/performance-workstreams.md §2.3, PERF-ECHO measurement slice,
 * amplification priority = echo, the first user-visible send latency path):
 *   Deterministic, bounded, correctness-first measurements of the USER-VISIBLE
 *   SEND ECHO: from the same-task Enter dispatch on the real inputbar textarea
 *   to the FIRST committed `.message-user` DOM node whose text carries the
 *   sample's deterministic synthetic marker — with Redux confirming exactly
 *   one user message for the active sample topic. The echo is measured
 *   against a FRESH production build via the standard shared E2E fixture;
 *   the production `sendMessage` thunk is exercised end-to-end on a real
 *   empty topic (the app's real Inputbar Enter handler → `sendMessage` →
 *   `saveMessageAndBlocksToDB` → `addMessage`/`upsertManyBlocks` → React
 *   commit). This slice is MEASUREMENT-ONLY: no runtime optimization, no
 *   threshold, no root-cause attribution — the echo interval is a
 *   renderer-observable AGGREGATE that includes pre-render persistence; no
 *   internal attribution is claimed (no Main/IPC instrumentation exists).
 *
 * Echo definition (locked decision; `scale.echoDefinitionCode = 1`):
 *   t0 = `performance.now()` sampled in the SAME page task as the synthetic
 *   Enter keydown on the real textarea → the first DOM commit of a
 *   `.message-user` element whose text contains the sample's deterministic
 *   plain synthetic marker, with the Redux projection confirming one user
 *   message for the active sample topic. The endpoint embeds correctness
 *   signals — it can never resolve on a loading shell, a previous topic's
 *   stale node, or the assistant reply (which is `.message-assistant`).
 *
 * Scale (recorded verbatim in the artifact's numeric scale map):
 *   - 2 WARMUP samples + 20 MEASURED samples = 22 samples total, each in a
 *     fresh EMPTY topic created via the established real-UI activation path
 *     (assistants/addTopic + ChatDb ensureTopic + real sidebar item), so the
 *     topic contains exactly [1 user + 1 assistant] message after each send
 *     (`messagesPerTopic = 2`).
 *   - The deterministic marker is generated at runtime per sample
 *     (`p103-echo-<sampleIndex>`); it exists only in the DOM/mock reply during
 *     the run and NEVER enters the artifact, console output, or any fixture —
 *     a stale previous-sample `.message-user` can never match (each sample
 *     carries a distinct marker).
 *   - Warmups run the FULL correctness gates but are excluded from the
 *     measured series (they never enter the artifact metrics).
 *   - Numeric timings are L3 directional only. No threshold/assertion/
 *     reference to any latency target exists anywhere in this spec or in the
 *     artifact.
 *
 * Measurement model (one sample = one measured send):
 *   - BEFORE t0 the test installs (a) a synchronous `store.subscribe` listener
 *     that records the Redux commit of the single user message for the sample
 *     topic (`messageIdsByTopic[topicId]` gains exactly one entity of role
 *     'user' with `currentTopicId === topicId`; not poll-quantized) and
 *     (b) a MutationObserver on `#messages` that records the first `.message-user`
 *     DOM commit carrying the sample marker (with the established bounded 5ms
 *     poll fallback, `scale.observerFallbackMs = 5`).
 *   - The message text is set through the native setter + input event
 *     (React controlled value commits → the send button enables), then
 *     t0 = `performance.now()` is sampled in the same synchronous task as the
 *     synthetic Enter keydown that runs the app's REAL Inputbar handler.
 *   - Three send-relative timings are recorded on ONE page clock:
 *     `reduxCommitMs` (t0 → Redux user-message commit), `firstRenderMs`
 *     (t0 → first `.message-user` marker DOM commit), `reduxToDomMs`
 *     (Redux commit → DOM commit, always >= 0 on the monotonic page clock).
 *
 * Attribution slice (PERF-103 extension, measurement-only; `scale
 * .attributionDefinitionCode = 1`): the same run additionally records browser
 * long-task and rAF frame-cadence observations over the measured interval
 * [reduxCommitAt, domCommitAt], so the aggregate `reduxToDom` span can be read
 * as a SINGLE BLOCKING TASK vs MULTI-TASK/SCHEDULER GAPS without claiming any
 * React pass-level attribution (a fresh first-message render needs at least two
 * React commits — the viewport window is applied in a passive effect — but
 * that fact is context, not a gate):
 *   - A `PerformanceObserver('longtask')` records every long task (>= 50 ms)
 *     with `startTime`/`duration` on the page clock (PERF-102 pattern). Each
 *     task's overlap with the measured interval is CLIPPED to
 *     [reduxCommitAt, domCommitAt]; tasks that overhang the interval edges
 *     contribute only the clipped part. Unsupported observers are recorded as a
 *     numeric support flag (0) — never a failure. The observer callback only
 *     pushes bounded records; it never does heavy work inside the interval.
 *   - A bounded rAF recorder (frame timestamps, capped at 4096, drop after
 *     cap) provides frame-cadence evidence: the maximum frame delta over frame
 *     intervals spanning [reduxCommitAt, domCommitAt]. rAF is frame cadence,
 *     NOT a render-pass duration — a large delta can be a single blocking task
 *     OR a scheduler gap; it is never claimed as React work.
 *   - The DOM endpoint records WHICH mechanism resolved it: the MutationObserver
 *     callback is pre-layout/pre-paint; the bounded 5 ms poll fallback may be
 *     post-layout and 5 ms-quantized. The recorded endpoint source makes that
 *     honesty machine-readable (`attribution.mutationResolved*`).
 *   - After both endpoints resolve, a single bounded macrotask yield allows the
 *     long-task observer's delivery queue to flush before the clipped values
 *     are derived and the observer is detached (best-effort checkpoint; a long
 *     task still running at detach is never observed — documented bias).
 *
 * Attribution instrumentation disclosure (audit F2): the long-task observer
 * and the rAF frame recorder are NEWLY ADDED in this attribution extension —
 * they did not exist in the earlier PERF-103 baseline run. All timings in this
 * artifact (including the three baseline duration grids) are therefore freshly
 * measured under the added instrumentation; any cross-artifact delta vs the
 * earlier PERF-103 baseline is machine/run state (fresh build, runtime
 * variance), not regression evidence.
 *
 * Correctness gates run BEFORE the timing is admitted to the measured series
 * (warmups satisfy the same correctness; any failure aborts the test and
 * produces NO artifact — audit F1-style gate):
 *   - echo.renderSignal — every measured sample resolved on a real
 *     `.message-user` DOM commit carrying the sample marker (firstRenderMs
 *     finite and >= 0).
 *   - echo.requestCount — exactly ONE product streaming chat-completion
 *     request per sample, whose user message content equals the sample marker
 *     (mock request log, sequence-scoped, stream===true discriminator).
 *   - echo.reduxToDomOrder — the Redux user-message commit precedes or equals
 *     the first `.message-user` DOM commit on the same page clock
 *     (reduxToDomMs >= 0).
 *   - content.exactReply — after each send the exact deterministic mock
 *     assistant completion lands: the assistant message and its single block
 *     reach status success with the exact deterministic mock reply.
 *   - main.parity — Main SQLite eventually holds exactly 2 topic-owned
 *     messages (1 user + 1 assistant), all success, one block per message,
 *     bounded block ownership — read through the established bounded settle
 *     (the production completion callback commits Redux success BEFORE the
 *     final SQLite write lands).
 *   - samples.completed — all 2 warmup + 20 measured samples finished with
 *     full correctness and finite metrics.
 *   - environment.abi145 — measured runtime is the Electron ABI 145 lane via
 *     the safe canonical command.
 *   - privacy.schemaV1 — metrics/gates/scale carry only numbers and fixed
 *     strings (closed schema set, enforced at write time).
 *   - instrumentation.complete — every measured sample's instrumentation
 *     record is complete and finite: endpoint source in {mutation, poll},
 *     longtask support flag in {0, 1}, interval-overlap long-task count an
 *     integer >= 0, clipped overlap total/max and max frame delta finite >= 0,
 *     and the overlap invariants hold (max <= total; (count > 0) ===
 *     (total > 0) === (max > 0); an unsupported observer records zero overlap).
 *     Nothing is gated on long tasks existing, frame values, or mutation
 *     winning.
 *   - instrumentation.cleanupEndpoint — every returned record documents that
 *     the `finally` cleanup completed (store unsubscribed, MutationObserver +
 *     PerformanceObserver disconnected, rAF cancelled; `cleanupDone` true is
 *     structural for any returned record — a cleanup failure throws before the
 *     record is returned and aborts without an artifact, so this gate does NOT
 *     independently detect cleanup-path execution), and exactly one endpoint
 *     source is claimed per sample (single-claim recorder) so the recorded
 *     mutation-vs-poll source is honest.
 *
 * Sample isolation:
 *   - Every sample uses a fresh EMPTY topic, so the measured send is always
 *     the topic's first message; the prior sample's DOM nodes are replaced on
 *     the topic switch, and even a transitional stale `.message-user` cannot
 *     match because the markers are per-sample distinct.
 *   - After each send the test waits for the exact deterministic assistant
 *     completion (Redux message/block status 'success') BEFORE the next
 *     sample, so no sample ever starts with an in-flight stream; the Main
 *     parity settle additionally confirms the final SQLite write landed.
 *
 * Evidence classification (PERF-LOCK-003 / docs/performance-measurement.md §2):
 *   - Deterministic L1 regression evidence when run on a fresh build with the
 *     standard fixture; the numeric metrics remain L3 provisional values until
 *     re-measured per docs/performance-measurement.md §7. No thresholds are asserted.
 *
 * Instrumentation boundary (PERF-LOCK-006/008):
 *   - All instrumentation lives in the test page context only (store.subscribe
 *     listener + MutationObserver + bounded poll + PerformanceObserver
 *     ('longtask') + bounded rAF frame recorder + synthetic native input and
 *     Enter events through the app's real registered handlers). No production
 *     code is changed, no application instrumentation is added, no Main-
 *     process wiring is touched, no mock behavior is changed.
 *   - Serialization rule: `page.evaluate` / `electronApp.evaluate` callbacks
 *     are serialized WITHOUT module closures — every value a callback reads
 *     arrives as an explicit evaluate argument.
 *   - Main-process lifecycle tape (failure diagnostics only): installed via
 *     `electronApp.evaluate` BEFORE phase execution, bounded at 64 events
 *     (drop-oldest), closed field set; never enters the schema-v1 artifact;
 *     on failure a bounded JSON diagnostic is attached via `testInfo.attach`
 *     BEFORE fixture teardown (success attaches nothing).
 *
 * Cleanup/abort:
 *   - Instrumentation is detached in `finally` blocks; the fixture owns the
 *     disposable profile/owned-temp-root cleanup and closes the app. A failed
 *     sample throws and produces NO artifact.
 *   - Bounded-run budget: a bounded test timeout (15 min) aligned with the
 *     per-wait watchdogs (5s text commit / 30s echo / 60s completion / 5s
 *     parity settle / 15-30s topic activation) so a SINGLE-WAIT hang fails
 *     with a targeted diagnostic instead of an inflated global timeout. The
 *     15-min budget intentionally covers the REALISTIC envelope — a
 *     deterministic-mock per-sample run is 5-10s, so the full 22-sample run
 *     lands at ~3-5 min with ~4-6x headroom. It does NOT cover the aggregate
 *     worst case: each sample is bounded at ≈ 145s (45s topic activation +
 *     5s text + 30s echo + 60s completion + 5s parity), so 22 samples ≈
 *     3190s, ~3.5x the 900s budget. A uniformly degraded (non-hung) run is
 *     therefore killed by the generic test timeout, not a per-wait
 *     diagnostic — still fail-closed, still emits NO artifact.
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
import { expect, getRequestLog, getRequestSequence, test } from '../../fixtures/electron.fixture'

// ---------------------------------------------------------------------------
// Deterministic bounded scale (recorded verbatim in the artifact's scale map)
// ---------------------------------------------------------------------------

/**
 * Fixed scale of the echo measurement. Warmup samples run full correctness but
 * never enter the measured series; measured samples are the only series the
 * artifact metrics summarize. `messagesPerTopic` is the exact post-send topic
 * size (1 user + 1 assistant) that every gate asserts.
 */
const SCALE = {
  warmupSamples: 2,
  measuredSamples: 20,
  messagesPerTopic: 2,
  /** Bounded endpoint-resolution fallback poll (ms) — the MutationObserver is primary. */
  observerFallbackMs: 5,
  /** Echo definition revision (this file's endpoint contract). */
  echoDefinitionCode: 1,
  /**
   * Attribution definition revision (numeric-only scale addition): the
   * page-context long-task + rAF frame-delta observation contract over the
   * [reduxCommitAt, domCommitAt] interval (clipped overlaps, endpoint-source
   * recording, bounded frame recorder).
   */
  attributionDefinitionCode: 1
} as const

/** Numeric profile identity recorded in the scale map (single closed profile). */
const PROFILE_CODE = 0

// ---------------------------------------------------------------------------
// Metric/gate identity contract — static, in-spec enforced at Phase 3
// ---------------------------------------------------------------------------

/** Statistical suffixes shared by every duration grid. */
const STAT_SUFFIXES = ['p50', 'p95', 'mean', 'min', 'max'] as const

/** The three baseline duration-grid prefixes (preserved verbatim). */
const BASELINE_STAT_PREFIXES = ['echo.reduxCommit', 'echo.firstRender', 'echo.reduxToDom'] as const

/**
 * The original PERF-103 baseline metric id set (16): 3 grids x 5 stats + the
 * measured-sample count. Every id must remain present unchanged in the
 * artifact (baseline identity preserved as subset).
 */
const BASELINE_METRIC_IDS: readonly string[] = [
  ...BASELINE_STAT_PREFIXES.flatMap((prefix) => STAT_SUFFIXES.map((suffix) => `${prefix}.${suffix}`)),
  'echo.samples'
]

/** The original PERF-103 baseline gate id set (8), preserved verbatim. */
const BASELINE_GATE_IDS: readonly string[] = [
  'echo.renderSignal',
  'echo.requestCount',
  'echo.reduxToDomOrder',
  'content.exactReply',
  'main.parity',
  'samples.completed',
  'environment.abi145',
  'privacy.schemaV1'
]

/** Attribution duration grids (p50/p95/mean/min/max each) for the L3 slice. */
const ATTRIBUTION_GRID_PREFIXES: readonly string[] = [
  'attribution.longtaskOverlapTotalMs',
  'attribution.longtaskOverlapMaxMs',
  'attribution.frameDeltaMaxMs'
]

/** Count/ratio sample-series metrics: 3 series x {count, ratio}. */
const ATTRIBUTION_SAMPLE_SERIES_METRIC_COUNT = 6

/** Exact deterministic count of new attribution metrics (15 grids + 6 series). */
const ATTRIBUTION_METRIC_COUNT =
  ATTRIBUTION_GRID_PREFIXES.length * STAT_SUFFIXES.length + ATTRIBUTION_SAMPLE_SERIES_METRIC_COUNT

/** New correctness gates for the instrumentation slice (fixed set). */
const ATTRIBUTION_GATE_IDS: readonly string[] = ['instrumentation.complete', 'instrumentation.cleanupEndpoint']

const BASELINE_METRIC_COUNT = BASELINE_METRIC_IDS.length
const BASELINE_GATE_COUNT = BASELINE_GATE_IDS.length
const TOTAL_METRIC_COUNT = BASELINE_METRIC_COUNT + ATTRIBUTION_METRIC_COUNT
const TOTAL_GATE_COUNT = BASELINE_GATE_COUNT + ATTRIBUTION_GATE_IDS.length

/** Stable artifact/baseline identity (schema v1 `benchmark.id`, artifact file name). */
const BENCHMARK_ID = 'perf103-echo-latency'

/** Deterministic benchmark display name. */
const BENCHMARK_NAME = 'PERF-103 echo-latency measurement (production-build E2E, Electron lane)'

/** Canonical safe command recorded in the artifact (no path segments, audit F3). */
const CANONICAL_COMMAND = 'pnpm test:e2e'

/** The fixture's default model id (seeded by `seedMockProvider`). */
const MOCK_MODEL = 'mock-model'

/**
 * Deterministic plain synthetic marker prefix. The full per-sample marker
 * (`p103-echo-<sampleIndex>`) is built at runtime, exists only in the DOM and
 * mock reply during the run, and NEVER appears in the artifact, console
 * output, or any fixture/gate detail. Plain text (no markdown syntax) so it
 * survives every rendering path of a user main_text block.
 */
const MARKER_PREFIX = 'p103-echo'

/** Deterministic per-sample marker; unique across warmups and measured samples. */
function markerFor(sampleIndex: number): string {
  return `${MARKER_PREFIX}-${sampleIndex}`
}

/**
 * Exact deterministic mock reply for a sample (the fixture mock's fast
 * streaming path: `[Mock <model>] You said: "<content>"` with the user
 * content sliced to 100 chars — the short marker is never truncated).
 */
function expectedReplyFor(markerText: string): string {
  return `[Mock ${MOCK_MODEL}] You said: "${markerText.slice(0, 100)}"`
}

/**
 * Bounded settle deadlines for the post-send correctness reads. These bound
 * how long the gate readers wait for state that legitimately lands AFTER the
 * Redux completion signal (the final Main SQLite write). They are NOT timing
 * metrics, never enter the artifact's schema-v1 scale map, and expire
 * fail-closed: a deadline expiry asserts against the last observed snapshot.
 */
const SETTLE = {
  /** Main SQLite parity settle after the Redux success commit. */
  mainParityMs: 5000,
  /** Poll interval for the parity settle. */
  pollMs: 200
} as const

/**
 * Per-wait watchdog bounds aligned with the bounded-run budget. A hang fails
 * with a targeted diagnostic instead of riding out the test timeout.
 */
const WATCHDOG = {
  sidebarItemMs: 15000,
  topicActivationMs: 30000,
  textCommitMs: 5000,
  echoMs: 30000,
  completionMs: 60000
} as const

/** Bounded-run budget for all 22 samples (see header "Bounded-run budget"). */
const TEST_TIMEOUT_MS = 900000

// ---------------------------------------------------------------------------
// Page-context helpers — topic activation, state reads
// ---------------------------------------------------------------------------

/**
 * Create a fresh deterministic EMPTY topic in Redux + SQLite (typed ChatDb
 * bridge: assistants/addTopic + ensureTopic) and make it the active topic via
 * the real sidebar item, so the Inputbar binds to it and the app loads it
 * through the production path. Every sample uses a distinct topic so the topic
 * contains exactly the measured [1 user + 1 assistant] group.
 */
async function createAndActivateTopic(page: Page, topicId: string, name: string, assistantId: string): Promise<void> {
  const result = await page.evaluate(
    async ({ topicId, name, assistantId }) => {
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
      return { ok: true }
    },
    { topicId, name, assistantId }
  )
  if (!result.ok) throw new Error(`createAndActivateTopic(${topicId}): ${result.error}`)

  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await item.waitFor({ state: 'visible', timeout: WATCHDOG.sidebarItemMs })
  await item.click()

  await page.waitForFunction(
    (topicId) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      return Array.isArray(ids) && s.messages?.currentTopicId === topicId && !s.messages?.loadingByTopic?.[topicId]
    },
    topicId,
    { timeout: WATCHDOG.topicActivationMs }
  )
}

/** Read the sample topic's full Redux projection (ids/roles/status/blocks/content). */
async function readSampleState(
  page: Page,
  topicId: string
): Promise<{
  ids: string[]
  messages: Array<{
    id: string
    role: string
    status: string
    askId: string | null
    blocks: string[]
  }>
  blocks: Array<{ id: string; messageId: string; status: string; content: string }>
  currentTopicId: string | null
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
        askId: m.askId == null ? null : String(m.askId),
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
          content: typeof b.content === 'string' ? b.content : ''
        }
      })
    )
    return {
      ids,
      messages,
      blocks,
      currentTopicId: s.messages?.currentTopicId ?? null
    }
  }, topicId)
}

/** Snapshot of a topic's authoritative Main state (counts/ownership/roles/blocks only). */
interface MainParitySnapshot {
  messageCount: number
  allOwned: boolean
  roles: string[]
  statuses: string[]
  messageBlockCounts: number[]
  blockStatuses: string[]
  blockOwnership: boolean
}

/** Read the topic's authoritative Main state via the ChatDb bridge. */
async function readMainTopic(page: Page, topicId: string): Promise<MainParitySnapshot> {
  return page.evaluate(async (topicId) => {
    const result = await (window as any).api.chatDb.fetchMessages({ topicId })
    if (!result?.ok) throw new Error(`fetchMessages failed for ${topicId}`)
    const messages = result.value.messages as Array<Record<string, unknown>>
    const blocks = result.value.blocks as Array<Record<string, unknown>>
    return {
      messageCount: messages.length,
      allOwned: messages.every((m) => String(m.topicId) === topicId),
      roles: messages.map((m) => String(m.role)),
      statuses: messages.map((m) => String(m.status ?? '')),
      messageBlockCounts: messages.map((m) => (Array.isArray(m.blocks) ? m.blocks.length : 0)),
      blockStatuses: blocks.map((b) => String(b.status ?? '')),
      blockOwnership: blocks.every(
        (b) => String(b.messageId) !== '' && messages.some((m) => String(m.id) === String(b.messageId))
      )
    }
  }, topicId)
}

/** True when a Main snapshot already satisfies every `main.parity` condition. */
function mainParityReady(snapshot: MainParitySnapshot): boolean {
  return (
    snapshot.messageCount === SCALE.messagesPerTopic &&
    snapshot.allOwned &&
    [...snapshot.roles].sort().join(',') === ['assistant', 'user'].sort().join(',') &&
    snapshot.statuses.every((s) => s === 'success') &&
    snapshot.messageBlockCounts.every((c) => c === 1) &&
    snapshot.blockStatuses.every((s) => s === 'success') &&
    snapshot.blockOwnership
  )
}

/**
 * Bounded settle for the Main SQLite parity read. The production completion
 * callback commits Redux success BEFORE the final `saveUpdatesToDB` write
 * lands, so a single eager `fetchMessages` read can race the last row.
 * Re-polls through the existing readMainTopic/fetchMessages path until the
 * full parity contract holds or the short explicit deadline expires. On expiry
 * the last snapshot is returned and the `main.parity` assertions fail with its
 * actual values (fail-closed — a stale read is never accepted).
 */
async function readMainTopicSettled(page: Page, topicId: string): Promise<MainParitySnapshot> {
  const deadline = Date.now() + SETTLE.mainParityMs
  let snapshot = await readMainTopic(page, topicId)
  while (!mainParityReady(snapshot) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE.pollMs))
    snapshot = await readMainTopic(page, topicId)
  }
  return snapshot
}

// ---------------------------------------------------------------------------
// Timed measurement — page-context instrumentation + measured send
// ---------------------------------------------------------------------------

/**
 * One measured echo sample (all timings on the single page clock, ms).
 *
 * Baseline fields (`tSend`/`reduxCommitMs`/`firstRenderMs`/`reduxToDomMs`)
 * are unchanged from the PERF-103 baseline slice. The attribution fields are
 * L3 page-context observations over the measured interval
 * [reduxCommitAt, domCommitAt] — browser long-task pressure (clipped) and rAF
 * frame-cadence evidence. They never claim React pass-level attribution.
 */
interface EchoSample {
  /** Page-clock send anchor: `performance.now()` sampled in the same synchronous task as the synthetic Enter keydown. */
  tSend: number
  /** t0 -> Redux commit of the single sample user message (store.subscribe-sampled, not poll-quantized). */
  reduxCommitMs: number
  /** t0 -> first `.message-user` DOM commit carrying the sample marker (MutationObserver-sampled, bounded 5ms poll fallback). */
  firstRenderMs: number
  /** Redux commit -> first `.message-user` DOM commit (same page clock; always >= 0). */
  reduxToDomMs: number
  /** Which mechanism resolved the first `.message-user` marker DOM commit: the MutationObserver callback (pre-layout/pre-paint) or the bounded poll fallback (post-layout, 5ms-quantized). Single-claim: only the FIRST resolver records its source. */
  endpointSource: 'mutation' | 'poll'
  /** 1 when a `PerformanceObserver('longtask')` was installed, 0 when unsupported (honest numeric support flag, never a failure). */
  longtaskSupported: number
  /** Count of long tasks whose clipped overlap with [reduxCommitAt, domCommitAt] is > 0. 0 when none (or the observer is unsupported). */
  intervalOverlapLongtaskCount: number
  /** Sum of the clipped overlaps of the interval-overlapping long tasks (each task clipped to [reduxCommitAt, domCommitAt]). */
  longtaskOverlapTotalMs: number
  /** Largest single clipped long-task overlap inside [reduxCommitAt, domCommitAt]. */
  longtaskOverlapMaxMs: number
  /** Max rAF frame delta over frame intervals spanning [reduxCommitAt, domCommitAt] (frame-cadence evidence — a single blocking task vs multi-task/scheduler gaps; NOT a render-pass duration). */
  frameDeltaMaxMs: number
  /** True when the finally-path cleanup (unsubscribe, disconnects, rAF cancel) completed before the record was returned. */
  cleanupDone: boolean
}

/**
 * Measure ONE echo send end-to-end. Installs all page-context instrumentation
 * (a synchronous store.subscribe Redux-commit observer, a MutationObserver
 * DOM-commit observer with the bounded 5ms poll fallback, a
 * `PerformanceObserver('longtask')` and a bounded rAF frame recorder — ALL
 * BEFORE t0), sets the message text through the native setter + input event
 * (React controlled value commits → the send button enables), then samples t0
 * in the same task as the synthetic Enter keydown — the app's REAL Inputbar
 * handler runs the production `sendMessage` thunk. The evaluate resolves when
 * BOTH the Redux commit (one user message for the active sample topic) and the
 * first `.message-user` marker DOM commit have been observed, allows one
 * bounded macrotask delivery checkpoint for the long-task observer, derives
 * the interval-clipped long-task and frame-delta values over
 * [reduxCommitAt, domCommitAt], detaches all instrumentation in the `finally`
 * path, and returns the bounded record with `cleanupDone` set.
 */
function measureEchoSend(
  page: Page,
  args: { topicId: string; markerText: string; echoTimeoutMs: number; textCommitTimeoutMs: number }
): Promise<EchoSample> {
  return page.evaluate(async ({ topicId, markerText, echoTimeoutMs, textCommitTimeoutMs }) => {
    const store = (window as any).store
    const textarea = document.querySelector('.inputbar textarea') as HTMLTextAreaElement | null
    if (!textarea) throw new Error('measureEchoSend: inputbar textarea not found')
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    if (!nativeSet) throw new Error('measureEchoSend: textarea native value setter unavailable')
    const messagesEl = document.getElementById('messages')
    if (!messagesEl) throw new Error('measureEchoSend: #messages container not found')

    // ---- Redux commit observer (installed BEFORE t0) ----------------------
    // The Redux signal is the projection commit of the sample's user
    // message: `messageIdsByTopic[topicId]` gains exactly one entity of
    // role 'user' while `currentTopicId` is the sample topic. Store.subscribe
    // is synchronous per dispatch, so this timestamp is not poll-quantized.
    let reduxCommitAt = -1
    const checkReduxCommit = (): boolean => {
      if (reduxCommitAt >= 0) return true
      const s = store.getState()
      if (s?.messages?.currentTopicId !== topicId) return false
      const ids: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
      if (ids.length !== 1) return false
      const msg = s?.messages?.entities?.[ids[0]]
      if (!msg || String(msg.role ?? '') !== 'user') return false
      reduxCommitAt = performance.now()
      return true
    }
    const unsubscribe = store.subscribe(checkReduxCommit)

    // ---- DOM commit observer (installed BEFORE t0) ------------------------
    // The endpoint is the first `.message-user` element whose text carries
    // the sample marker. The marker is per-sample unique, so a transitional
    // stale node from a previous topic can never match. The MutationObserver
    // callback is primary (pre-layout/pre-paint); the bounded 5ms poll is the
    // fallback for edge cases where the signal lands between mutations
    // (post-layout, 5ms-quantized). The recorder is SINGLE-CLAIM: the first
    // resolver (observer callback or poll) records `endpointSource`; the other
    // then no-ops because `domCommitAt` is already >= 0 — so the recorded
    // source is exactly the mechanism that actually resolved the endpoint.
    let domCommitAt = -1
    let endpointSource: 'mutation' | 'poll' = 'poll'
    const resolveDomCommit = (source: 'mutation' | 'poll', claim: boolean): boolean => {
      if (domCommitAt >= 0) return true
      for (const el of document.querySelectorAll('#messages .message-user')) {
        if ((el.textContent ?? '').includes(markerText)) {
          domCommitAt = performance.now()
          if (claim) endpointSource = source
          return true
        }
      }
      return false
    }
    const observer = new MutationObserver(() => {
      resolveDomCommit('mutation', true)
    })
    observer.observe(messagesEl, { subtree: true, childList: true, characterData: true })
    // Initial pre-check: never claims an endpoint source (it cannot match —
    // the marker is sent only after this point — but the claim flag keeps the
    // recorder honest even in a pathological match).
    resolveDomCommit('poll', false)
    const checkDomCommit = (): boolean => resolveDomCommit('poll', true)

    // ---- Long tasks (installed BEFORE t0; PERF-102 pattern) ---------------
    // Records every long task (>= 50 ms) as startTime + duration on the page
    // clock. The observer only pushes bounded records — no heavy work inside
    // the measured interval. An unsupported observer records the numeric
    // support flag 0 and zero overlap; it is never a failure. The callback
    // fires asynchronously, so after the endpoints resolve the evaluate yields
    // one macrotask (delivery checkpoint) before deriving the clipped values.
    const longTasks: Array<{ startTime: number; duration: number }> = []
    let perfObserver: PerformanceObserver | null = null
    let longtaskSupported = 0
    try {
      perfObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ startTime: entry.startTime, duration: entry.duration })
        }
      })
      perfObserver.observe({ entryTypes: ['longtask'] })
      longtaskSupported = 1
    } catch {
      perfObserver = null
    }

    // ---- Bounded rAF frame recorder (installed BEFORE t0) -----------------
    // Records frame timestamps (`performance.now()` in each rAF callback).
    // Bounded at MAX_FRAME_SAMPLES (drop-after-cap); the cap covers ~68s at
    // 60fps, far beyond the worst-case echo watchdog (30s). The callback is
    // a timestamp push — negligible per-frame work. Frame deltas are derived
    // AFTER the measured interval and restricted to frame intervals spanning
    // [reduxCommitAt, domCommitAt]; rAF is frame-cadence evidence only, never
    // a render-pass duration.
    const MAX_FRAME_SAMPLES = 4096
    const frameTimestamps: number[] = []
    let rafId = 0
    const frameLoop = (): void => {
      if (frameTimestamps.length < MAX_FRAME_SAMPLES) frameTimestamps.push(performance.now())
      rafId = requestAnimationFrame(frameLoop)
    }
    rafId = requestAnimationFrame(frameLoop)

    // Bounded setTimeout-poll helper (5ms granularity — the fallback path).
    const waitFor = (predicate: () => boolean, timeoutMs: number, label: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const deadline = performance.now() + timeoutMs
        const poll = (): void => {
          if (predicate()) return resolve()
          if (performance.now() > deadline) return reject(new Error(`${label} timed out`))
          setTimeout(poll, 5)
        }
        poll()
      })

    let cleanupDone = false
    let record: Omit<EchoSample, 'cleanupDone'> | null = null
    try {
      // ---- Set the message text; wait for the React commit (send enabled) --
      nativeSet.call(textarea, markerText)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await waitFor(
        () => {
          // Locale-independent send-enabled signal: the production
          // SendMessageButton (`src/renderer/src/pages/home/Inputbar/SendMessageButton.tsx`)
          // renders a static `iconfont icon-ic_send` element with `role="button"`
          // and a boolean `aria-disabled` attribute. The `aria-label` is translated
          // (`t('chat.input.send')`), so it is never used as a selector; the static
          // class + role pin the button, and `aria-disabled !== 'true'` is the
          // untimed readiness condition (React-controlled value commit enables it).
          const sendBtn = document.querySelector('.inputbar [role="button"].icon-ic_send')
          return !!sendBtn && sendBtn.getAttribute('aria-disabled') !== 'true'
        },
        textCommitTimeoutMs,
        'message text commit'
      )

      // ---- t0 in the same page task as the synthetic Enter dispatch -------
      const t0 = performance.now()
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

      // Resolve on BOTH signals: the Redux user-message commit and the first
      // `.message-user` marker DOM commit (the DOM commit renders from the
      // store state, so reduxCommitAt is strictly at or before domCommitAt).
      const bothReady = (): boolean => checkReduxCommit() && checkDomCommit()
      await waitFor(bothReady, echoTimeoutMs, 'echo completion (redux user-message commit + .message-user DOM commit)')

      // ---- Long-task delivery checkpoint (best-effort, outside the interval)
      // A single bounded macrotask yield lets the long-task observer deliver
      // any completed-but-undelivered entries (Chromium delivers observer
      // buffers as a task) before the clipped values are derived and the
      // observer is detached. A long task STILL RUNNING at detach is never
      // observed — documented bias, cannot be fixed without extending the
      // measured window.
      await new Promise((resolve) => setTimeout(resolve, 0))

      // ---- Derive interval-clipped long-task overlap ----------------------
      // The measured interval is [reduxCommitAt, domCommitAt]. Each task's
      // overlap is clipped to that interval: a task overhanging either edge
      // contributes only the clipped part; a task fully outside contributes 0.
      let intervalOverlapLongtaskCount = 0
      let longtaskOverlapTotalMs = 0
      let longtaskOverlapMaxMs = 0
      for (const task of longTasks) {
        const overlapStart = Math.max(task.startTime, reduxCommitAt)
        const overlapEnd = Math.min(task.startTime + task.duration, domCommitAt)
        const clipped = Math.max(0, overlapEnd - overlapStart)
        if (clipped > 0) {
          intervalOverlapLongtaskCount += 1
          longtaskOverlapTotalMs += clipped
          longtaskOverlapMaxMs = Math.max(longtaskOverlapMaxMs, clipped)
        }
      }

      // ---- Derive max interval-spanning rAF frame delta --------------------
      // A frame delta `cur - prev` spans the measured interval when its frame
      // interval overlaps [reduxCommitAt, domCommitAt] (half-open overlap
      // convention). The max spanning delta is the largest single frame gap
      // inside the window — the frame-cadence signature of one long blocking
      // task vs several short gaps. rAF is cadence evidence, not render-pass
      // duration; when no frame interval spans the window the value is 0.
      let frameDeltaMaxMs = 0
      for (let i = 1; i < frameTimestamps.length; i++) {
        const prev = frameTimestamps[i - 1]
        const cur = frameTimestamps[i]
        if (cur > reduxCommitAt && prev < domCommitAt) {
          frameDeltaMaxMs = Math.max(frameDeltaMaxMs, cur - prev)
        }
      }

      record = {
        tSend: t0,
        reduxCommitMs: reduxCommitAt - t0,
        firstRenderMs: domCommitAt - t0,
        reduxToDomMs: domCommitAt - reduxCommitAt,
        endpointSource,
        longtaskSupported,
        intervalOverlapLongtaskCount,
        longtaskOverlapTotalMs,
        longtaskOverlapMaxMs,
        frameDeltaMaxMs
      }
    } finally {
      unsubscribe()
      observer.disconnect()
      if (perfObserver) perfObserver.disconnect()
      cancelAnimationFrame(rafId)
      cleanupDone = true
    }
    // Reached only when the try block completed AND the finally cleanup
    // completed (a cleanup throw propagates before this line and rejects the
    // evaluate, producing no sample and no artifact — fail-closed).
    return { ...record!, cleanupDone }
  }, args)
}

/**
 * Wait for the exact deterministic mock assistant completion: the sample
 * topic's single assistant message reached status 'success' and its blocks all
 * reached status 'success' in the Redux projection. Bounded; fails closed on
 * timeout. This guarantees the next sample has no in-flight stream.
 */
async function waitForAssistantCompletion(page: Page, topicId: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (topicId) => {
      const s = (window as any).store.getState()
      const ids: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
      const assistants = ids
        .map((id: string) => s.messages.entities[id])
        .filter((m: any) => m && String(m.role ?? '') === 'assistant')
      if (assistants.length < 1) return false
      const msg = assistants[0]
      if (String(msg.status ?? '') !== 'success') return false
      const blocks: string[] = Array.isArray(msg.blocks) ? msg.blocks : []
      if (blocks.length === 0) return false
      return blocks.every((bid: string) => s?.messageBlocks?.entities?.[bid]?.status === 'success')
    },
    topicId,
    { timeout: timeoutMs }
  )
}

// ---------------------------------------------------------------------------
// Per-sample correctness gates (run AFTER the timing record; fail-fast)
// ---------------------------------------------------------------------------

/**
 * Complete-load correctness gates for ONE sample, run AFTER the timing was
 * recorded (the timing endpoint is deliberately narrower — the Redux + DOM
 * echo commits). Throws on failure, which aborts the test and produces no
 * artifact. Covers: finite non-negative timings + redux-to-dom ordering, the
 * PERF-103 attribution instrumentation record (completeness, finiteness,
 * endpoint-source closedness, support-flag honesty, cleanup), the Redux
 * projection (exactly 1 user + 1 assistant, exact user marker block, exact
 * assistant reply), exactly one product streaming request per sample, and the
 * Main SQLite parity (2 topic-owned messages, one block each, all success).
 */
async function assertSampleCorrectness(
  page: Page,
  args: {
    sampleIndex: number
    topicId: string
    sample: EchoSample
    markerText: string
    expectedReply: string
    seqBefore: number
  }
): Promise<void> {
  const { sampleIndex, topicId, sample, markerText, expectedReply, seqBefore } = args

  // ---- Timing finiteness + ordering ----------------------------------------
  expect(
    Number.isFinite(sample.reduxCommitMs) && sample.reduxCommitMs >= 0,
    `sample ${sampleIndex}: reduxCommitMs must be finite and >= 0 (observed ${sample.reduxCommitMs})`
  ).toBe(true)
  expect(
    Number.isFinite(sample.firstRenderMs) && sample.firstRenderMs >= 0,
    `sample ${sampleIndex}: firstRenderMs must be finite and >= 0 (observed ${sample.firstRenderMs})`
  ).toBe(true)
  expect(
    sample.reduxToDomMs,
    `sample ${sampleIndex}: reduxToDomMs must be >= 0 (the .message-user DOM commit cannot precede the Redux user-message commit on the same page clock; observed ${sample.reduxToDomMs})`
  ).toBeGreaterThanOrEqual(0)

  // ---- PERF-103 attribution instrumentation (completeness + finiteness) ----
  // The instrumentation record must be complete and finite for every sample.
  // Nothing here gates on long tasks existing, frame values, or which endpoint
  // won — only on the record being honest and well-formed.
  expect(
    sample.endpointSource === 'mutation' || sample.endpointSource === 'poll',
    `sample ${sampleIndex}: endpointSource must be the closed set {mutation, poll} (observed ${sample.endpointSource})`
  ).toBe(true)
  expect(
    sample.longtaskSupported === 0 || sample.longtaskSupported === 1,
    `sample ${sampleIndex}: longtaskSupported must be the numeric support flag 0 or 1 (observed ${sample.longtaskSupported})`
  ).toBe(true)
  expect(
    Number.isInteger(sample.intervalOverlapLongtaskCount) && sample.intervalOverlapLongtaskCount >= 0,
    `sample ${sampleIndex}: intervalOverlapLongtaskCount must be an integer >= 0 (observed ${sample.intervalOverlapLongtaskCount})`
  ).toBe(true)
  expect(
    Number.isFinite(sample.longtaskOverlapTotalMs) && sample.longtaskOverlapTotalMs >= 0,
    `sample ${sampleIndex}: longtaskOverlapTotalMs must be finite and >= 0 (observed ${sample.longtaskOverlapTotalMs})`
  ).toBe(true)
  expect(
    Number.isFinite(sample.longtaskOverlapMaxMs) && sample.longtaskOverlapMaxMs >= 0,
    `sample ${sampleIndex}: longtaskOverlapMaxMs must be finite and >= 0 (observed ${sample.longtaskOverlapMaxMs})`
  ).toBe(true)
  expect(
    sample.longtaskOverlapMaxMs,
    `sample ${sampleIndex}: the max clipped overlap cannot exceed the clipped overlap total (observed max ${sample.longtaskOverlapMaxMs} vs total ${sample.longtaskOverlapTotalMs})`
  ).toBeLessThanOrEqual(sample.longtaskOverlapTotalMs + 1e-9)
  expect(
    Number.isFinite(sample.frameDeltaMaxMs) && sample.frameDeltaMaxMs >= 0,
    `sample ${sampleIndex}: frameDeltaMaxMs must be finite and >= 0 (observed ${sample.frameDeltaMaxMs})`
  ).toBe(true)
  // Count/total/max must agree: an overlapping task exists exactly when the
  // clipped total and max are positive.
  const anyOverlap = sample.intervalOverlapLongtaskCount > 0
  const totalPositive = sample.longtaskOverlapTotalMs > 0
  const maxPositive = sample.longtaskOverlapMaxMs > 0
  expect(
    anyOverlap === totalPositive && anyOverlap === maxPositive,
    `sample ${sampleIndex}: (overlap count > 0) must equal (total > 0) and (max > 0) (count ${sample.intervalOverlapLongtaskCount}, total ${sample.longtaskOverlapTotalMs}, max ${sample.longtaskOverlapMaxMs})`
  ).toBe(true)
  // An unsupported observer can never record overlap (machine-readable
  // honesty of the support flag).
  if (sample.longtaskSupported === 0) {
    expect(
      sample.intervalOverlapLongtaskCount === 0 && sample.longtaskOverlapTotalMs === 0,
      `sample ${sampleIndex}: an unsupported long-task observer must record zero overlap (count ${sample.intervalOverlapLongtaskCount}, total ${sample.longtaskOverlapTotalMs})`
    ).toBe(true)
  }
  // Every returned record is structurally post-finally: the cleanup must have
  // completed before the record exists (a cleanup failure throws and aborts
  // without an artifact), so cleanupDone=true documents the completed finally
  // cleanup — it is not an independent cleanup-path detection.
  expect(
    sample.cleanupDone,
    `sample ${sampleIndex}: the returned record must document completed finally cleanup (cleanupDone must be true)`
  ).toBe(true)

  // ---- Redux projection ----------------------------------------------------
  const state = await readSampleState(page, topicId)
  expect(state.currentTopicId, `sample ${sampleIndex}: the sample topic must be the active topic`).toBe(topicId)
  expect(
    state.messages,
    `sample ${sampleIndex}: topic must hold exactly ${SCALE.messagesPerTopic} messages`
  ).toHaveLength(SCALE.messagesPerTopic)

  const userMessages = state.messages.filter((m) => m.role === 'user')
  const assistantMessages = state.messages.filter((m) => m.role === 'assistant')
  expect(userMessages, `sample ${sampleIndex}: exactly one user message`).toHaveLength(1)
  expect(assistantMessages, `sample ${sampleIndex}: exactly one assistant message`).toHaveLength(1)

  const user = userMessages[0]!
  expect(user.status, `sample ${sampleIndex}: the user message must be success`).toBe('success')
  expect(user.blocks, `sample ${sampleIndex}: the user message must own exactly one block`).toHaveLength(1)
  const userBlock = state.blocks.find((b) => b.id === user.blocks[0])
  expect(userBlock, `sample ${sampleIndex}: the user message block must be loaded`).toBeTruthy()
  expect(userBlock!.status, `sample ${sampleIndex}: the user message block must be success`).toBe('success')
  expect(userBlock!.content, `sample ${sampleIndex}: the user block must carry the sample marker`).toBe(markerText)

  const assistant = assistantMessages[0]!
  expect(assistant.status, `sample ${sampleIndex}: the assistant message must reach success`).toBe('success')
  expect(assistant.askId, `sample ${sampleIndex}: the assistant must share the user askId`).toBe(user.id)
  expect(assistant.blocks, `sample ${sampleIndex}: the assistant message must own exactly one block`).toHaveLength(1)
  const assistantBlock = state.blocks.find((b) => b.id === assistant.blocks[0])
  expect(assistantBlock, `sample ${sampleIndex}: the assistant block must be loaded`).toBeTruthy()
  expect(assistantBlock!.status, `sample ${sampleIndex}: the assistant block must be success`).toBe('success')
  expect(
    assistantBlock!.content,
    `sample ${sampleIndex}: the assistant must complete with the exact deterministic reply`
  ).toBe(expectedReply)

  // ---- Mock request log: exactly one product request for this sample -------
  const requests = getRequestLog().filter(
    (entry) =>
      entry.sequence >= seqBefore &&
      entry.method === 'POST' &&
      (entry.url === '/v1/chat/completions' || entry.url === '/chat/completions') &&
      entry.parsed?.stream === true
  )
  expect(requests.length, `sample ${sampleIndex}: exactly one product streaming request per sample`).toBe(1)
  expect(
    String(requests[0]!.parsed?.model ?? ''),
    `sample ${sampleIndex}: the request must use the fixture default model`
  ).toBe(MOCK_MODEL)
  const requestMessages = requests[0]!.parsed?.messages as Array<{ role: string; content: unknown }> | undefined
  expect(Array.isArray(requestMessages), `sample ${sampleIndex}: the request must carry a messages array`).toBe(true)
  const requestUserMessages = (requestMessages ?? []).filter((m) => m.role === 'user')
  expect(
    requestUserMessages.at(-1),
    `sample ${sampleIndex}: the last request user message must carry the sample marker`
  ).toEqual({ role: 'user', content: markerText })

  // ---- Main SQLite parity --------------------------------------------------
  // Bounded settle: Redux commits success BEFORE the final SQLite write lands;
  // fetchMessages is re-polled until the parity contract holds or the short
  // explicit deadline expires (fail-closed).
  const main = await readMainTopicSettled(page, topicId)
  expect(main.messageCount, `sample ${sampleIndex}: Main must hold exactly ${SCALE.messagesPerTopic} messages`).toBe(
    SCALE.messagesPerTopic
  )
  expect(main.allOwned, `sample ${sampleIndex}: all Main rows must be topic-owned`).toBe(true)
  expect(main.roles.sort(), `sample ${sampleIndex}: Main roles must be [assistant, user]`).toEqual(
    ['assistant', 'user'].sort()
  )
  expect(
    main.statuses.every((s) => s === 'success'),
    `sample ${sampleIndex}: every Main message must be success`
  ).toBe(true)
  expect(
    main.messageBlockCounts.every((c) => c === 1),
    `sample ${sampleIndex}: every Main message must own exactly one block`
  ).toBe(true)
  expect(
    main.blockStatuses.every((s) => s === 'success'),
    `sample ${sampleIndex}: every Main block must be success`
  ).toBe(true)
  expect(main.blockOwnership, `sample ${sampleIndex}: every Main block must belong to a topic message`).toBe(true)
}

/** Run one full sample: measure echo, wait completion, assert correctness. */
async function runSample(
  page: Page,
  args: { topicId: string; markerText: string; sampleIndex: number; record: boolean; acc: SampleAccumulator }
): Promise<EchoSample> {
  const { topicId, markerText, sampleIndex, record, acc } = args
  const seqBefore = getRequestSequence()
  const sample = await measureEchoSend(page, {
    topicId,
    markerText,
    echoTimeoutMs: WATCHDOG.echoMs,
    textCommitTimeoutMs: WATCHDOG.textCommitMs
  })
  // The exact deterministic mock completion must land before the correctness
  // gates (and before the next sample starts) — no in-flight stream.
  await waitForAssistantCompletion(page, topicId, WATCHDOG.completionMs)
  await assertSampleCorrectness(page, {
    sampleIndex,
    topicId,
    sample,
    markerText,
    expectedReply: expectedReplyFor(markerText),
    seqBefore
  })
  if (record) {
    acc.reduxCommit.push(sample.reduxCommitMs)
    acc.firstRender.push(sample.firstRenderMs)
    acc.reduxToDom.push(sample.reduxToDomMs)
    // PERF-103 attribution slice series (L3; measured samples only).
    acc.longtaskOverlapTotal.push(sample.longtaskOverlapTotalMs)
    acc.longtaskOverlapMax.push(sample.longtaskOverlapMaxMs)
    acc.frameDeltaMax.push(sample.frameDeltaMaxMs)
    acc.longtaskSupportedSamples += sample.longtaskSupported
    if (sample.endpointSource === 'mutation') acc.mutationResolvedSamples += 1
    if (sample.intervalOverlapLongtaskCount > 0) acc.longtaskOverlapSamples += 1
    acc.samples += 1
  }
  return sample
}

// ---------------------------------------------------------------------------
// Main-process lifecycle tape (bounded, in-memory, failure diagnostics only)
// ---------------------------------------------------------------------------

/** Fixed maximum events retained by the lifecycle tape (bounded, drop-oldest). */
const LIFECYCLE_TAPE_MAX_EVENTS = 64

/** Fixed globalThis key shared between the install/read/dispose evaluate calls. */
const LIFECYCLE_TAPE_STATE_KEY = '__perf103LifecycleTapeV1__'

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
 * load/reload labels so crash/reload/context-reset is distinguishable from the
 * event sequence alone. Bounded (drop-oldest); listeners are removed via
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
 * Read the current bounded tape from the Main process. Returns the events or a
 * fixed capture-error marker — after a full process death the evaluate may
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
 * nothing (progress stays in [E2E][PERF-103] console lines).
 */
async function attachLifecycleDiagnostic(testInfo: TestInfo, electronApp: ElectronApplication): Promise<void> {
  const tape = await readLifecycleTape(electronApp)
  const diagnostic: LifecycleTapeDiagnostic = {
    spec: 'perf103-echo-latency-measurement',
    scope: 'main-process lifecycle tape (in-memory, bounded, non-sensitive)',
    outcome: tape.ok ? 'failure' : 'tape-read-failed',
    maxEvents: LIFECYCLE_TAPE_MAX_EVENTS,
    events: tape.ok ? tape.events : [],
    captureError: tape.ok ? undefined : LIFECYCLE_TAPE_READ_FAILED
  }
  await testInfo.attach('perf103-lifecycle-diagnostic', {
    body: JSON.stringify(diagnostic, null, 2),
    contentType: 'application/json'
  })
}

// ---------------------------------------------------------------------------
// Statistics + artifact construction (reuses the v1 contract helpers)
// ---------------------------------------------------------------------------

/** Accumulated measured-sample timing series (warmups never enter these). */
interface SampleAccumulator {
  /** Baseline series: t0 -> Redux user-message commit. */
  reduxCommit: number[]
  /** Baseline series: t0 -> first `.message-user` marker DOM commit. */
  firstRender: number[]
  /** Baseline series: Redux commit -> first `.message-user` marker DOM commit. */
  reduxToDom: number[]
  /** Attribution series: per-sample sum of interval-clipped long-task overlaps over [reduxCommitAt, domCommitAt]. */
  longtaskOverlapTotal: number[]
  /** Attribution series: per-sample max interval-clipped long-task overlap. */
  longtaskOverlapMax: number[]
  /** Attribution series: per-sample max rAF frame delta over frame intervals spanning the measured interval. */
  frameDeltaMax: number[]
  /** Count of measured samples whose PerformanceObserver('longtask') was supported. */
  longtaskSupportedSamples: number
  /** Count of measured samples whose DOM endpoint resolved via the MutationObserver callback (pre-layout/pre-paint). */
  mutationResolvedSamples: number
  /** Count of measured samples with at least one interval-clipped long-task overlap. */
  longtaskOverlapSamples: number
  /** Count of measured samples accumulated. */
  samples: number
}

function summarize(values: number[]): { p50: number; p95: number; mean: number; min: number; max: number } {
  const finite = values.filter((v) => Number.isFinite(v))
  const sorted = sortTimings(finite)
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

function countMetric(id: string, name: string, value: number): BenchmarkMetric {
  return { id, name, value, unit: 'count' }
}

/** Fraction (0..1) of measured samples, deterministic over the fixed sample count. */
function ratioMetric(id: string, name: string, count: number): BenchmarkMetric {
  return { id, name, value: count / SCALE.measuredSamples, unit: 'ratio' }
}

/** Build the schema v1 artifact (only ever called after the full pass). */
function buildBenchmarkResult(acc: SampleAccumulator, environment: BenchmarkResult['environment']): BenchmarkResult {
  const totalSamples = SCALE.warmupSamples + SCALE.measuredSamples
  const correctness: BenchmarkGate[] = [
    {
      id: 'echo.renderSignal',
      name: 'every measured sample resolved on a real .message-user DOM commit carrying the sample marker',
      kind: 'correctness',
      passed: true,
      detail: `${SCALE.measuredSamples}/${SCALE.measuredSamples} measured samples: the echo endpoint resolved on a real .message-user DOM commit whose text contained the sample's deterministic synthetic marker (firstRenderMs finite and >= 0; MutationObserver-sampled with a bounded ${SCALE.observerFallbackMs}ms poll fallback)`
    },
    {
      id: 'echo.requestCount',
      name: 'exactly one product chat-completion request per sample',
      kind: 'correctness',
      passed: true,
      detail: `1/1 product streaming chat-completion request per sample (${SCALE.measuredSamples}/${SCALE.measuredSamples} measured samples; mock request log, sequence-scoped, stream===true discriminator, last request user message carrying the sample marker)`
    },
    {
      id: 'echo.reduxToDomOrder',
      name: 'the Redux user-message commit precedes or equals the first .message-user DOM commit on the same page clock',
      kind: 'correctness',
      passed: true,
      detail: `${SCALE.measuredSamples}/${SCALE.measuredSamples} measured samples: reduxToDomMs >= 0 (the DOM commit cannot precede the Redux user-message commit on the same monotonic page clock)`
    },
    {
      id: 'content.exactReply',
      name: 'every sample assistant completed with the exact deterministic mock reply',
      kind: 'correctness',
      passed: true,
      detail: `${totalSamples}/${totalSamples} samples (${SCALE.warmupSamples} warmup + ${SCALE.measuredSamples} measured): the assistant message and its single block reached status success with the exact deterministic mock reply`
    },
    {
      id: 'main.parity',
      name: 'Main SQLite authority preserved (2 topic-owned messages, one block per message, all success)',
      kind: 'correctness',
      passed: true,
      detail: `${totalSamples}/${totalSamples} samples: fetchMessages settled to exactly ${SCALE.messagesPerTopic} topic-owned messages (1 user + 1 assistant), roles [assistant, user], all message/block status success, every message owning exactly one block, bounded block ownership (bounded settle read)`
    },
    {
      id: 'samples.completed',
      name: 'all samples completed with full correctness; measured series finite',
      kind: 'correctness',
      passed: true,
      detail: `${SCALE.warmupSamples} warmup + ${SCALE.measuredSamples} measured samples completed with full correctness; all ${SCALE.measuredSamples} measured samples recorded finite non-negative reduxCommitMs/firstRenderMs/reduxToDomMs values and complete finite attribution records (clipped long-task overlap total/max, max frame delta, endpoint source, support flag, cleanup)`
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
        'metrics/gates/scale carry only numbers and fixed strings; no message/reply text, marker text, credentials, paths, message/topic/ask IDs, or raw DB sizes (enforced at write time)'
    },
    {
      id: 'instrumentation.complete',
      name: 'every measured sample produced a complete finite instrumentation record',
      kind: 'correctness',
      passed: true,
      detail: `${SCALE.measuredSamples}/${SCALE.measuredSamples} measured samples: endpointSource in {mutation, poll}, longtaskSupported in {0, 1}, intervalOverlapLongtaskCount an integer >= 0, longtaskOverlapTotalMs/MaxMs/frameDeltaMaxMs finite and >= 0, max clipped overlap <= clipped overlap total, (overlap count > 0) === (total > 0) === (max > 0), and unsupported observers record zero overlap (no gate on long tasks existing, frame values, or which endpoint won)`
    },
    {
      id: 'instrumentation.cleanupEndpoint',
      name: 'every returned record documents finally cleanup completed; the resolving endpoint is recorded honestly (mutation vs bounded poll)',
      kind: 'correctness',
      passed: true,
      detail: `${SCALE.measuredSamples}/${SCALE.measuredSamples} measured samples: every returned record documents cleanupDone=true (the finally cleanup — store.subscribe unsubscribed, MutationObserver + PerformanceObserver disconnected, rAF cancelled — completed before the record was returned; a cleanup failure throws and aborts without an artifact, so this is structural for returned records, not an independent cleanup-path check); single-claim endpoint recorder (exactly one source per sample); ${acc.longtaskSupportedSamples}/${SCALE.measuredSamples} longtask-supported samples, ${acc.mutationResolvedSamples}/${SCALE.measuredSamples} mutation-resolved samples, ${acc.longtaskOverlapSamples}/${SCALE.measuredSamples} samples with an interval-clipped long-task overlap`
    }
  ]

  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: BENCHMARK_ID,
      name: BENCHMARK_NAME,
      scale: {
        profileCode: PROFILE_CODE,
        warmupSamples: SCALE.warmupSamples,
        measuredSamples: SCALE.measuredSamples,
        messagesPerTopic: SCALE.messagesPerTopic,
        observerFallbackMs: SCALE.observerFallbackMs,
        echoDefinitionCode: SCALE.echoDefinitionCode,
        attributionDefinitionCode: SCALE.attributionDefinitionCode
      }
    },
    environment,
    metrics: [
      ...statsMetrics(
        'echo.reduxCommit',
        'Same-task Enter dispatch -> Redux commit of the single sample user message (store.subscribe-sampled, not poll-quantized; renderer-observable aggregate including pre-render persistence, no internal attribution)',
        acc.reduxCommit
      ),
      ...statsMetrics(
        'echo.firstRender',
        `Same-task Enter dispatch -> first .message-user DOM commit carrying the sample's deterministic synthetic marker (MutationObserver-sampled, bounded ${SCALE.observerFallbackMs}ms poll fallback)`,
        acc.firstRender
      ),
      ...statsMetrics(
        'echo.reduxToDom',
        'Redux sample user-message commit -> first .message-user DOM commit (same page clock)',
        acc.reduxToDom
      ),
      { id: 'echo.samples', name: 'Measured echo sample count', value: acc.samples, unit: 'count' },
      // ---- PERF-103 attribution slice metrics (L3, measurement-only) -------
      // Page-context browser long-task + rAF frame-cadence observations over
      // the measured interval [reduxCommitAt, domCommitAt]. These distinguish
      // a SINGLE BLOCKING TASK from MULTI-TASK/SCHEDULER GAPS during
      // Redux commit -> first user-message DOM commit; they never claim React
      // pass-level attribution (no React Profiler, no layout/paint claim).
      // A sample with a single dominant long task shows count ~= 1 and
      // total ~= max; several short tasks show total >> max; scheduler gaps
      // with no long task show zero overlap but a large max frame delta.
      ...statsMetrics(
        'attribution.longtaskOverlapTotalMs',
        'Interval-clipped long-task overlap total per sample: sum over [reduxCommitAt, domCommitAt] of max(0, min(taskEnd, domCommitAt) - max(taskStart, reduxCommitAt)) for long tasks (>= 50ms) overlapping the measured interval; zero when the observer is unsupported or no task overlaps',
        acc.longtaskOverlapTotal
      ),
      ...statsMetrics(
        'attribution.longtaskOverlapMaxMs',
        'Max interval-clipped long-task overlap per sample (the single largest blocking-task overlap inside [reduxCommitAt, domCommitAt]; ~= total for one dominant task, << total for multi-task pressure)',
        acc.longtaskOverlapMax
      ),
      ...statsMetrics(
        'attribution.frameDeltaMaxMs',
        'Max rAF frame delta per sample over frame intervals spanning [reduxCommitAt, domCommitAt] (frame-cadence evidence — a single blocking task vs multi-task/scheduler gaps; NOT a render-pass duration)',
        acc.frameDeltaMax
      ),
      countMetric(
        'attribution.longtaskSupportedCount',
        'Samples where the PerformanceObserver(longtask) instrument was supported',
        acc.longtaskSupportedSamples
      ),
      ratioMetric(
        'attribution.longtaskSupportedRatio',
        'Fraction of measured samples where the long-task observer was supported',
        acc.longtaskSupportedSamples
      ),
      countMetric(
        'attribution.mutationResolvedCount',
        'Samples whose first .message-user marker DOM commit was resolved by the MutationObserver callback (pre-layout/pre-paint endpoint)',
        acc.mutationResolvedSamples
      ),
      ratioMetric(
        'attribution.mutationResolvedRatio',
        'Fraction of measured samples resolved by the MutationObserver endpoint (vs the bounded poll fallback)',
        acc.mutationResolvedSamples
      ),
      countMetric(
        'attribution.longtaskOverlapSampleCount',
        'Samples with at least one interval-clipped long-task overlap inside [reduxCommitAt, domCommitAt]',
        acc.longtaskOverlapSamples
      ),
      ratioMetric(
        'attribution.longtaskOverlapSampleRatio',
        'Fraction of measured samples with at least one interval-clipped long-task overlap',
        acc.longtaskOverlapSamples
      )
    ],
    gates: correctness
  }
}

// ---------------------------------------------------------------------------
// The measurement test — one focused run, one artifact
// ---------------------------------------------------------------------------

test.describe('PERF-103 echo-latency measurement', () => {
  test('measures the same-task Enter echo to the first user-message DOM commit', async ({
    electronApp,
    mainWindow
  }, testInfo) => {
    // Bounded-run budget (15 min) aligned with the actual per-wait bounds
    // below (watchdogs: 5s text commit / 30s echo / 60s completion / 5s
    // parity / 15-30s topic activation) — a single-wait hang fails with a
    // targeted diagnostic; a uniformly degraded run is killed by the generic
    // test timeout (fail-closed, no artifact). See the header.
    test.setTimeout(TEST_TIMEOUT_MS)
    const page = mainWindow

    try {
      // Main-process lifecycle tape BEFORE phase execution: bounded, in-memory,
      // failure diagnostics only (never enters the schema-v1 artifact).
      await installLifecycleTape(electronApp)

      const assistantId = await page.evaluate(() => (window as any).store.getState().assistants?.assistants?.[0]?.id)
      expect(assistantId, 'the fixture must provide a default assistant').toBeTruthy()

      const acc: SampleAccumulator = {
        reduxCommit: [],
        firstRender: [],
        reduxToDom: [],
        longtaskOverlapTotal: [],
        longtaskOverlapMax: [],
        frameDeltaMax: [],
        longtaskSupportedSamples: 0,
        mutationResolvedSamples: 0,
        longtaskOverlapSamples: 0,
        samples: 0
      }

      // ---- Phase 1: warmup samples (full correctness, excluded from metrics) --
      await test.step('Phase 1: warmup echo samples (correctness, excluded from metrics)', async () => {
        for (let w = 0; w < SCALE.warmupSamples; w++) {
          const topicId = `p103-warmup-${w}`
          const marker = markerFor(w)
          await createAndActivateTopic(page, topicId, `P103 Warmup ${w}`, assistantId!)
          const sample = await runSample(page, { topicId, markerText: marker, sampleIndex: w, record: false, acc })
          console.log(
            `[E2E][PERF-103] warmup sample ${w}: reduxCommit=${sample.reduxCommitMs.toFixed(1)}ms, ` +
              `firstRender=${sample.firstRenderMs.toFixed(1)}ms, reduxToDom=${sample.reduxToDomMs.toFixed(1)}ms, ` +
              `endpointMutation=${sample.endpointSource === 'mutation' ? 1 : 0}, ` +
              `ltSupported=${sample.longtaskSupported}, ltOverlapCount=${sample.intervalOverlapLongtaskCount}, ` +
              `ltOverlapTotal=${sample.longtaskOverlapTotalMs.toFixed(1)}ms, ` +
              `ltOverlapMax=${sample.longtaskOverlapMaxMs.toFixed(1)}ms, ` +
              `frameMax=${sample.frameDeltaMaxMs.toFixed(1)}ms`
          )
        }
        console.log(
          `[E2E][PERF-103] warmups done: ${SCALE.warmupSamples} samples, full correctness, excluded from metrics`
        )
      })

      // ---- Phase 2: measured echo samples (20, fresh empty topic per sample) --
      await test.step('Phase 2: measured echo samples', async () => {
        for (let s = 0; s < SCALE.measuredSamples; s++) {
          const topicId = `p103-sample-${s}`
          const marker = markerFor(s + SCALE.warmupSamples)
          await createAndActivateTopic(page, topicId, `P103 Sample ${s}`, assistantId!)
          const sample = await runSample(page, { topicId, markerText: marker, sampleIndex: s, record: true, acc })
          console.log(
            `[E2E][PERF-103] sample ${s}: reduxCommit=${sample.reduxCommitMs.toFixed(1)}ms, ` +
              `firstRender=${sample.firstRenderMs.toFixed(1)}ms, reduxToDom=${sample.reduxToDomMs.toFixed(1)}ms, ` +
              `endpointMutation=${sample.endpointSource === 'mutation' ? 1 : 0}, ` +
              `ltSupported=${sample.longtaskSupported}, ltOverlapCount=${sample.intervalOverlapLongtaskCount}, ` +
              `ltOverlapTotal=${sample.longtaskOverlapTotalMs.toFixed(1)}ms, ` +
              `ltOverlapMax=${sample.longtaskOverlapMaxMs.toFixed(1)}ms, ` +
              `frameMax=${sample.frameDeltaMaxMs.toFixed(1)}ms`
          )
        }
        console.log(
          `[E2E][PERF-103] measured samples: ${acc.samples}/${SCALE.measuredSamples} recorded (${SCALE.measuredSamples} per contract)`
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
        const result = buildBenchmarkResult(acc, environment)

        // In-spec validation before the writer: metric/gate id uniqueness and
        // finite values (the writer enforces the closed schema + finiteness,
        // but uniqueness is spec-side).
        const metricIds = result.metrics.map((m) => m.id)
        expect(new Set(metricIds).size, 'all metric ids must be unique').toBe(metricIds.length)
        const gateIds = result.gates.map((g) => g.id)
        expect(new Set(gateIds).size, 'all gate ids must be unique').toBe(gateIds.length)
        expect(
          result.metrics.every((m) => Number.isFinite(m.value)),
          'every metric value must be finite'
        ).toBe(true)

        // ---- PERF-103 attribution identity contract (static, in-spec) -------
        // The baseline identity is preserved as an exact subset (16 metrics /
        // 8 gates, ids verbatim); the attribution slice adds an exact
        // deterministic count of L3 metrics and correctness gates. No
        // threshold gate exists anywhere in this file.
        expect(
          result.metrics.length,
          `total metric count must be exactly ${TOTAL_METRIC_COUNT} (${BASELINE_METRIC_COUNT} baseline + ${ATTRIBUTION_METRIC_COUNT} attribution L3; observed ${result.metrics.length})`
        ).toBe(TOTAL_METRIC_COUNT)
        expect(
          result.gates.length,
          `total gate count must be exactly ${TOTAL_GATE_COUNT} (${BASELINE_GATE_COUNT} baseline + ${ATTRIBUTION_GATE_IDS.length} attribution; observed ${result.gates.length})`
        ).toBe(TOTAL_GATE_COUNT)
        expect(
          result.metrics.length - BASELINE_METRIC_COUNT,
          'the exact new attribution metric count must be deterministic'
        ).toBe(ATTRIBUTION_METRIC_COUNT)
        expect(
          result.gates.length - BASELINE_GATE_COUNT,
          'the exact new attribution gate count must be deterministic'
        ).toBe(ATTRIBUTION_GATE_IDS.length)
        for (const id of BASELINE_METRIC_IDS) {
          expect(metricIds, `baseline metric id must remain present unchanged: ${id}`).toContain(id)
        }
        for (const id of BASELINE_GATE_IDS) {
          expect(gateIds, `baseline gate id must remain present unchanged: ${id}`).toContain(id)
        }
        const expectedAttributionIds: string[] = [
          ...ATTRIBUTION_GRID_PREFIXES.flatMap((prefix) => STAT_SUFFIXES.map((suffix) => `${prefix}.${suffix}`)),
          'attribution.longtaskSupportedCount',
          'attribution.longtaskSupportedRatio',
          'attribution.mutationResolvedCount',
          'attribution.mutationResolvedRatio',
          'attribution.longtaskOverlapSampleCount',
          'attribution.longtaskOverlapSampleRatio'
        ]
        for (const id of expectedAttributionIds) {
          expect(metricIds, `attribution metric id must be present: ${id}`).toContain(id)
        }
        for (const id of ATTRIBUTION_GATE_IDS) {
          expect(gateIds, `attribution gate id must be present: ${id}`).toContain(id)
        }
        // The scale carries the numeric-only attribution definition code.
        expect(
          result.benchmark.scale.attributionDefinitionCode,
          'the scale must carry the numeric attribution definition code'
        ).toBe(SCALE.attributionDefinitionCode)

        const artifactPath = writeBenchmarkResult(result)
        expect(fs.existsSync(artifactPath), 'artifact must exist after a passing run').toBe(true)
        // Only a safe basename is printed — absolute machine-local artifact
        // paths never enter logs (privacy/redaction).
        console.log(
          `[E2E][PERF-103] schema v1 artifact: ${path.basename(artifactPath)} ` +
            `(${SCALE.warmupSamples} warmup + ${SCALE.measuredSamples} measured samples)`
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
        console.log(`[E2E][PERF-103] lifecycle diagnostic attach failed: ${String(attachError)}`)
      }
      throw error
    } finally {
      // Deterministic listener cleanup — also covers a tape read that failed
      // after a full process death (the dispose evaluate is swallowed).
      await disposeLifecycleTape(electronApp)
    }
  })
})
