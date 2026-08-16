/**
 * PERF-STREAM-ATTR-002 — steady renderer amplification attribution
 * (production-build Playwright E2E).
 *
 * Purpose (docs/performance-workstreams.md §2.2 PERF-STREAMING; slice
 * PERF-STREAM-ATTR-002, LOCK-STREAM-RENDER-001..006): measure, end to end
 * against a FRESH production build + the standard shared E2E fixture, the
 * steady RENDERER amplification caused by N concurrent multi-model streams on
 * the ONE visible fold stream. It reuses the legacy PERF-102 page-context
 * observer patterns and its product path (real mention-model send, deterministic
 * slow stream) WITHOUT modifying PERF-102's artifact ids, existing claims, or
 * behavior, and WITHOUT adding any production instrumentation (LOCK-STREAM-
 * RENDER-001/004).
 *
 * Scope (LOCK-STREAM-RENDER-002/006): N=1/2/3 STEADY renderer amplification
 * only — per-assistant Redux block-content commit series, per-assistant DOM
 * `.markdown` parsed-content commit series, the scheduling-inclusive
 * Redux→next-DOM commit interval (labeled an AGGREGATE render/commit interval,
 * NEVER "Markdown parse CPU"), the accumulated content-size axis, long tasks,
 * frame deltas, and input-latency probes. Completion batch-tail attribution and
 * all DB/Main/IPC optimization are explicitly out of scope.
 *
 * Profiles (PERF_STREAM_RENDER_SCALE; default-OFF). Exactly three explicit
 * profiles — the spec is SKIPPED by default so a plain `pnpm test:e2e` stays
 * green (LOCK-STREAM-RENDER-005):
 *   - n1 -> chatdb-stream-render-e2e-n1 (N=1)
 *   - n2 -> chatdb-stream-render-e2e-n2 (N=2)
 *   - n3 -> chatdb-stream-render-e2e-n3 (N=3)
 * The profile is selected ONLY by the env; artifact family
 * `chatdb-stream-render-e2e-*`, schema v1 unchanged.
 *
 * Canonical run (fresh production build first; no PERF_STREAM_ATTR required):
 *   pnpm build
 *   PERF_STREAM_RENDER_SCALE=n1 pnpm test:e2e -- tests/e2e/specs/conversation/perf-stream-render-attr.spec.ts
 *   PERF_STREAM_RENDER_SCALE=n2 pnpm test:e2e -- tests/e2e/specs/conversation/perf-stream-render-attr.spec.ts
 *   PERF_STREAM_RENDER_SCALE=n3 pnpm test:e2e -- tests/e2e/specs/conversation/perf-stream-render-attr.spec.ts
 *
 * Workload: the user message carries the existing `__E2E_SLOW_STREAM__` opt-in
 * marker, so every request streams the fixed deterministic 150-paragraph /
 * 60ms-per-paragraph reply (`getSlowStreamReply(model)`). No mock edit.
 *
 * Measurement model (one sample = one measured send, one fresh empty topic):
 *   - t0 (tSend) is captured in the SAME page task as the synthetic Enter
 *     keydown that triggers the production Inputbar send handler.
 *   - Per-assistant Redux series: a store.subscribe listener records, per
 *     assistant main_text block, every content-length/status change with a page
 *     timestamp (deduped by (len,status); sample-scoped to the sample topic).
 *   - Per-assistant DOM series: a MutationObserver on `#messages` sets a dirty
 *     flag; a rAF frame loop scans `.markdown` textContent length once per frame
 *     (deduped by length) for every sample-owned `[data-message-id]` — including
 *     hidden non-selected fold wrappers (hidden streams still render full
 *     Markdown trees).
 *   - Scheduling-inclusive Redux→next-DOM interval (LOCK-STREAM-RENDER-006):
 *     for each STEADY Redux commit, the EARLIEST DOM `.markdown` commit at-or-
 *     after it (next-DOM / monotonic pairing). Smooth-stream rendering makes
 *     pairing non-1:1 — multiple Redux commits may pair to one DOM commit; this
 *     is expected and never asserted away. The interval is an AGGREGATE
 *     render/commit interval (Redux dispatch + React scheduling + Markdown parse
 *     + DOM commit), never a Markdown-parse-CPU measure.
 *   - Steady-state cutoff (LOCK-STREAM-RENDER-002/006): each assistant's steady
 *     window is [first content, first content commit whose length equals the
 *     exact final reply length) — the completion-tail (all-success/final flush)
 *     is EXCLUDED from steady interval metrics. The content-SIZE axis counts
 *     every commit (tail included): accumulated-bytes is the renderer
 *     amplification on the content-size axis regardless of steady/tail.
 *   - Renderer input latency during overlap: bounded deterministic probes write
 *     a fixed 3-line value into the REAL textarea and measure input event →
 *     React commit (autoSize row growth crossing the minRows=2 baseline), run
 *     while >= min(2,N) streams have observed content.
 *   - Aggregate frame cadence: a rAF loop records consecutive frame deltas,
 *     RESET at tSend so the series covers the measured send-to-completion
 *     window only.
 *   - Aggregate long tasks: a PerformanceObserver('longtask') records each
 *     entry's startTime + duration (count/total/max/p95; zero when none occur)
 *     and buckets each by startTime into setup/steady/completion phases. Long
 *     task DURATION overlaps stage intervals and is NEVER summed into them
 *     (non-additivity, LOCK-STREAM-RENDER-006).
 *
 * Correctness gates run BEFORE artifact acceptance/emission (a failure aborts
 * and produces NO artifact; audit F1-style). All gates are L1 correctness /
 * completeness — NO numeric threshold (LOCK-STREAM-RENDER-003). See the test
 * body for the full gate list: fanout.requestCount, fanout.userMessageMentions,
 * group.singleGroupDistinctModels, content.exactCompletion,
 * content.noCrossContamination, visible.domCompleted, main.parity,
 * content.sizeReached, pairing.monotonic, pairing.covered,
 * pairing.steadyExcluded, samples.completed, environment.abi145,
 * privacy.schemaV1.
 *
 * Evidence classification: deterministic L1 regression evidence on a fresh
 * build + standard fixture; all numeric metrics are L3 non-threshold (dirty-
 * state artifacts are non-baseline L3, docs/performance-measurement.md §7).
 */
import type { Page } from '@playwright/test'
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
import {
  PROFILE_CODE,
  deriveAssistantSample,
  renderScaleGateEnabled,
  resolveRenderScaleProfile,
  type DerivedAssistant,
  type RenderReduxPoint,
  type RenderScaleProfile,
  type RenderSeriesPoint
} from '../../utils/perfStreamRenderAttr'

// ---------------------------------------------------------------------------
// Fixed deterministic scale (recorded verbatim in the artifact's scale map)
// ---------------------------------------------------------------------------

const SCALE = {
  samplesPerProfile: 3,
  probeCountPerSample: 6,
  streamParagraphs: 150,
  streamChunkDelayMs: 60
} as const

/** Bounded settle deadlines for post-send correctness reads (never timing metrics). */
const SETTLE = {
  mainParityMs: 5000,
  visibleDomMs: 5000,
  pollMs: 200
} as const

/** Deterministic user message text; the marker makes every request a slow stream. */
const SEND_MESSAGE_TEXT = `attr002 stream render probe ${SLOW_STREAM_MARKER}`

/** Canonical safe command recorded in the artifact (no path segments). */
const CANONICAL_COMMAND = 'pnpm test:e2e'

/** The provider hosting the fixture's default model + the registered mention models. */
const MOCK_PROVIDER_ID = 'mock-openai'

/** Deterministic mention model ids for a profile: `mock-model-0..N-1`. */
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

/** Register N distinct mock-backed models into the mock provider's Redux list. */
async function registerMentionModels(page: Page, profile: RenderScaleProfile): Promise<void> {
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

/** Create a fresh deterministic EMPTY topic in Redux + SQLite and activate it. */
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

/** Deterministically clear any PREVIOUSLY mentioned models (cross-sample isolation). */
async function clearMentionedModels(page: Page, profile: RenderScaleProfile): Promise<void> {
  const inputbar = page.locator('#inputbar')
  await inputbar.waitFor({ state: 'visible', timeout: 15000 })
  const names = mentionModelNames(profile.mentionModelCount)
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

/** Drive the REAL mention-tool UI to select exactly the profile's models. */
async function selectMentionModels(page: Page, profile: RenderScaleProfile): Promise<void> {
  await clearMentionedModels(page, profile)
  const names = mentionModelNames(profile.mentionModelCount)
  const mentionButton = page.locator('.inputbar').getByRole('button', { name: 'Select Model' }).first()
  await mentionButton.waitFor({ state: 'visible', timeout: 15000 })
  await mentionButton.click()
  const panel = page.locator('[data-testid="quick-panel"]')
  await panel.waitFor({ state: 'visible', timeout: 15000 })
  await expect(panel.locator('[data-id].selected')).toHaveCount(0, { timeout: 5000 })
  for (const name of names) {
    const item = panel.locator('[data-id]').filter({ hasText: name }).first()
    await item.click()
    await expect(page.locator('#inputbar')).toContainText(name, { timeout: 5000 })
  }
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible({ timeout: 5000 })
}

// ---------------------------------------------------------------------------
// Post-send state readers (correctness gates)
// ---------------------------------------------------------------------------

/** Read the sample topic's full Redux projection. */
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

/** Bounded settle for the Main SQLite parity read. */
async function readMainTopicSettled(page: Page, topicId: string, n: number): Promise<MainParitySnapshot> {
  const deadline = Date.now() + SETTLE.mainParityMs
  let snapshot = await readMainTopic(page, topicId)
  while (!mainParityReady(snapshot, n) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE.pollMs))
    snapshot = await readMainTopic(page, topicId)
  }
  return snapshot
}

/** Rendered DOM snapshot of one message wrapper. */
interface VisibleDomSnapshot {
  found: boolean
  display: string
  markdown: string
}

/** Read a message's DOM `.markdown` state. */
async function readVisibleDom(page: Page, messageId: string): Promise<VisibleDomSnapshot> {
  return page.evaluate((messageId) => {
    const el = document.getElementById(`message-${messageId}`)
    if (!el) return { found: false, display: 'none', markdown: '' }
    const md = el.querySelector('.markdown')
    return { found: true, display: window.getComputedStyle(el).display, markdown: md ? (md.textContent ?? '') : '' }
  }, messageId)
}

/** True when the visible stream's DOM already satisfies the final-state contract. */
function visibleDomReady(snapshot: VisibleDomSnapshot): boolean {
  return snapshot.found && snapshot.display !== 'none' && snapshot.markdown.includes('tail-marker-END')
}

/** Bounded settle for the visible-stream DOM read. */
async function readVisibleDomSettled(page: Page, messageId: string): Promise<VisibleDomSnapshot> {
  const deadline = Date.now() + SETTLE.visibleDomMs
  let snapshot = await readVisibleDom(page, messageId)
  while (!visibleDomReady(snapshot) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE.pollMs))
    snapshot = await readVisibleDom(page, messageId)
  }
  return snapshot
}

/** Fanout proof from the mock request log (sequence-scoped STREAMING requests). */
function sampleFanoutRequests(afterSequence: number): Array<{ model: string; stream: boolean }> {
  return getRequestLog()
    .filter(
      (entry) =>
        entry.sequence >= afterSequence &&
        entry.method === 'POST' &&
        (entry.url === '/v1/chat/completions' || entry.url === '/chat/completions') &&
        entry.parsed?.stream === true
    )
    .map((entry) => ({ model: String(entry.parsed?.model ?? ''), stream: entry.parsed?.stream === true }))
}

// ---------------------------------------------------------------------------
// Timed measurement — page-context instrumentation + measured send
// ---------------------------------------------------------------------------

/** Bounded record returned by the instrumentation evaluate. */
interface RenderInstrumentationResult {
  /** Page-clock send anchor: `performance.now()` in the same task as the synthetic Enter keydown. */
  tSend: number
  /** Per-assistant Redux block-content series (deduped by (len,status)). */
  redux: Array<{ messageId: string; series: RenderReduxPoint[] }>
  /** Per-assistant DOM `.markdown` content series (deduped by length). */
  dom: Array<{ messageId: string; series: RenderSeriesPoint[] }>
  inputProbes: Array<{ latencyMs: number }>
  longTasks: Array<{ startTime: number; duration: number }>
  frameDeltas: number[]
  completion: { messageCount: number; assistantCount: number }
}

/**
 * Measure ONE concurrent multi-model send end-to-end. Installs all page-context
 * instrumentation (store.subscribe Redux series + assistant adoption, DOM
 * MutationObserver + frame-drained scan, PerformanceObserver longtask, rAF
 * frame deltas, input-latency probes), sets the message text through the native
 * setter + input event, dispatches a synthetic Enter keydown in the same task
 * as tSend, waits for every assistant stream to reach success, then detaches
 * all instrumentation and returns the bounded record.
 */
function measureRenderSample(
  page: Page,
  args: {
    topicId: string
    messageText: string
    mentionModelCount: number
    probeCount: number
    completionTimeoutMs: number
    probeWatchdogMs: number
  }
): Promise<RenderInstrumentationResult> {
  return page.evaluate(
    async ({ topicId, messageText, mentionModelCount, probeCount, completionTimeoutMs, probeWatchdogMs }) => {
      const store = (window as any).store
      const textarea = document.querySelector('.inputbar textarea') as HTMLTextAreaElement | null
      if (!textarea) throw new Error('measure: inputbar textarea not found')
      const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSet) throw new Error('measure: textarea native value setter unavailable')

      // ---- Sample-owned message-ID set (instrumentation scoping) ------------
      const sampleMessageIds = new Set<string>()
      const adoptSampleMessageIds = (): void => {
        const s = store.getState()
        const ids: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
        for (const id of ids) sampleMessageIds.add(String(id))
      }

      // ---- Per-assistant Redux block-content series (deduped) --------------
      const reduxByAssistant = new Map<
        string,
        { lastLen: number; lastStatus: string; series: Array<{ t: number; len: number; status: string }> }
      >()
      const recordRedux = (messageId: string, len: number, status: string): void => {
        const prev = reduxByAssistant.get(messageId)
        if (prev && prev.lastLen === len && prev.lastStatus === status) return
        const t = performance.now()
        if (prev) {
          prev.lastLen = len
          prev.lastStatus = status
        } else {
          reduxByAssistant.set(messageId, { lastLen: len, lastStatus: status, series: [] })
        }
        reduxByAssistant.get(messageId)!.series.push({ t, len, status })
      }
      const handleStoreUpdate = (): void => {
        adoptSampleMessageIds()
        const s = store.getState()
        const blocks = s?.messageBlocks?.entities ?? {}
        const ids: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
        for (const id of ids) {
          const key = String(id)
          if (!sampleMessageIds.has(key)) continue
          const msg = s.messages?.entities?.[key]
          if (!msg || String(msg.role ?? '') !== 'assistant') continue
          const blockId = (msg.blocks ?? []).find((bid: string) => blocks[bid]?.type === 'main_text')
          const b = blockId ? blocks[blockId] : null
          if (!b) continue
          const len = typeof b.content === 'string' ? b.content.length : 0
          recordRedux(key, len, String(b.status ?? ''))
        }
      }
      const unsubscribe = store.subscribe(handleStoreUpdate)
      handleStoreUpdate()

      // ---- Per-assistant DOM `.markdown` series (frame-drained, deduped) ----
      const domByMessage = new Map<string, { lastLen: number; series: Array<{ t: number; len: number }> }>()
      let domDirty = true
      const scanDom = (): void => {
        const t = performance.now()
        for (const el of document.querySelectorAll('#messages [data-message-id]')) {
          const messageId = el.getAttribute('data-message-id')
          if (!messageId) continue
          if (!sampleMessageIds.has(messageId)) continue
          const md = el.querySelector('.markdown')
          const len = md ? (md.textContent ?? '').length : 0
          const prev = domByMessage.get(messageId)
          if (prev && prev.lastLen === len) continue
          if (prev) {
            prev.lastLen = len
          } else {
            domByMessage.set(messageId, { lastLen: len, series: [] })
          }
          domByMessage.get(messageId)!.series.push({ t, len })
        }
      }
      const messagesEl = document.getElementById('messages')
      const observer = new MutationObserver(() => {
        domDirty = true
      })
      if (messagesEl) observer.observe(messagesEl, { subtree: true, childList: true, characterData: true })
      scanDom()

      // ---- Long tasks (finite even when none occur) -------------------------
      const longTasks: Array<{ startTime: number; duration: number }> = []
      let perfObserver: PerformanceObserver | null = null
      try {
        perfObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({ startTime: entry.startTime, duration: entry.duration })
          }
        })
        perfObserver.observe({ entryTypes: ['longtask'] })
      } catch {
        perfObserver = null
      }

      // ---- rAF frame-delta cadence + DOM drain ------------------------------
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

      // ---- rAF-polled wait (bounded watchdog) -------------------------------
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
        nativeSet.call(textarea, '')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
        await waitFor(() => textarea.offsetHeight > 0, probeWatchdogMs, 'input probe baseline')
        for (let i = 0; i < probeCount; i++) {
          const baselineHeight = textarea.offsetHeight
          const t0 = performance.now()
          nativeSet.call(textarea, `\n\nprobe-${i}-line`)
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
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
      // the measured send-to-completion window ONLY (pre-send setup frames never
      // leak into `frame.delta`).
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
              `render send completion timeout: assistantCount=${topicAssistantIds().length}, expected=${mentionModelCount}`
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

      return {
        tSend,
        redux: Array.from(reduxByAssistant.entries()).map(([messageId, { series }]) => ({ messageId, series })),
        dom: Array.from(domByMessage.entries()).map(([messageId, { series }]) => ({ messageId, series })),
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
// Statistics + artifact construction (reuses the schema-v1 contract helpers)
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

/** One long-task phase bucket (setup/steady/completion): count/total/max/p95. */
function longTaskPhaseMetrics(
  phase: 'setup' | 'steady' | 'completion',
  label: string,
  durations: number[]
): BenchmarkMetric[] {
  const count = durations.length
  const total = durations.reduce((a, b) => a + b, 0)
  const max = count > 0 ? Math.max(...durations) : 0
  const sorted = sortTimings(durations)
  const p95 = count > 0 ? percentile(sorted, 95) : 0
  return [
    countMetric(`longtask.${phase}.count`, `${label} long task count`, count),
    { id: `longtask.${phase}.totalMs`, name: `${label} long task total`, value: total, unit: 'ms' },
    { id: `longtask.${phase}.maxMs`, name: `${label} long task max`, value: max, unit: 'ms' },
    { id: `longtask.${phase}.p95Ms`, name: `${label} long task p95`, value: p95, unit: 'ms' }
  ]
}

/** Accumulated per-sample metrics across the whole profile run. */
interface Accumulator {
  reduxFirstContent: number[]
  reduxCommitIntervals: number[]
  domFirstContent: number[]
  domCommitIntervals: number[]
  reduxToDomIntervals: number[]
  accumulatedBytes: number[]
  steadyAccumulatedBytes: number[]
  finalLengths: number[]
  inputLatencies: number[]
  frameDeltas: number[]
  longTasks: number[]
  longTaskSetup: number[]
  longTaskSteady: number[]
  longTaskCompletion: number[]
}

function emptyAccumulator(): Accumulator {
  return {
    reduxFirstContent: [],
    reduxCommitIntervals: [],
    domFirstContent: [],
    domCommitIntervals: [],
    reduxToDomIntervals: [],
    accumulatedBytes: [],
    steadyAccumulatedBytes: [],
    finalLengths: [],
    inputLatencies: [],
    frameDeltas: [],
    longTasks: [],
    longTaskSetup: [],
    longTaskSteady: [],
    longTaskCompletion: []
  }
}

/**
 * Long tasks bucketed deterministically by startTime into setup/steady/
 * completion on the single page clock (half-open: a task whose startTime equals
 * a boundary belongs to the phase that STARTS at that boundary). The completion
 * boundary is the FIRST assistant stream's Redux success commit; the observation
 * end is AFTER all N streams succeed, so the completion bucket is post-first-
 * completion pressure, not post-all-stream processing.
 */
function bucketLongTasksByPhase(
  longTasks: Array<{ startTime: number; duration: number }>,
  tSend: number,
  firstCompletionMs: number
): { setup: number[]; steady: number[]; completion: number[] } {
  const setup: number[] = []
  const steady: number[] = []
  const completion: number[] = []
  for (const task of longTasks) {
    if (task.startTime < tSend) setup.push(task.duration)
    else if (task.startTime < firstCompletionMs) steady.push(task.duration)
    else completion.push(task.duration)
  }
  return { setup, steady, completion }
}

/**
 * Complete-load correctness gates for ONE sample, run AFTER the timing was
 * recorded (gates → artifact ordering; a failure aborts and produces no
 * artifact). Returns the per-assistant derived metrics for accumulation.
 */
async function assertSampleCorrectness(
  page: Page,
  args: {
    profile: RenderScaleProfile
    sampleIndex: number
    topicId: string
    expectedModelIds: string[]
    expectedReplies: string[]
    result: RenderInstrumentationResult
    fanoutRequests: Array<{ model: string; stream: boolean }>
  }
): Promise<DerivedAssistant[]> {
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

  // ---- Redux projection ----------------------------------------------------
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
  expect(new Set(assistantModelIds).size, `sample ${sampleIndex}: the group must hold ${n} DISTINCT models`).toBe(n)
  expect(assistantModelIds, `sample ${sampleIndex}: the group model ids must match the ${n} mentioned models`).toEqual(
    expectedModelIds
  )

  // ---- Exact reply / no cross-contamination --------------------------------
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

  // ---- Visible fold stream DOM completed (bounded settle) -------------------
  const visibleModelId = expectedModelIds[0]!
  const visibleAssistant = assistantMessages.find((m) => m.modelId === visibleModelId)
  expect(visibleAssistant, `sample ${sampleIndex}: the visible stream must exist`).toBeTruthy()
  const visibleDom = await readVisibleDomSettled(page, visibleAssistant!.id)
  expect(visibleDom.found, `sample ${sampleIndex}: the visible stream wrapper must be rendered`).toBe(true)
  expect(
    visibleDom.display,
    `sample ${sampleIndex}: the visible stream wrapper must be displayed (not display:none)`
  ).not.toBe('none')
  expect(
    visibleDom.markdown,
    `sample ${sampleIndex}: the visible stream's rendered Markdown must complete (tail marker present)`
  ).toContain('tail-marker-END')

  // ---- Main SQLite parity (bounded settle) ---------------------------------
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

  // ---- Completion sanity ----------------------------------------------------
  expect(result.completion.messageCount, `sample ${sampleIndex}: completion message count`).toBe(1 + n)
  expect(result.completion.assistantCount, `sample ${sampleIndex}: completion assistant count`).toBe(n)

  // ---- Per-assistant derivation + pairing gates ----------------------------
  const derived: DerivedAssistant[] = []
  for (const assistant of assistantMessages) {
    const expectedReply = expectedReplies[expectedModelIds.indexOf(assistant.modelId!)]!
    const finalLength = expectedReply.length
    const reduxSeries = result.redux.find((entry) => entry.messageId === assistant.id)
    const domSeries = result.dom.find((entry) => entry.messageId === assistant.id)
    expect(reduxSeries, `sample ${sampleIndex}: Redux series must exist for assistant ${assistant.id}`).toBeTruthy()
    expect(domSeries, `sample ${sampleIndex}: DOM series must exist for assistant ${assistant.id}`).toBeTruthy()
    const d = deriveAssistantSample(assistant.id, reduxSeries!.series, domSeries!.series, finalLength, result.tSend)
    expect(
      Number.isFinite(d.reduxFirstContentMs) && d.reduxFirstContentMs >= 0,
      `sample ${sampleIndex}: assistant ${assistant.modelId} must have a finite Redux first-content time`
    ).toBe(true)
    expect(
      Number.isFinite(d.reduxCompletionMs) && d.reduxCompletionMs >= 0,
      `sample ${sampleIndex}: assistant ${assistant.modelId} must have a finite Redux completion time`
    ).toBe(true)
    expect(
      Number.isFinite(d.domFirstContentMs) && d.domFirstContentMs >= 0,
      `sample ${sampleIndex}: assistant ${assistant.modelId} must have a finite DOM first-content time`
    ).toBe(true)
    // content.sizeReached: the Redux series must reach the exact final reply length.
    expect(
      d.reduxSizeReached,
      `sample ${sampleIndex}: assistant ${assistant.modelId} Redux series must reach the exact final reply length (${finalLength})`
    ).toBe(true)
    // pairing.steadyExcluded: the completion-tail flush was excluded from steady metrics.
    expect(
      d.steadyTailExcluded,
      `sample ${sampleIndex}: assistant ${assistant.modelId} must have excluded its completion-tail from steady metrics`
    ).toBe(true)
    // pairing.monotonic + pairing.covered: next-DOM pairing indices monotonic, every steady Redux commit covered.
    expect(
      d.pairingMonotonic,
      `sample ${sampleIndex}: assistant ${assistant.modelId} next-DOM pairing must be monotonic (non-decreasing DOM indices)`
    ).toBe(true)
    expect(
      d.pairingCovered,
      `sample ${sampleIndex}: assistant ${assistant.modelId} every steady Redux commit must have a next DOM commit at-or-after it`
    ).toBe(true)
    // The scheduling-inclusive interval is an AGGREGATE render/commit interval,
    // never a Markdown-parse-CPU measure; it can legitimately be 0 when a DOM
    // commit is frame-coincident with its Redux commit, so only non-negative is
    // asserted (no threshold).
    expect(
      d.reduxToDomIntervalsMs.every((v) => v >= 0),
      `sample ${sampleIndex}: assistant ${assistant.modelId} Redux→next-DOM intervals must be non-negative`
    ).toBe(true)
    derived.push(d)
  }

  return derived
}

/** Build the schema-v1 artifact for a profile. All metrics are L3 non-threshold. */
function buildBenchmarkResult(
  acc: Accumulator,
  environment: BenchmarkResult['environment'],
  profile: RenderScaleProfile,
  totals: { reduxEvents: number; domEvents: number; inputProbes: number; longTasks: number; frames: number }
): BenchmarkResult {
  const n = profile.mentionModelCount
  const samples = profile.samplesPerProfile
  const longTaskCount = acc.longTasks.length
  const longTaskTotal = acc.longTasks.reduce((a, b) => a + b, 0)
  const longTaskMax = longTaskCount > 0 ? Math.max(...acc.longTasks) : 0
  const longTaskSorted = sortTimings(acc.longTasks)
  const longTaskP95 = longTaskCount > 0 ? percentile(longTaskSorted, 95) : 0
  const totalFinalLength = acc.finalLengths.reduce((a, b) => a + b, 0)
  const totalAccumulated = acc.accumulatedBytes.reduce((a, b) => a + b, 0)
  const totalSteadyAccumulated = acc.steadyAccumulatedBytes.reduce((a, b) => a + b, 0)
  // Renderer amplification on the content-size axis: total committed content
  // bytes relative to the total final content bytes across all assistants.
  const amplificationRatio = totalFinalLength > 0 ? totalAccumulated / totalFinalLength : 0
  const steadyAmplificationRatio = totalFinalLength > 0 ? totalSteadyAccumulated / totalFinalLength : 0

  const correctness: BenchmarkGate[] = [
    {
      id: 'fanout.requestCount',
      name: 'each send fanned out to exactly N product chat-completion requests, one per mentioned model',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples produced exactly ${n} STREAMING product requests (mock request log, sequence-scoped, stream===true), one per mentioned model (N=${n})`
    },
    {
      id: 'fanout.userMessageMentions',
      name: 'the production user message carried exactly the N mention models',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: the user message's mentions equaled the ${n} mention model ids (real mention-tool selection + production sendMessage thunk)`
    },
    {
      id: 'group.singleGroupDistinctModels',
      name: 'one fold group with N distinct model-backed assistants',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: exactly 1 user + ${n} assistant messages, ${n} distinct model ids, every assistant sharing the user's askId (one fold group)`
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
      id: 'visible.domCompleted',
      name: 'the visible fold stream rendered its final content',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: the visible (default-selected) stream's rendered Markdown contained the final content marker (tail-marker-END)`
    },
    {
      id: 'main.parity',
      name: 'Main SQLite authority preserved (1 + N messages, one block per assistant, all success)',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: fetchMessages returned exactly 1 + ${n} topic-owned messages, roles [user + assistant x${n}], all message/block status success, every assistant owning exactly one block`
    },
    {
      id: 'content.sizeReached',
      name: 'every assistant Redux series reached the exact final reply length (content-size axis complete)',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: every assistant's Redux block-content series reached the exact per-model deterministic reply length`
    },
    {
      id: 'pairing.monotonic',
      name: 'next-DOM Redux→DOM pairing indices are monotonic (non-decreasing)',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: for every assistant the earliest at-or-after DOM commit index paired to each steady Redux commit was non-decreasing (monotonic next-DOM rule)`
    },
    {
      id: 'pairing.covered',
      name: 'every steady Redux commit had a next DOM commit at-or-after it',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: every steady Redux content commit paired to a DOM \`.markdown\` commit at-or-after it on the same page clock`
    },
    {
      id: 'pairing.steadyExcluded',
      name: 'the completion-tail flush was excluded from steady interval metrics',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: every assistant's steady window ended before the first commit carrying the exact final reply length; steady Redux/DOM/reduxToDom intervals exclude the all-success final flush`
    },
    {
      id: 'samples.completed',
      name: 'all samples produced finite, complete per-assistant series and aggregate counters',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: per-assistant Redux/DOM first-content + steady commit intervals + Redux→next-DOM intervals, accumulated content-size axis, input-latency probes, long tasks and frame deltas all recorded finite (zero-long-task runs keep metrics finite)`
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
        'render.redux.firstContent',
        'Send -> per-assistant Redux first block-content commit (store.subscribe-sampled)',
        acc.reduxFirstContent
      ),
      ...statsMetrics(
        'render.redux.commitInterval',
        'Per-assistant Redux block-content commit intervals, steady-state (completion-tail excluded)',
        acc.reduxCommitIntervals
      ),
      ...statsMetrics(
        'render.dom.firstContent',
        'Send -> per-assistant DOM .markdown first content commit (all streams, MutationObserver-sampled)',
        acc.domFirstContent
      ),
      ...statsMetrics(
        'render.dom.commitInterval',
        'Per-assistant DOM .markdown commit intervals, steady-state (completion-tail excluded)',
        acc.domCommitIntervals
      ),
      ...statsMetrics(
        'render.reduxToDom.interval',
        'Scheduling-inclusive Redux commit -> next DOM .markdown commit interval (aggregate render/commit interval: Redux dispatch + React scheduling + Markdown parse + DOM commit; NEVER "Markdown parse CPU"; next-DOM monotonic pairing, steady-state, non-1:1 for smooth streams)',
        acc.reduxToDomIntervals
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
      ...statsMetrics(
        'frame.delta',
        'Renderer rAF frame-delta cadence during the measured send (send-to-completion window)',
        acc.frameDeltas
      ),
      countMetric('frame.count', 'Renderer rAF frame count during the measured send', acc.frameDeltas.length),
      // ---- Content-size amplification axis (L3, non-threshold) -------------
      countMetric(
        'content.finalLength',
        'Total final reply length across all assistants (deterministic content size)',
        totalFinalLength
      ),
      countMetric(
        'content.accumulatedBytes',
        'Total content bytes committed by Redux across all assistants (all commits, completion-tail included) — renderer amplification on the content-size axis',
        totalAccumulated
      ),
      countMetric(
        'content.steadyAccumulatedBytes',
        'Total steady-state content bytes committed by Redux across all assistants (completion-tail excluded)',
        totalSteadyAccumulated
      ),
      {
        id: 'content.amplificationRatio',
        name: 'Accumulated content bytes / final content bytes (all commits)',
        value: amplificationRatio,
        unit: 'ratio'
      },
      {
        id: 'content.steadyAmplificationRatio',
        name: 'Steady accumulated content bytes / final content bytes',
        value: steadyAmplificationRatio,
        unit: 'ratio'
      },
      // ---- Long tasks (non-additive with stage intervals) -------------------
      ...longTaskPhaseMetrics('setup', 'Setup-phase (pre-send) long task', acc.longTaskSetup),
      ...longTaskPhaseMetrics('steady', 'Steady-phase (send -> first completion) long task', acc.longTaskSteady),
      ...longTaskPhaseMetrics(
        'completion',
        'Post-first-completion long task (first completion -> observation end: first stream completion processing + remaining streams streaming tail)',
        acc.longTaskCompletion
      ),
      countMetric('longtask.count', 'Aggregate long task count', longTaskCount),
      { id: 'longtask.totalMs', name: 'Aggregate long task total', value: longTaskTotal, unit: 'ms' },
      { id: 'longtask.maxMs', name: 'Aggregate long task max', value: longTaskMax, unit: 'ms' },
      { id: 'longtask.p95Ms', name: 'Aggregate long task p95', value: longTaskP95, unit: 'ms' }
    ],
    gates: correctness
  }
}

// ---------------------------------------------------------------------------
// The measurement test — one focused profile run, one artifact
// ---------------------------------------------------------------------------

test.describe('PERF-STREAM-ATTR-002 steady renderer amplification', () => {
  // Default-OFF env-gate: unset/empty env SKIPS this measurement-only spec so a
  // plain `pnpm test:e2e` stays green (LOCK-STREAM-RENDER-005). The gate helper
  // returns true for ANY explicit non-empty profile, so an explicit but
  // unsupported value is NOT skipped here and fails loudly inside the test body
  // (resolveRenderScaleProfile).
  test.skip(!renderScaleGateEnabled(), 'PERF_STREAM_RENDER_SCALE profile required (measurement-only, default-off)')

  test('measures steady renderer amplification across N concurrent streams (Redux/DOM/interval/content-size/longtask/frame/input)', async ({
    electronApp,
    mainWindow
  }) => {
    const profile = resolveRenderScaleProfile()
    test.setTimeout(profile.testTimeoutMs)
    const page = mainWindow

    const assistantId = await page.evaluate(() => (window as any).store.getState().assistants?.assistants?.[0]?.id)
    expect(assistantId, 'the fixture must provide a default assistant').toBeTruthy()

    const expectedModelIds = mentionModelIds(profile.mentionModelCount)
    const expectedReplies = expectedModelIds.map(expectedReplyFor)
    const acc = emptyAccumulator()
    let totals = { reduxEvents: 0, domEvents: 0, inputProbes: 0, longTasks: 0, frames: 0 }

    await test.step('Phase 0: register the profile mention models', async () => {
      await registerMentionModels(page, profile)
      console.log(
        `[E2E][PERF-STREAM-ATTR-002] registered ${profile.mentionModelCount} mention models (profile ${profile.kind})`
      )
    })

    await test.step('Phase 1: measured concurrent multi-model sends', async () => {
      for (let s = 0; s < profile.samplesPerProfile; s++) {
        const topicId = `attr002-sample-${s}`
        await createAndActivateTopic(page, topicId, `Attr002 Sample ${s}`, assistantId)
        await selectMentionModels(page, profile)

        const seqBefore = getRequestSequence()
        const result = await measureRenderSample(page, {
          topicId,
          messageText: SEND_MESSAGE_TEXT,
          mentionModelCount: profile.mentionModelCount,
          probeCount: profile.probeCountPerSample,
          completionTimeoutMs: 120000,
          probeWatchdogMs: 5000
        })
        const fanoutRequests = sampleFanoutRequests(seqBefore)
        const derived = await assertSampleCorrectness(page, {
          profile,
          sampleIndex: s,
          topicId,
          expectedModelIds,
          expectedReplies,
          result,
          fanoutRequests
        })

        // ---- Long-task phase bucketing (first completion = min assistant Redux success) --
        const firstCompletionMs = result.tSend + Math.min(...derived.map((d) => d.reduxCompletionMs))
        const phases = bucketLongTasksByPhase(result.longTasks, result.tSend, firstCompletionMs)

        // ---- Accumulate per-assistant metrics (all tSend-relative) ----------
        for (const d of derived) {
          acc.reduxFirstContent.push(d.reduxFirstContentMs)
          acc.reduxCommitIntervals.push(...d.reduxCommitIntervalsMs)
          acc.domFirstContent.push(d.domFirstContentMs)
          acc.domCommitIntervals.push(...d.domCommitIntervalsMs)
          acc.reduxToDomIntervals.push(...d.reduxToDomIntervalsMs)
          acc.accumulatedBytes.push(d.accumulatedBytes)
          acc.steadyAccumulatedBytes.push(d.steadyAccumulatedBytes)
          acc.finalLengths.push(d.finalLength)
        }
        acc.inputLatencies.push(...result.inputProbes.map((p) => p.latencyMs))
        acc.longTasks.push(...result.longTasks.map((t) => t.duration))
        acc.longTaskSetup.push(...phases.setup)
        acc.longTaskSteady.push(...phases.steady)
        acc.longTaskCompletion.push(...phases.completion)
        acc.frameDeltas.push(...result.frameDeltas)
        totals = {
          reduxEvents: totals.reduxEvents + result.redux.reduce((a, b) => a + b.series.length, 0),
          domEvents: totals.domEvents + result.dom.reduce((a, b) => a + b.series.length, 0),
          inputProbes: totals.inputProbes + result.inputProbes.length,
          longTasks: totals.longTasks + result.longTasks.length,
          frames: totals.frames + result.frameDeltas.length
        }

        console.log(
          `[E2E][PERF-STREAM-ATTR-002] sample ${s}: N=${profile.mentionModelCount}, ` +
            `${result.redux.reduce((a, b) => a + b.series.length, 0)} redux commits, ` +
            `${result.dom.reduce((a, b) => a + b.series.length, 0)} dom commits, ` +
            `${result.inputProbes.length} input probes, ${result.longTasks.length} long tasks, ` +
            `${result.frameDeltas.length} frames, ` +
            `ltSteady=${phases.steady.length}, ltCompletion=${phases.completion.length}`
        )
      }
    })

    await test.step('Phase 2: emit schema v1 artifact', async () => {
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
      // Only a safe basename is printed — absolute machine-local artifact paths
      // never enter logs (privacy/redaction).
      console.log(
        `[E2E][PERF-STREAM-ATTR-002] schema v1 artifact: ${path.basename(artifactPath)} (profile ${profile.kind}, N=${profile.mentionModelCount})`
      )
    })
  })
})
