/**
 * PERF-102 concurrent multi-model stream measurement (production-build Playwright E2E).
 *
 * Purpose (docs/performance-program.md §16, PERF-102 measurement-first slice):
 *   Deterministic, bounded, correctness-first measurements of the AMPLIFICATION
 *   caused by N concurrent multi-model streams on the ONE visible fold-mode
 *   stream and renderer responsiveness, against a FRESH production build via
 *   the standard shared E2E fixture. The production multi-model send path is
 *   exercised end-to-end: the real inputbar mention tool selects N distinct
 *   mock-backed models, a real user send (production `sendMessage` thunk)
 *   fans the N streams out to the per-topic PQueue (unbounded concurrency —
 *   genuinely concurrent), the fold layout displays the first selected answer
 *   while every stream updates Redux + the rendered (hidden and visible)
 *   message DOM. This slice is MEASUREMENT-ONLY: no runtime optimization, no
 *   threshold, no root-cause attribution (PERF-LOCK-004/005/007, §16 next unit).
 *
 * Profiles (PERF102_SCALE; unset/empty = n1). Exactly three explicit profiles:
 *   - n1 (profileCode 0, benchmark id perf102-multimodel-stream-n1): N=1
 *   - n2 (profileCode 1, benchmark id perf102-multimodel-stream-n2): N=2
 *   - n3 (profileCode 2, benchmark id perf102-multimodel-stream-n3): N=3
 *   Each sample runs in a FRESH empty topic (created via the established
 *   assistants/addTopic + ChatDb ensureTopic + real sidebar item pattern), so
 *   the topic contains exactly [1 user message, N assistant streams] and the
 *   fold layout shows exactly one group with N model tabs.
 *
 * Deterministic synthetic slow-stream workload (existing mock asset, no mock
 * change): the user message carries the `__E2E_SLOW_STREAM__` opt-in marker, so
 * every request streams the fixed 150-paragraph / 60ms-per-paragraph reply
 * (`getSlowStreamReply(model)` — about 9s per stream). Each stream's reply is
 * deterministic PER model (`[Mock <model>] Slow stream started. … tail-marker-END`),
 * which makes exact per-stream completion and cross-stream contamination
 * provable. The workload is fast enough to run in a bounded E2E run yet long
 * enough that overlap and responsiveness are observable without profile-scale
 * load (LOCK-007).
 *
 * Measurement model (one sample = one measured send):
 *   - t0 (tSend) is captured in the SAME page task as the synthetic Enter
 *     keydown that triggers the production Inputbar send handler (Playwright's
 *     CDP key would inject an uncontrollable round-trip into the interval).
 *   - Redux stream series: a store.subscribe listener records, per main_text
 *     block, every content-length/status change with a timestamp (deduped;
 *     first-content = first len>0, completion = first status 'success').
 *   - DOM stream series: a MutationObserver on `#messages` records, per
 *     `[data-message-id]` element, the rendered `.markdown` text length at each
 *     commit (deduped) — including the hidden non-selected fold wrappers.
 *   - Renderer input latency during overlap: bounded deterministic probes that
 *     write a fixed >=3-line value (two newline boundaries) into the REAL
 *     textarea and measure the interval from the native input event to the
 *     React commit visible as autoSize row growth (offsetHeight increase).
 *     The production Inputbar textarea autoSize minRows=2 renders the empty
 *     draft at 2-row height, so a probe must carry at least 3 lines to
 *     deterministically cross that baseline — a 2-line probe can never grow
 *     offsetHeight; probes run while >= min(2,N) streams have observed
 *     content.
 *   - Aggregate frame cadence: a rAF loop records consecutive frame deltas
 *     (p50/p95/mean/max + count; always finite), RESET at tSend so the series
 *     covers the measured send-to-completion window only — pre-send setup
 *     frames (topic activation, text-commit waits) never enter the metric.
 *   - Aggregate long tasks: a PerformanceObserver('longtask') records durations
 *     (count/total/max/p95; zero when no long task occurs — metrics stay finite).
 *
 * Correctness gates run BEFORE artifact acceptance/emission (a failure aborts
 * the test and produces NO artifact, audit F1-style gate, §5.1). The per-sample
 * gates run AFTER the timing record — the ordering contract is gates → artifact,
 * not gates → timing:
 *   - fanout.requestCount — exactly N product chat-completion requests, one per
 *     mentioned model, all stream:true (mock request log, sequence-scoped).
 *   - fanout.userMessageMentions — the persisted user message's `mentions`
 *     array carries exactly the N model ids (production mention send proof).
 *   - fanout.simultaneousProgression — for N>1 at least two streams are alive
 *     (have first content and are not yet complete) at the same instant; the
 *     maximum number of simultaneously alive streams is computed from the
 *     recorded Redux series and asserted >= min(2, N) (N=1 adapted truthfully:
 *     the single stream progressed — first content before completion).
 *   - content.exactCompletion — every stream's final block content equals its
 *     exact deterministic expected reply with status 'success'.
 *   - content.noCrossContamination — no stream's content contains another
 *     model's reply marker.
 *   - group.singleGroupDistinctModels — exactly one user message + N assistant
 *     messages, N DISTINCT model-backed assistants, every assistant sharing the
 *     user's askId (one fold group).
 *   - visible.domCompleted — the visible (default-selected) stream's rendered
 *     `.markdown` contains the final content marker (tail-marker-END).
 *   - visible.selected — exactly one `.selected` message wrapper in the fold
 *     group and it is the visible first stream (default fold selection).
 *     Both visible gates use a bounded settle read: the final markdown flush
 *     can lag the completion resolution by a render tick, so the DOM snapshot
 *     is re-read for a short deadline before the assertions run.
 *   - main.parity — Main SQLite holds exactly 1+N topic-owned messages, all
 *     success, every assistant message owning exactly one block. Read through
 *     a bounded settle: the production completion callback commits Redux
 *     success BEFORE the final SQLite write lands, so `fetchMessages` is
 *     re-polled for a short deadline until the parity contract holds.
 *   - samples.completed — every sample finished with finite metrics.
 *   - environment.abi145 — Electron ABI 145 lane, safe canonical command.
 *   - privacy.schemaV1 — metrics/gates/scale carry only numbers and fixed
 *     strings (closed schema set, enforced at write time).
 *
 * Sample isolation:
 *   - Before EVERY sample's mention selection the prior sample's mention state
 *     is deterministically cleared through the production UI path (the real
 *     per-chip close button → `handleRemoveModel`) and asserted empty — the
 *     production send does NOT clear `mentionedModels`, and the mention panel
 *     TOGGLES selection, so without the clear sample 2/3 would deterministically
 *     un-select sample 1's mentions (audit blocker). Each sample then selects
 *     exactly N models in a fresh empty topic.
 *
 * Evidence classification (PERF-LOCK-003 / §6):
 *   - Deterministic L1 regression evidence when run on a fresh build with the
 *     standard fixture; the numeric metrics remain L3 provisional values until
 *     re-measured per §7. No thresholds are asserted.
 *
 * Instrumentation boundary (PERF-LOCK-006/008, §16 non-goals):
 *   - All instrumentation lives in the test page context only (store.subscribe
 *     listener, MutationObserver, PerformanceObserver, rAF loop, synthetic
 *     input/Enter events through the app's real registered handlers). No
 *     production code is changed, no application instrumentation is added, no
 *     Main-process wiring is touched, no mock per-chunk timestamps are added.
 *   - Sample isolation is enforced OUTSIDE the measured window and cannot
 *     perturb the recorded series: the pre-send mention-state clear (production
 *     chip close path) runs before tSend, and the post-send bounded
 *     settle/retry reads run after the timing record.
 *   - The page-context instrumentation is scoped to the current sample topic:
 *     the store.subscribe Redux scan and the `#messages` DOM scan record only
 *     messages whose ids belong to the sample-owned message-id set (adopted
 *     from the sample topic's `messageIdsByTopic` as they appear). The set
 *     starts empty on the fresh empty topic — the documented brief bootstrap:
 *     nothing is recorded before the send creates the sample's first message,
 *     and prior samples' blocks/elements are never scanned.
 *   - The rAF frame-delta series is reset at tSend so `frame.delta` measures
 *     send-to-completion cadence only; the frame loop doubles as the once-per-
 *     frame DOM scan drain (see Measurement model).
 *   - Serialization rule: `page.evaluate` / `electronApp.evaluate` callbacks
 *     are serialized WITHOUT module closures — every value a callback reads
 *     arrives as an explicit evaluate argument.
 *   - Main-process lifecycle tape (failure diagnostics only): installed via
 *     `electronApp.evaluate` BEFORE phase execution, bounded at 64 events
 *     (drop-oldest), closed field set; never enters the schema-v1 artifact; on
 *     failure a bounded JSON diagnostic is attached via `testInfo.attach`
 *     BEFORE fixture teardown (success attaches nothing).
 *
 * Cleanup/abort:
 *   - Instrumentation is detached in `finally` blocks; the fixture owns the
 *     disposable profile/owned-temp-root cleanup and closes the app. A failed
 *     sample throws and produces NO artifact.
 *   - Bounded-run budget: profile-bounded test timeouts aligned with per-wait
 *     bounds (watchdogs 5s probe / 120s completion / 15s panel) so a hang fails
 *     with a targeted diagnostic instead of an inflated global timeout.
 */
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

import { mean, percentile, sortTimings } from '../../../../src/main/services/chatDb/__tests__/benchMetrics'
import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkGate,
  type BenchmarkMetric,
  type BenchmarkResult,
  collectEnvironmentMetadata,
  writeBenchmarkResult
} from '../../../../src/main/services/chatDb/__tests__/benchResult'
import { expect, getRequestLog, getRequestSequence, test } from '../../fixtures/electron.fixture'
import { getSlowStreamReply, SLOW_STREAM_MARKER } from '../../fixtures/mock-openai-server'

// ---------------------------------------------------------------------------
// Deterministic bounded scale (recorded verbatim in the artifact's scale map)
// ---------------------------------------------------------------------------

/**
 * Fixed constants shared by every profile. Sample count and the synthetic
 * slow-stream workload (existing mock asset) are identical across profiles so
 * the curve compares only the stream concurrency N.
 */
const SCALE = {
  samplesPerProfile: 3,
  probeCountPerSample: 6,
  /** Synthetic slow-stream workload: paragraph count + chunk delay (mock asset). */
  streamParagraphs: 150,
  streamChunkDelayMs: 60
} as const

/**
 * Bounded settle deadlines for the post-send correctness reads. These bound how
 * long the gate readers wait for state that legitimately lands AFTER the Redux
 * completion signal (the final Main SQLite write, the final visible DOM commit).
 * They are NOT timing metrics, never enter the artifact's schema-v1 scale map,
 * and expire fail-closed: a deadline expiry asserts against the last observed
 * snapshot, so a stale read can never be accepted as a pass.
 */
const SETTLE = {
  /** Main SQLite parity settle after the Redux success commit. */
  mainParityMs: 5000,
  /** Visible DOM tail/selected/displayed settle before final assertions. */
  visibleDomMs: 5000,
  /** Poll interval for both settles. */
  pollMs: 200
} as const

type ScaleProfileKind = 'n1' | 'n2' | 'n3'

/** One closed measurement profile — all fields are deterministic. */
interface ScaleProfile {
  kind: ScaleProfileKind
  /** Distinct safe benchmark id (schema v1 `benchmark.id`, artifact file name). */
  benchmarkId: string
  benchmarkName: string
  /** Number of concurrently mentioned (streaming) models N. */
  mentionModelCount: number
  samplesPerProfile: number
  probeCountPerSample: number
  testTimeoutMs: number
}

/** Opt-in env selecting the measurement profile; unset/empty = n1 (default). */
const PERF102_SCALE_ENV = 'PERF102_SCALE'

/** Numeric profile identity recorded in the scale map (scale is numeric-only). */
const PROFILE_CODE: Record<ScaleProfileKind, number> = { n1: 0, n2: 1, n3: 2 }

/** The n1 profile is the DEFAULT (no env): the single-stream baseline. */
const N1_PROFILE: ScaleProfile = {
  kind: 'n1',
  benchmarkId: 'perf102-multimodel-stream-n1',
  benchmarkName: 'PERF-102 N=1 single-model stream baseline (production-build E2E, Electron lane)',
  mentionModelCount: 1,
  samplesPerProfile: SCALE.samplesPerProfile,
  probeCountPerSample: SCALE.probeCountPerSample,
  testTimeoutMs: 420000
}

/** Build the N=2 profile (two concurrent streams). */
function buildN2Profile(): ScaleProfile {
  return {
    kind: 'n2',
    benchmarkId: 'perf102-multimodel-stream-n2',
    benchmarkName: 'PERF-102 N=2 concurrent multi-model stream measurement (production-build E2E, Electron lane)',
    mentionModelCount: 2,
    samplesPerProfile: SCALE.samplesPerProfile,
    probeCountPerSample: SCALE.probeCountPerSample,
    testTimeoutMs: 480000
  }
}

/** Build the N=3 profile (three concurrent streams). */
function buildN3Profile(): ScaleProfile {
  return {
    kind: 'n3',
    benchmarkId: 'perf102-multimodel-stream-n3',
    benchmarkName: 'PERF-102 N=3 concurrent multi-model stream measurement (production-build E2E, Electron lane)',
    mentionModelCount: 3,
    samplesPerProfile: SCALE.samplesPerProfile,
    probeCountPerSample: SCALE.probeCountPerSample,
    testTimeoutMs: 600000
  }
}

/**
 * Resolve the measurement profile from the runner env. Unset/empty keeps the
 * default n1 profile; unsupported values fail clearly BEFORE any measurement.
 */
function resolveScaleProfile(): ScaleProfile {
  const raw = (process.env[PERF102_SCALE_ENV] ?? '').trim()
  if (raw.length === 0) return N1_PROFILE
  const normalized = raw.toLowerCase()
  if (normalized === 'n1') return N1_PROFILE
  if (normalized === 'n2') return buildN2Profile()
  if (normalized === 'n3') return buildN3Profile()
  throw new Error(
    `[PERF-102] unsupported PERF102_SCALE value "${raw}" — expected "n1", "n2" or "n3" (unset/empty keeps the default n1 profile)`
  )
}

/** Canonical safe command recorded in the artifact (no path segments, audit F3). */
const CANONICAL_COMMAND = 'pnpm test:e2e'

/** Fixed synthetic seed timestamps (deterministic, non-sensitive). */
const SEED_CREATED_AT = '2026-08-14T00:00:00.000Z'

/** The provider hosting the fixture's default model + the registered mention models. */
const MOCK_PROVIDER_ID = 'mock-openai'

/** Deterministic user message text; the marker makes every request a slow stream. */
const SEND_MESSAGE_TEXT = `p102 concurrent multi-model probe ${SLOW_STREAM_MARKER}`

/**
 * Deterministic mention model ids for a profile: `mock-model-0..N-1`. These are
 * distinct from the fixture's default `mock-model` and are registered into the
 * mock provider's Redux model list (test state only).
 */
function mentionModelIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `mock-model-${i}`)
}

/** Deterministic mention model display names (`Mock Model 0..N-1`). */
function mentionModelNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Mock Model ${i}`)
}

/** Expected final content of stream `modelId` (deterministic mock slow-stream reply). */
function expectedReplyFor(modelId: string): string {
  return getSlowStreamReply(modelId)
}

// ---------------------------------------------------------------------------
// Page-context helpers — model registration, topic activation, mention UI
// ---------------------------------------------------------------------------

/**
 * Register N distinct mock-backed models into the mock provider's Redux model
 * list (test state only) so the real mention panel can select them. Idempotent;
 * verifies the models landed before returning.
 */
async function registerMentionModels(page: Page, profile: ScaleProfile): Promise<void> {
  const ids = mentionModelIds(profile.mentionModelCount)
  await page.evaluate(
    ({ providerId, models }) => {
      const store = (window as any).store
      const s = store.getState()
      const provider = (s.llm?.providers ?? []).find((p: any) => p.id === providerId)
      const existing = new Set<string>((provider?.models ?? []).map((m: any) => String(m.id)))
      for (const model of models) {
        if (existing.has(model.id)) continue
        store.dispatch({ type: 'llm/addModel', payload: { providerId, model } })
      }
    },
    {
      providerId: MOCK_PROVIDER_ID,
      models: ids.map((id, i) => ({ id, provider: MOCK_PROVIDER_ID, name: `Mock Model ${i}`, group: 'mock' }))
    }
  )
  const ok = await page.evaluate(
    ({ providerId, ids }) => {
      const s = (window as any).store.getState()
      const provider = (s.llm?.providers ?? []).find((p: any) => p.id === providerId)
      const inState = new Set<string>((provider?.models ?? []).map((m: any) => String(m.id)))
      return ids.every((id: string) => inState.has(id))
    },
    { providerId: MOCK_PROVIDER_ID, ids }
  )
  if (!ok) throw new Error(`registerMentionModels: failed to register ${ids.join(', ')}`)
}

/**
 * Create a fresh deterministic EMPTY topic in Redux + SQLite (typed ChatDb
 * bridge: assistants/addTopic + ensureTopic) and make it the active topic via
 * the real sidebar item, so the Inputbar binds to it and the app loads it
 * through the production path. Every sample uses a distinct topic so the topic
 * contains exactly the measured [1 user + N assistant] group.
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
  await item.waitFor({ state: 'visible', timeout: 15000 })
  await item.click()

  await page.waitForFunction(
    (topicId) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      return Array.isArray(ids) && s.messages?.currentTopicId === topicId && !s.messages?.loadingByTopic?.[topicId]
    },
    topicId,
    { timeout: 30000 }
  )
}

/**
 * Deterministically clear any PREVIOUSLY mentioned models before a sample's
 * selection (audit BLOCKER-1: cross-sample mention-state contamination). The
 * production send clears only text/files — `mentionedModels` survives the send
 * and the Inputbar stays mounted across topic switches, so sample 2/3 would
 * otherwise reopen the panel with the prior sample's models pre-selected. The
 * production mention panel TOGGLES (`onMentionModel` removes an already
 * selected model), so a click would DESELECT instead of select. This drives
 * the REAL per-chip close button (production `handleRemoveModel` →
 * InputbarTools context state) ONE CHIP PER TASK — the removal handler filters
 * a single-render `mentionedModels` closure, so multiple clicks in the same
 * task would drop all but the last removal. After the chips are gone it
 * asserts the mention state is empty (fail-closed before the selection).
 */
async function clearMentionedModels(page: Page, profile: ScaleProfile): Promise<void> {
  const inputbar = page.locator('#inputbar')
  await inputbar.waitFor({ state: 'visible', timeout: 15000 })
  const names = mentionModelNames(profile.mentionModelCount)
  // A mention chip is a closable CustomTag carrying the deterministic model
  // name; the fixture's inputbar holds no knowledge-base or attachment chips
  // (no files are attached and the default assistant has no knowledge bases),
  // and the name filter keeps the clear strictly limited to mention chips.
  const chipClose = (name: string) =>
    inputbar
      .locator('div')
      .filter({ hasText: name })
      .filter({ has: page.locator('> .anticon-close') })
      .first()
      .locator('.anticon-close')
  for (let guard = 0; guard < 32; guard++) {
    let clicked = false
    for (const name of names) {
      const close = chipClose(name)
      if ((await close.count()) > 0) {
        await close.click()
        await close.waitFor({ state: 'detached', timeout: 5000 })
        clicked = true
        break
      }
    }
    if (!clicked) break
  }
  await expect(inputbar.locator('.anticon-close')).toHaveCount(0, { timeout: 5000 })
}

/**
 * Drive the REAL mention-tool UI to select exactly the profile's models: first
 * deterministically clear any prior mention state (sample isolation), then
 * click the inputbar "Select Model" button (opens the production QuickPanel
 * with the provider model list), click each model item (multiple-select mode
 * keeps the panel open), verify the mention chip appears inside the inputbar
 * after each selection, then close the panel with Escape. The selected models
 * become the `mentionedModels` the production Inputbar send path attaches to
 * the user message.
 */
async function selectMentionModels(page: Page, profile: ScaleProfile): Promise<void> {
  // Sample isolation FIRST: the panel's isSelected reflects `mentionedModels`,
  // so selection must start from a deterministically empty state — a stale
  // pre-selected model would be toggled OFF by the first click.
  await clearMentionedModels(page, profile)

  const names = mentionModelNames(profile.mentionModelCount)
  const mentionButton = page.locator('.inputbar').getByRole('button', { name: 'Select Model' }).first()
  await mentionButton.waitFor({ state: 'visible', timeout: 15000 })
  await mentionButton.click()

  const panel = page.locator('[data-testid="quick-panel"]')
  await panel.waitFor({ state: 'visible', timeout: 15000 })

  // Assert the panel carries NO pre-selected model item before selecting the
  // N profile models — this asserts exactly the production state the send will
  // read (each click below must ADD, never toggle off).
  await expect(panel.locator('[data-id].selected')).toHaveCount(0, { timeout: 5000 })

  for (const name of names) {
    const item = panel.locator('[data-id]').filter({ hasText: name }).first()
    await item.click()
    // The mention chip renders in the inputbar's topContent area (`#inputbar`),
    // NOT inside the quick panel — scoping to `#inputbar` proves the mention
    // was actually committed to the InputbarTools state, not just highlighted
    // in the panel.
    await expect(page.locator('#inputbar')).toContainText(name, { timeout: 5000 })
  }

  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible({ timeout: 5000 })
}

// ---------------------------------------------------------------------------
// Post-send state readers (correctness gates)
// ---------------------------------------------------------------------------

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
    modelId: string | null
    mentions: string[]
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
        modelId: m.model?.id ?? m.modelId ?? null,
        mentions: Array.isArray(m.mentions) ? m.mentions.map((x: any) => String(x?.id ?? '')) : [],
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
  assistantBlockCounts: number[]
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
      assistantBlockCounts: messages
        .filter((m) => m.role === 'assistant')
        .map((m) => (Array.isArray(m.blocks) ? m.blocks.length : 0)),
      blockStatuses: blocks.map((b) => String(b.status ?? '')),
      blockOwnership: blocks.every(
        (b) => String(b.messageId) !== '' && messages.some((m) => String(m.id) === String(b.messageId))
      )
    }
  }, topicId)
}

/** True when a Main snapshot already satisfies every `main.parity` condition. */
function mainParityReady(snapshot: MainParitySnapshot, n: number): boolean {
  return (
    snapshot.messageCount === 1 + n &&
    snapshot.allOwned &&
    [...snapshot.roles].sort().join(',') === ['user', ...Array<string>(n).fill('assistant')].sort().join(',') &&
    snapshot.statuses.every((s) => s === 'success') &&
    snapshot.assistantBlockCounts.every((c) => c === 1) &&
    snapshot.blockStatuses.every((s) => s === 'success') &&
    snapshot.blockOwnership
  )
}

/**
 * Bounded settle for the Main SQLite parity read (audit F2). The production
 * completion callback commits Redux success BEFORE the final `saveUpdatesToDB`
 * write lands, so a single eager `fetchMessages` read can race the last row.
 * Re-polls through the existing readMainTopic/fetchMessages path until the full
 * parity contract holds or the short explicit deadline expires. On expiry the
 * last snapshot is returned and the `main.parity` assertions fail with its
 * actual values (fail-closed — a stale read is never accepted).
 */
async function readMainTopicSettled(page: Page, topicId: string, n: number): Promise<MainParitySnapshot> {
  const deadline = Date.now() + SETTLE.mainParityMs
  let snapshot = await readMainTopic(page, topicId)
  while (!mainParityReady(snapshot, n) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE.pollMs))
    snapshot = await readMainTopic(page, topicId)
  }
  return snapshot
}

/** Rendered DOM snapshot of one message wrapper (found/selected/display/markdown). */
interface VisibleDomSnapshot {
  found: boolean
  selected: boolean
  display: string
  markdown: string
}

/** Read the visible (default-selected) fold message's DOM state. */
async function readVisibleDom(page: Page, visibleMessageId: string): Promise<VisibleDomSnapshot> {
  return page.evaluate((visibleMessageId) => {
    const el = document.getElementById(`message-${visibleMessageId}`)
    if (!el) return { found: false, selected: false, display: 'none', markdown: '' }
    const md = el.querySelector('.markdown')
    return {
      found: true,
      selected: el.classList.contains('selected'),
      display: window.getComputedStyle(el).display,
      markdown: md ? (md.textContent ?? '') : ''
    }
  }, visibleMessageId)
}

/** True when the visible stream's DOM already satisfies the final-state contract. */
function visibleDomReady(snapshot: VisibleDomSnapshot): boolean {
  return (
    snapshot.found && snapshot.selected && snapshot.display !== 'none' && snapshot.markdown.includes('tail-marker-END')
  )
}

/**
 * Bounded settle for the visible-stream DOM read (audit F6). The final markdown
 * flush can lag the completion resolution by a render tick under contention;
 * re-reads the same raw snapshot until found/selected/displayed/final-tail all
 * hold or the short explicit deadline expires. On expiry the last snapshot is
 * asserted against (fail-closed).
 */
async function readVisibleDomSettled(page: Page, visibleMessageId: string): Promise<VisibleDomSnapshot> {
  const deadline = Date.now() + SETTLE.visibleDomMs
  let snapshot = await readVisibleDom(page, visibleMessageId)
  while (!visibleDomReady(snapshot) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE.pollMs))
    snapshot = await readVisibleDom(page, visibleMessageId)
  }
  return snapshot
}

/**
 * Fanout proof from the mock request log: every product STREAMING
 * chat-completion request whose sequence >= the captured pre-send sequence
 * belongs to this sample. The `stream === true` discriminator is the
 * established topic-auto-naming convention: non-streaming summary/naming
 * requests (which never fire for the custom-named sample topics, but must stay
 * excluded defensively) can never be misclassified as a fanout stream.
 */
function sampleFanoutRequests(afterSequence: number): Array<{ model: string; stream: boolean }> {
  return getRequestLog()
    .filter(
      (entry) =>
        entry.sequence >= afterSequence &&
        entry.method === 'POST' &&
        (entry.url === '/v1/chat/completions' || entry.url === '/chat/completions') &&
        entry.parsed?.stream === true
    )
    .map((entry) => ({
      model: String(entry.parsed?.model ?? ''),
      stream: entry.parsed?.stream === true
    }))
}

// ---------------------------------------------------------------------------
// Timed measurement — page-context instrumentation + measured send
// ---------------------------------------------------------------------------

/** One per-block Redux commit series (deduped; bounded). */
interface ReduxBlockSeries {
  messageId: string
  series: Array<{ t: number; len: number; status: string }>
}

/** One per-message DOM `.markdown` length series (deduped; bounded). */
interface DomMessageSeries {
  messageId: string
  series: Array<{ t: number; len: number }>
}

/** Bounded record returned by the instrumentation evaluate. */
interface InstrumentationResult {
  tSend: number
  tComplete: number
  redux: ReduxBlockSeries[]
  dom: DomMessageSeries[]
  inputProbes: Array<{ latencyMs: number }>
  longTasks: number[]
  frameDeltas: number[]
  completion: { messageCount: number; assistantCount: number }
}

/**
 * Measure ONE concurrent multi-model send end-to-end. Installs all page-context
 * instrumentation, sets the message text through the native setter + input
 * event (React controlled value commits → the send button enables), then
 * dispatches a synthetic Enter keydown in the same task as t0 — the app's REAL
 * Inputbar handler runs the production `sendMessage` thunk with the selected
 * mentions, so the N streams genuinely fan out through the per-topic PQueue.
 * While >= min(2, N) streams have observed content, bounded input-latency
 * probes run against the real textarea; the evaluate resolves when every
 * assistant stream reached success (blocks status 'success'), then detaches
 * all instrumentation and returns the bounded record.
 */
function measureMultiModelSend(
  page: Page,
  args: {
    topicId: string
    messageText: string
    mentionModelCount: number
    probeCount: number
    completionTimeoutMs: number
    probeWatchdogMs: number
  }
): Promise<InstrumentationResult> {
  return page.evaluate(
    async ({ topicId, messageText, mentionModelCount, probeCount, completionTimeoutMs, probeWatchdogMs }) => {
      const store = (window as any).store
      const textarea = document.querySelector('.inputbar textarea') as HTMLTextAreaElement | null
      if (!textarea) throw new Error('measure: inputbar textarea not found')
      const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSet) throw new Error('measure: textarea native value setter unavailable')

      // ---- Sample-owned message-ID set (instrumentation scoping) ------------
      // The Redux store and `#messages` DOM hold every topic visited earlier in
      // this run. The store.subscribe scan and the DOM scan must record ONLY
      // this sample's messages — prior samples' blocks/elements are never
      // scanned (audit F4: per-dispatch scan cost must not grow with the store
      // nor perturb the measured longtask/frame metrics). The set starts empty
      // on the fresh empty sample topic and is adopted from the topic's
      // `messageIdsByTopic` as they appear: the first ID (the user message)
      // lands on send, the N assistant IDs follow. This is the documented brief
      // bootstrap — nothing is recorded before the send creates the sample's
      // first message.
      const sampleMessageIds = new Set<string>()
      const adoptSampleMessageIds = (): void => {
        const s = store.getState()
        const ids: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
        for (const id of ids) sampleMessageIds.add(String(id))
      }

      // ---- Redux stream series (per main_text block, deduped) ---------------
      const reduxBlocks = new Map<
        string,
        {
          messageId: string
          lastLen: number
          lastStatus: string
          series: Array<{ t: number; len: number; status: string }>
        }
      >()
      const recordRedux = (blockId: string, messageId: string, len: number, status: string): void => {
        const prev = reduxBlocks.get(blockId)
        if (prev && prev.lastLen === len && prev.lastStatus === status) return
        const t = performance.now()
        if (prev) {
          prev.lastLen = len
          prev.lastStatus = status
        } else {
          reduxBlocks.set(blockId, { messageId, lastLen: len, lastStatus: status, series: [] })
        }
        reduxBlocks.get(blockId)!.series.push({ t, len, status })
      }
      const handleStoreUpdate = (): void => {
        adoptSampleMessageIds()
        const s = store.getState()
        const blocks = s?.messageBlocks?.entities ?? {}
        for (const block of Object.values(blocks) as any[]) {
          if (!block || block.type !== 'main_text') continue
          if (!sampleMessageIds.has(String(block.messageId ?? ''))) continue
          const len = typeof block.content === 'string' ? block.content.length : 0
          recordRedux(String(block.id), String(block.messageId ?? ''), len, String(block.status ?? ''))
        }
      }
      const unsubscribe = store.subscribe(handleStoreUpdate)
      handleStoreUpdate()

      // ---- DOM `.markdown` length series (per message, deduped) -------------
      // The MutationObserver callback only SETS a dirty flag — the actual
      // textContent scan runs at most ONCE PER FRAME inside the frame loop.
      // Character-level smooth-stream rendering would otherwise fire thousands
      // of observer callbacks whose layout-reading scans would perturb the very
      // frame/long-task metrics this spec measures. The scan records only
      // elements whose ids belong to the sample-owned set above, so a prior
      // sample's elements still present during the topic switch are skipped.
      const domSeries = new Map<string, { lastLen: number; series: Array<{ t: number; len: number }> }>()
      let domDirty = true
      const scanDom = (): void => {
        const t = performance.now()
        for (const el of document.querySelectorAll('#messages [data-message-id]')) {
          const messageId = el.getAttribute('data-message-id')
          if (!messageId) continue
          if (!sampleMessageIds.has(messageId)) continue
          const md = el.querySelector('.markdown')
          const len = md ? (md.textContent ?? '').length : 0
          const prev = domSeries.get(messageId)
          if (prev && prev.lastLen === len) continue
          if (prev) {
            prev.lastLen = len
          } else {
            domSeries.set(messageId, { lastLen: len, series: [] })
          }
          domSeries.get(messageId)!.series.push({ t, len })
        }
      }
      const messagesEl = document.getElementById('messages')
      const observer = new MutationObserver(() => {
        domDirty = true
      })
      if (messagesEl) observer.observe(messagesEl, { subtree: true, childList: true, characterData: true })
      scanDom()

      // ---- Long tasks (finite even when none occur) -------------------------
      const longTasks: number[] = []
      let perfObserver: PerformanceObserver | null = null
      try {
        perfObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration)
        })
        perfObserver.observe({ entryTypes: ['longtask'] })
      } catch {
        perfObserver = null
      }

      // ---- rAF frame-delta cadence (finite) --------------------------------
      // The same frame loop also drains the DOM dirty flag (scan at most once
      // per frame) so observer callbacks never read layout during mutation
      // storms; frame deltas and DOM content snapshots share one cadence.
      const frameDeltas: number[] = []
      let lastFrame = performance.now()
      let rafId = 0
      const frameLoop = (): void => {
        const now = performance.now()
        frameDeltas.push(now - lastFrame)
        lastFrame = now
        if (domDirty) {
          domDirty = false
          scanDom()
        }
        rafId = requestAnimationFrame(frameLoop)
      }
      rafId = requestAnimationFrame(frameLoop)

      // ---- Stream progression helpers ---------------------------------------
      const topicAssistantIds = (): string[] => {
        const s = store.getState()
        const ids: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
        return ids.filter((id: string) => s.messages.entities[id]?.role === 'assistant')
      }
      const streamsWithContent = (): number => {
        const s = store.getState()
        return topicAssistantIds().filter((id: string) => {
          const msg = s.messages.entities[id]
          const blocks: string[] = msg?.blocks ?? []
          return blocks.some((bid: string) => {
            const b = s.messageBlocks?.entities?.[bid]
            return !!b && typeof b.content === 'string' && b.content.length > 0
          })
        }).length
      }
      const allStreamsSuccess = (): boolean => {
        const s = store.getState()
        const assistantIds = topicAssistantIds()
        if (assistantIds.length < mentionModelCount) return false
        return assistantIds.every((id: string) => {
          const msg = s.messages.entities[id]
          if (msg.status !== 'success') return false
          const blocks: string[] = msg.blocks ?? []
          if (blocks.length === 0) return false
          return blocks.every((bid: string) => s.messageBlocks?.entities?.[bid]?.status === 'success')
        })
      }

      // ---- rAF-polled wait (bounded watchdog) --------------------------------
      const waitFor = (predicate: () => boolean, timeoutMs: number, label: string): Promise<void> =>
        new Promise((resolve, reject) => {
          const deadline = performance.now() + timeoutMs
          const poll = (): void => {
            if (predicate()) return resolve()
            if (performance.now() > deadline) return reject(new Error(`${label} timed out`))
            requestAnimationFrame(poll)
          }
          poll()
        })

      // ---- Input-latency probes (during overlap) ----------------------------
      const inputProbes: Array<{ latencyMs: number }> = []
      const runInputProbes = async (): Promise<void> => {
        textarea.focus()
        // Settle to an empty controlled value first (the app clears the draft
        // on send; the baseline is the min-height textarea).
        nativeSet.call(textarea, '')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
        await waitFor(() => textarea.offsetHeight > 0, probeWatchdogMs, 'input probe baseline')
        for (let i = 0; i < probeCount; i++) {
          const baselineHeight = textarea.offsetHeight
          const t0 = performance.now()
          nativeSet.call(textarea, `\n\nprobe-${i}-line`)
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
          // The React commit is observable as autoSize row growth: the probe is
          // a deterministic 3-line value (two newline boundaries), and the
          // production Inputbar textarea autoSize minRows=2 renders the empty
          // draft at 2-row height — so 3 lines must cross the baseline and grow
          // offsetHeight by one row (a 2-line value would equal minRows and
          // never grow). The measured interval is the user keystroke → visible
          // commit latency under stream contention.
          await waitFor(() => textarea.offsetHeight > baselineHeight, probeWatchdogMs, `input probe ${i} growth`)
          inputProbes.push({ latencyMs: performance.now() - t0 })
          nativeSet.call(textarea, '')
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
          await waitFor(() => textarea.offsetHeight <= baselineHeight, probeWatchdogMs, `input probe ${i} reset`)
        }
        nativeSet.call(textarea, '')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      }

      // ---- Set the message text, wait for the React commit, send ------------
      nativeSet.call(textarea, messageText)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await waitFor(
        () => {
          const sendBtn = document.querySelector('.inputbar [aria-label="Send"]')
          return !!sendBtn && sendBtn.getAttribute('aria-disabled') !== 'true'
        },
        5000,
        'message text commit'
      )

      const tSend = performance.now()
      // Reset the frame cadence at tSend so the frame-delta series represents
      // the measured send-to-completion window ONLY (audit F3): pre-send setup
      // frames (topic activation, text-commit wait, instrumentation install)
      // must never leak into `frame.delta`. The first delta pushed after this
      // point is (first rAF after send) − tSend — a genuine send-relative frame
      // interval on the same page clock as every other recorded series.
      frameDeltas.length = 0
      lastFrame = tSend
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

      // ---- Wait for completion; run input probes during the overlap window --
      try {
        const deadline = performance.now() + completionTimeoutMs
        let probesRun = false
        for (;;) {
          if (allStreamsSuccess()) break
          if (performance.now() > deadline) {
            throw new Error(
              `multi-model send completion timeout: assistantCount=${topicAssistantIds().length}, expected=${mentionModelCount}`
            )
          }
          if (!probesRun && streamsWithContent() >= Math.min(2, mentionModelCount)) {
            probesRun = true
            await runInputProbes()
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      } finally {
        unsubscribe()
        observer.disconnect()
        if (perfObserver) perfObserver.disconnect()
        cancelAnimationFrame(rafId)
      }

      const tComplete = performance.now()
      return {
        tSend,
        tComplete,
        redux: Array.from(reduxBlocks.values()).map(({ messageId, series }) => ({ messageId, series })),
        dom: Array.from(domSeries.entries()).map(([messageId, { series }]) => ({ messageId, series })),
        inputProbes,
        longTasks,
        frameDeltas,
        completion: {
          messageCount: (store.getState().messages?.messageIdsByTopic?.[topicId] ?? []).length,
          assistantCount: topicAssistantIds().length
        }
      }
    },
    args
  )
}

// ---------------------------------------------------------------------------
// Per-sample metric extraction + correctness gates
// ---------------------------------------------------------------------------

interface StreamTiming {
  firstContentMs: number
  completionMs: number
  commitIntervals: number[]
}

/** Extract a stream's Redux timing from its block series (len>0 = content). */
function extractReduxTiming(series: Array<{ t: number; len: number; status: string }>): StreamTiming {
  const contentCommits = series.filter((e) => e.len > 0)
  const completion = series.find((e) => e.status === 'success')
  const intervals: number[] = []
  for (let i = 1; i < contentCommits.length; i++) {
    intervals.push(contentCommits[i]!.t - contentCommits[i - 1]!.t)
  }
  return {
    firstContentMs: contentCommits.length > 0 ? contentCommits[0]!.t : NaN,
    completionMs: completion ? completion.t : NaN,
    commitIntervals: intervals
  }
}

/** Extract a message's DOM `.markdown` commit series (len>0 = content). */
function extractDomTiming(series: Array<{ t: number; len: number }>): {
  firstContentMs: number
  commitIntervals: number[]
} {
  const contentCommits = series.filter((e) => e.len > 0)
  const intervals: number[] = []
  for (let i = 1; i < contentCommits.length; i++) {
    intervals.push(contentCommits[i]!.t - contentCommits[i - 1]!.t)
  }
  return {
    firstContentMs: contentCommits.length > 0 ? contentCommits[0]!.t : NaN,
    commitIntervals: intervals
  }
}

/** Maximum number of simultaneously alive streams over the recorded timeline. */
function maxSimultaneousStreams(timings: Array<{ firstContentMs: number; completionMs: number }>): number {
  if (timings.length === 0) return 0
  const times = new Set<number>()
  for (const t of timings) {
    times.add(t.firstContentMs)
    times.add(t.completionMs)
  }
  let max = 0
  for (const t of times) {
    let alive = 0
    for (const st of timings) {
      if (st.firstContentMs <= t && t < st.completionMs) alive++
    }
    max = Math.max(max, alive)
  }
  return max
}

/** Accumulated sample metrics across the whole profile run. */
interface SampleAccumulator {
  reduxFirstContent: number[]
  reduxCommitIntervals: number[]
  domFirstContent: number[]
  domCommitIntervals: number[]
  visibleDomFirstContent: number[]
  visibleDomCommitIntervals: number[]
  inputLatencies: number[]
  longTasks: number[]
  frameDeltas: number[]
}

function emptyAccumulator(): SampleAccumulator {
  return {
    reduxFirstContent: [],
    reduxCommitIntervals: [],
    domFirstContent: [],
    domCommitIntervals: [],
    visibleDomFirstContent: [],
    visibleDomCommitIntervals: [],
    inputLatencies: [],
    longTasks: [],
    frameDeltas: []
  }
}

/**
 * Complete-load correctness gates for ONE sample, run AFTER the timing was
 * recorded (the timing endpoint is deliberately narrower — the first-content /
 * commit series). Throws on failure, which aborts the test and produces no
 * artifact. Returns the derived per-stream timings for the simultaneity gate
 * and metric accumulation.
 */
async function assertSampleCorrectness(
  page: Page,
  args: {
    profile: ScaleProfile
    sampleIndex: number
    topicId: string
    expectedModelIds: string[]
    expectedReplies: string[]
    result: InstrumentationResult
    fanoutRequests: Array<{ model: string; stream: boolean }>
  }
): Promise<{
  reduxTimings: StreamTiming[]
  visibleFirstContentMs: number
}> {
  const { profile, sampleIndex, topicId, expectedModelIds, expectedReplies, result, fanoutRequests } = args
  const n = profile.mentionModelCount

  // ---- Fanout: exactly N requests, one per mentioned model, all streaming ---
  expect(
    fanoutRequests.length,
    `sample ${sampleIndex}: the send must fan out exactly ${n} product chat-completion requests`
  ).toBe(n)
  expect(
    fanoutRequests.map((r) => r.model).sort(),
    `sample ${sampleIndex}: the fanout must hit exactly the ${n} mentioned models`
  ).toEqual([...expectedModelIds].sort())
  expect(
    fanoutRequests.every((r) => r.stream),
    `sample ${sampleIndex}: every fanout request must be a streaming request`
  ).toBe(true)

  // ---- Redux projection ------------------------------------------------
  const state = await readSampleState(page, topicId)
  expect(state.currentTopicId, `sample ${sampleIndex}: the sample topic must be the active topic`).toBe(topicId)
  expect(state.messages, `sample ${sampleIndex}: topic must hold exactly 1 + ${n} messages`).toHaveLength(1 + n)

  const userMessages = state.messages.filter((m) => m.role === 'user')
  const assistantMessages = state.messages.filter((m) => m.role === 'assistant')
  expect(userMessages, `sample ${sampleIndex}: exactly one user message`).toHaveLength(1)
  expect(assistantMessages, `sample ${sampleIndex}: exactly ${n} assistant messages`).toHaveLength(n)
  expect(
    userMessages[0]!.mentions,
    `sample ${sampleIndex}: the user message must carry exactly the ${n} mention model ids (production mention send)`
  ).toEqual(expectedModelIds)
  const userMessageId = userMessages[0]!.id
  expect(
    assistantMessages.every((m) => m.askId === userMessageId),
    `sample ${sampleIndex}: every assistant stream must share the user message askId (one fold group)`
  ).toBe(true)
  const assistantModelIds = assistantMessages.map((m) => m.modelId)
  expect(
    new Set(assistantModelIds).size,
    `sample ${sampleIndex}: the group must contain ${n} DISTINCT model-backed assistants`
  ).toBe(n)
  expect(assistantModelIds, `sample ${sampleIndex}: the group model ids must match the ${n} mentioned models`).toEqual(
    expectedModelIds
  )

  // Every stream's final content is exactly its deterministic reply (success).
  for (const assistant of assistantMessages) {
    const expectedReply = expectedReplies[expectedModelIds.indexOf(assistant.modelId!)]!
    expect(assistant.status, `sample ${sampleIndex}: stream ${assistant.modelId} must reach success`).toBe('success')
    expect(
      assistant.blocks,
      `sample ${sampleIndex}: stream ${assistant.modelId} must own exactly one block`
    ).toHaveLength(1)
    const block = state.blocks.find((b) => b.id === assistant.blocks[0])
    expect(block, `sample ${sampleIndex}: block of ${assistant.modelId} must be loaded`).toBeTruthy()
    expect(block!.status, `sample ${sampleIndex}: block of ${assistant.modelId} must be success`).toBe('success')
    expect(
      block!.content,
      `sample ${sampleIndex}: stream ${assistant.modelId} must complete with its exact deterministic reply`
    ).toBe(expectedReply)
    for (const other of expectedReplies) {
      if (other === expectedReply) continue
      expect(
        block!.content.includes(other),
        `sample ${sampleIndex}: stream ${assistant.modelId} must not contain another model's reply (no cross-stream contamination)`
      ).toBe(false)
    }
  }
  const userBlockCount = state.blocks.filter((b) => b.messageId === userMessageId).length
  expect(userBlockCount, `sample ${sampleIndex}: the user message must own a block`).toBeGreaterThanOrEqual(1)

  // ---- Visible (default-selected) stream DOM completed -----------------
  const visibleModelId = expectedModelIds[0]!
  const visibleAssistant = assistantMessages.find((m) => m.modelId === visibleModelId)
  expect(visibleAssistant, `sample ${sampleIndex}: the visible stream (first mentioned model) must exist`).toBeTruthy()
  // Bounded settle (audit F6): the final markdown flush can lag the completion
  // resolution by a render tick; the snapshot is re-read until the full
  // final-state contract holds or the short deadline expires (fail-closed).
  const visibleDom = await readVisibleDomSettled(page, visibleAssistant!.id)
  expect(visibleDom.found, `sample ${sampleIndex}: the visible stream wrapper must be rendered`).toBe(true)
  expect(visibleDom.selected, `sample ${sampleIndex}: the visible stream must carry the fold .selected class`).toBe(
    true
  )
  expect(
    visibleDom.display,
    `sample ${sampleIndex}: the visible stream wrapper must be displayed (not display:none)`
  ).not.toBe('none')
  expect(
    visibleDom.markdown,
    `sample ${sampleIndex}: the visible stream's rendered Markdown must complete (tail marker present)`
  ).toContain('tail-marker-END')

  // ---- Main SQLite parity ----------------------------------------------
  // Bounded settle (audit F2): Redux commits success BEFORE the final SQLite
  // write lands; fetchMessages is re-polled until the parity contract holds or
  // the short explicit deadline expires (fail-closed).
  const main = await readMainTopicSettled(page, topicId, n)
  expect(main.messageCount, `sample ${sampleIndex}: Main must hold exactly 1 + ${n} messages`).toBe(1 + n)
  expect(main.allOwned, `sample ${sampleIndex}: all Main rows must be topic-owned`).toBe(true)
  expect(main.roles.sort(), `sample ${sampleIndex}: Main roles must be [assistant × ${n}, user]`).toEqual(
    ['user', ...Array<string>(n).fill('assistant')].sort()
  )
  expect(
    main.statuses.every((s) => s === 'success'),
    `sample ${sampleIndex}: every Main message must be success`
  ).toBe(true)
  expect(
    main.assistantBlockCounts.every((c) => c === 1),
    `sample ${sampleIndex}: every Main assistant message must own exactly one block`
  ).toBe(true)
  expect(
    main.blockStatuses.every((s) => s === 'success'),
    `sample ${sampleIndex}: every Main block must be success`
  ).toBe(true)
  expect(main.blockOwnership, `sample ${sampleIndex}: every Main block must belong to a topic message`).toBe(true)

  // ---- Completion sanity (all samples recorded finite timing) ------------
  expect(result.completion.messageCount, `sample ${sampleIndex}: completion message count`).toBe(1 + n)
  expect(result.completion.assistantCount, `sample ${sampleIndex}: completion assistant count`).toBe(n)

  // ---- Per-stream timing derivation --------------------------------------
  const reduxTimings: StreamTiming[] = []
  for (const assistant of assistantMessages) {
    const blockSeries = result.redux.find((entry) => entry.messageId === assistant.id)
    expect(blockSeries, `sample ${sampleIndex}: Redux series must exist for stream ${assistant.id}`).toBeTruthy()
    const timing = extractReduxTiming(blockSeries!.series)
    expect(
      Number.isFinite(timing.firstContentMs),
      `sample ${sampleIndex}: stream ${assistant.modelId} must have a finite Redux first-content time`
    ).toBe(true)
    expect(
      Number.isFinite(timing.completionMs),
      `sample ${sampleIndex}: stream ${assistant.modelId} must have a finite Redux completion time`
    ).toBe(true)
    expect(
      timing.firstContentMs,
      `sample ${sampleIndex}: stream ${assistant.modelId} first content must precede its completion`
    ).toBeLessThan(timing.completionMs)
    reduxTimings.push(timing)
  }

  // ---- Simultaneous progression gate -------------------------------------
  const maxSimultaneous = maxSimultaneousStreams(reduxTimings)
  const requiredSimultaneous = Math.min(2, n)
  expect(
    maxSimultaneous,
    `sample ${sampleIndex}: at least ${requiredSimultaneous} stream(s) must progress simultaneously (max observed ${maxSimultaneous}; N=${n} gate adapted truthfully)`
  ).toBeGreaterThanOrEqual(requiredSimultaneous)

  // ---- Visible-stream DOM timing (from the recorded DOM series) -----------
  const visibleDomSeries = result.dom.find((entry) => entry.messageId === visibleAssistant!.id)
  expect(visibleDomSeries, `sample ${sampleIndex}: the visible stream must have a recorded DOM series`).toBeTruthy()
  const visibleDomTiming = extractDomTiming(visibleDomSeries!.series)
  expect(
    Number.isFinite(visibleDomTiming.firstContentMs),
    `sample ${sampleIndex}: the visible stream must have a finite DOM first-content time`
  ).toBe(true)

  // The Redux/DOM series timestamps are absolute `performance.now()` values on
  // the same clock as `result.tSend` — the send-relative duration is the delta.
  return { reduxTimings, visibleFirstContentMs: visibleDomTiming.firstContentMs - result.tSend }
}

// ---------------------------------------------------------------------------
// Main-process lifecycle tape (bounded, in-memory, failure diagnostics only)
// ---------------------------------------------------------------------------

/** Fixed maximum events retained by the lifecycle tape (bounded, drop-oldest). */
const LIFECYCLE_TAPE_MAX_EVENTS = 64

/** Fixed globalThis key shared between the install/read/dispose evaluate calls. */
const LIFECYCLE_TAPE_STATE_KEY = '__perf102LifecycleTapeV1__'

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
 * nothing (progress stays in [E2E][PERF-102] console lines).
 */
async function attachLifecycleDiagnostic(testInfo: TestInfo, electronApp: ElectronApplication): Promise<void> {
  const tape = await readLifecycleTape(electronApp)
  const diagnostic: LifecycleTapeDiagnostic = {
    spec: 'perf102-multimodel-stream-measurement',
    scope: 'main-process lifecycle tape (in-memory, bounded, non-sensitive)',
    outcome: tape.ok ? 'failure' : 'tape-read-failed',
    maxEvents: LIFECYCLE_TAPE_MAX_EVENTS,
    events: tape.ok ? tape.events : [],
    captureError: tape.ok ? undefined : LIFECYCLE_TAPE_READ_FAILED
  }
  await testInfo.attach('perf102-lifecycle-diagnostic', {
    body: JSON.stringify(diagnostic, null, 2),
    contentType: 'application/json'
  })
}

// ---------------------------------------------------------------------------
// Statistics + artifact construction (reuses the v1 contract helpers)
// ---------------------------------------------------------------------------

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

function buildBenchmarkResult(
  acc: SampleAccumulator,
  environment: BenchmarkResult['environment'],
  profile: ScaleProfile,
  totals: { reduxEvents: number; domEvents: number; inputProbes: number; longTasks: number; frames: number }
): BenchmarkResult {
  const n = profile.mentionModelCount
  const samples = profile.samplesPerProfile
  const correctness: BenchmarkGate[] = [
    {
      id: 'fanout.requestCount',
      name: 'each send fanned out to exactly N product chat-completion requests, one per mentioned model',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples produced exactly ${n} STREAMING product requests (mock request log, sequence-scoped, stream===true discriminator), one per mentioned model (N=${n})`
    },
    {
      id: 'fanout.userMessageMentions',
      name: 'the production user message carried exactly the N mention models',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: the persisted user message's mentions array equaled the ${n} mention model ids (real mention-tool selection + production sendMessage thunk)`
    },
    {
      id: 'fanout.simultaneousProgression',
      name: 'streams progressed simultaneously on the visible fold stream',
      kind: 'correctness',
      passed: true,
      detail: `max simultaneously alive streams >= min(2, N) in ${samples}/${samples} samples (computed from per-stream Redux first-content/completion series; N=${n} gate adapted truthfully for N=1)`
    },
    {
      id: 'content.exactCompletion',
      name: 'every stream completed with its exact deterministic content',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: all ${n} streams reached block status success with the exact per-model deterministic reply (${SCALE.streamParagraphs}-paragraph slow stream)`
    },
    {
      id: 'content.noCrossContamination',
      name: 'no cross-stream content contamination',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: no stream's final content contained another model's reply`
    },
    {
      id: 'group.singleGroupDistinctModels',
      name: 'one fold group with N distinct model-backed assistants',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: exactly 1 user + ${n} assistant messages, ${n} distinct model ids, every assistant sharing the user's askId (one fold group)`
    },
    {
      id: 'visible.domCompleted',
      name: 'the visible fold stream rendered its final content',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: the visible (default-selected) stream's rendered Markdown contained the final content marker (tail-marker-END)`
    },
    {
      id: 'visible.selected',
      name: 'exactly one visible/selected fold message',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: the visible stream wrapper carried the fold .selected class and was displayed (not display:none)`
    },
    {
      id: 'main.parity',
      name: 'Main SQLite authority preserved (1 + N messages, one block per assistant, all success)',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: fetchMessages returned exactly 1 + ${n} topic-owned messages, roles [user + assistant x${n}], all message/block status success, every assistant owning exactly one block`
    },
    {
      id: 'samples.completed',
      name: 'all samples completed with finite timing metrics',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples completed; per-stream Redux first-content, DOM first-content and commit intervals, input latency probes, long tasks and frame deltas recorded as finite values (zero-long-task runs keep metrics finite)`
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

  const longTaskCount = acc.longTasks.length
  const longTaskTotal = acc.longTasks.reduce((a, b) => a + b, 0)
  const longTaskMax = longTaskCount > 0 ? Math.max(...acc.longTasks) : 0
  const longTaskSorted = sortTimings(acc.longTasks)
  const longTaskP95 = longTaskCount > 0 ? percentile(longTaskSorted, 95) : 0

  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: profile.benchmarkId,
      name: profile.benchmarkName,
      scale: {
        profileCode: PROFILE_CODE[profile.kind],
        mentionModelCount: n,
        samplesPerProfile: profile.samplesPerProfile,
        probeCountPerSample: profile.probeCountPerSample,
        streamParagraphs: SCALE.streamParagraphs,
        streamChunkDelayMs: SCALE.streamChunkDelayMs,
        reduxEventTotal: totals.reduxEvents,
        domEventTotal: totals.domEvents,
        inputProbeTotal: totals.inputProbes,
        longTaskTotal: totals.longTasks,
        frameTotal: totals.frames
      }
    },
    environment,
    metrics: [
      ...statsMetrics(
        'stream.redux.firstContent',
        'Send -> per-stream Redux first block content commit (store.subscribe-sampled)',
        acc.reduxFirstContent
      ),
      ...statsMetrics(
        'stream.redux.commitInterval',
        'Per-stream Redux block content commit intervals (aggregate across streams)',
        acc.reduxCommitIntervals
      ),
      ...statsMetrics(
        'stream.dom.firstContent',
        'Send -> per-stream DOM .markdown first content commit (all streams, MutationObserver-sampled)',
        acc.domFirstContent
      ),
      ...statsMetrics(
        'stream.dom.commitInterval',
        'Per-stream DOM .markdown commit intervals (aggregate across all streams)',
        acc.domCommitIntervals
      ),
      ...statsMetrics(
        'visible.dom.firstContent',
        'Send -> visible fold stream DOM .markdown first content commit (the ONE visible stream)',
        acc.visibleDomFirstContent
      ),
      ...statsMetrics(
        'visible.dom.commitInterval',
        'Visible fold stream DOM .markdown commit intervals (the ONE visible stream)',
        acc.visibleDomCommitIntervals
      ),
      ...statsMetrics(
        'input.latency',
        'Renderer input latency during overlap (real textarea 3-line probe -> React commit visible as autoSize row growth crossing the minRows=2 baseline)',
        acc.inputLatencies
      ),
      countMetric(
        'input.latency.count',
        'Renderer input latency probe count (during overlap)',
        acc.inputLatencies.length
      ),
      countMetric('longtask.count', 'Aggregate long task count', longTaskCount),
      { id: 'longtask.totalMs', name: 'Aggregate long task total', value: longTaskTotal, unit: 'ms' },
      { id: 'longtask.maxMs', name: 'Aggregate long task max', value: longTaskMax, unit: 'ms' },
      { id: 'longtask.p95Ms', name: 'Aggregate long task p95', value: longTaskP95, unit: 'ms' },
      ...statsMetrics(
        'frame.delta',
        'Renderer rAF frame-delta cadence during the measured send',
        acc.frameDeltas
      ).filter((m) => !m.id.endsWith('.min')),
      countMetric('frame.count', 'Renderer rAF frame count during the measured send', acc.frameDeltas.length)
    ],
    gates: correctness
  }
}

// ---------------------------------------------------------------------------
// The measurement test — one focused run, one artifact
// ---------------------------------------------------------------------------

test.describe('PERF-102 concurrent multi-model stream measurement', () => {
  test('measures N concurrent model streams against the one visible fold stream and renderer responsiveness', async ({
    electronApp,
    mainWindow
  }, testInfo) => {
    // Resolve the measurement profile BEFORE anything runs: unset/empty keeps
    // the default n1 profile; an unsupported PERF102_SCALE value fails clearly
    // here, before measurement.
    const profile = resolveScaleProfile()

    // Bounded-run budget aligned with the actual per-wait bounds below
    // (watchdogs: 15s panel/topic, 5s probe, 120s completion) — a hang fails
    // with a targeted diagnostic instead of riding out an inflated timeout.
    test.setTimeout(profile.testTimeoutMs)
    const page = mainWindow

    try {
      // Main-process lifecycle tape BEFORE phase execution: bounded, in-memory,
      // failure diagnostics only (never enters the schema-v1 artifact).
      await installLifecycleTape(electronApp)

      const assistantId = await page.evaluate(() => (window as any).store.getState().assistants?.assistants?.[0]?.id)
      expect(assistantId, 'the fixture must provide a default assistant').toBeTruthy()

      const expectedModelIds = mentionModelIds(profile.mentionModelCount)
      const expectedReplies = expectedModelIds.map(expectedReplyFor)

      const acc = emptyAccumulator()
      let totals = { reduxEvents: 0, domEvents: 0, inputProbes: 0, longTasks: 0, frames: 0 }

      // Register the N distinct mock-backed models in test state once (the
      // mention panel reads the Redux provider model list live).
      await test.step('Phase 0: register the profile mention models', async () => {
        await registerMentionModels(page, profile)
        console.log(
          `[E2E][PERF-102] registered ${profile.mentionModelCount} mention models (${expectedModelIds.join(', ')}; profile ${profile.kind})`
        )
      })

      // ---- Phase 1: measured samples (fresh topic + mention UI + real send) --
      await test.step('Phase 1: measured concurrent multi-model sends', async () => {
        for (let s = 0; s < profile.samplesPerProfile; s++) {
          const topicId = `p102-sample-${s}`
          await createAndActivateTopic(page, topicId, `P102 Sample ${s}`, assistantId)
          await selectMentionModels(page, profile)

          const seqBefore = getRequestSequence()
          const result = await measureMultiModelSend(page, {
            topicId,
            messageText: SEND_MESSAGE_TEXT,
            mentionModelCount: profile.mentionModelCount,
            probeCount: profile.probeCountPerSample,
            completionTimeoutMs: 120000,
            probeWatchdogMs: 5000
          })

          const fanoutRequests = sampleFanoutRequests(seqBefore)
          const { reduxTimings, visibleFirstContentMs } = await assertSampleCorrectness(page, {
            profile,
            sampleIndex: s,
            topicId,
            expectedModelIds,
            expectedReplies,
            result,
            fanoutRequests
          })

          // Accumulate metrics (per-stream + visible-stream + aggregates).
          // First-content series are absolute `performance.now()` timestamps on
          // the same clock as result.tSend — the send-relative duration is the
          // delta (commit intervals are already deltas).
          for (const timing of reduxTimings) {
            acc.reduxFirstContent.push(timing.firstContentMs - result.tSend)
            acc.reduxCommitIntervals.push(...timing.commitIntervals)
          }
          const stateForDom = await readSampleState(page, topicId)
          const assistantIds = stateForDom.messages.filter((m) => m.role === 'assistant').map((m) => m.id)
          for (const domEntry of result.dom) {
            if (!assistantIds.includes(domEntry.messageId)) continue
            const timing = extractDomTiming(domEntry.series)
            if (!Number.isFinite(timing.firstContentMs)) continue
            acc.domFirstContent.push(timing.firstContentMs - result.tSend)
            acc.domCommitIntervals.push(...timing.commitIntervals)
            if (domEntry.messageId === stateForDom.messages.find((m) => m.modelId === expectedModelIds[0])?.id) {
              acc.visibleDomFirstContent.push(visibleFirstContentMs)
              acc.visibleDomCommitIntervals.push(...timing.commitIntervals)
            }
          }
          acc.inputLatencies.push(...result.inputProbes.map((p) => p.latencyMs))
          acc.longTasks.push(...result.longTasks)
          acc.frameDeltas.push(...result.frameDeltas)
          totals = {
            reduxEvents: totals.reduxEvents + result.redux.reduce((a, b) => a + b.series.length, 0),
            domEvents: totals.domEvents + result.dom.reduce((a, b) => a + b.series.length, 0),
            inputProbes: totals.inputProbes + result.inputProbes.length,
            longTasks: totals.longTasks + result.longTasks.length,
            frames: totals.frames + result.frameDeltas.length
          }

          console.log(
            `[E2E][PERF-102] sample ${s}: N=${profile.mentionModelCount}, ` +
              `${result.redux.reduce((a, b) => a + b.series.length, 0)} redux commits, ` +
              `${result.dom.reduce((a, b) => a + b.series.length, 0)} dom commits, ` +
              `${result.inputProbes.length} input probes, ${result.longTasks.length} long tasks, ` +
              `${result.frameDeltas.length} frames`
          )
        }
      })

      // ---- Phase 2: emit the schema v1 artifact ONLY after the full pass -----
      await test.step('Phase 2: emit schema v1 artifact', async () => {
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
        const result = buildBenchmarkResult(acc, environment, profile, totals)
        const artifactPath = writeBenchmarkResult(result)
        expect(fs.existsSync(artifactPath), 'artifact must exist after a passing run').toBe(true)
        // Only a safe basename is printed — absolute machine-local artifact
        // paths never enter logs (privacy/redaction).
        console.log(
          `[E2E][PERF-102] schema v1 artifact: ${path.basename(artifactPath)} ` +
            `(profile ${profile.kind}, N=${profile.mentionModelCount})`
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
        console.log(`[E2E][PERF-102] lifecycle diagnostic attach failed: ${String(attachError)}`)
      }
      throw error
    } finally {
      // Deterministic listener cleanup — also covers a tape read that failed
      // after a full process death (the dispose evaluate is swallowed).
      await disposeLifecycleTape(electronApp)
    }
  })
})
