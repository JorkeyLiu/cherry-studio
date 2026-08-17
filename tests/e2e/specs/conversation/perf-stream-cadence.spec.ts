/**
 * PERF-STREAM-CADENCE-001 — single-stream visible Markdown DOM cadence
 * measurement (production-build Playwright E2E, default-OFF).
 *
 * Purpose: quantify the N=1 visible Markdown DOM update cadence and batch
 * size that produces the user-reported "half-line-like block" visible output
 * pattern. This is measurement-only: no production source, Redux throttle,
 * cadence, or useSmoothStream behavior is modified.
 *
 * Scope (LOCK-MEASUREMENT): single-stream (N=1) cadence distribution only.
 * Concurrency amplification (N=2/3) is DEFERRED (LOCK-CONCURRENCY). Frame/
 * long-task relation is TIMESTAMP INTERVAL CORRELATION, NOT frame overlap or
 * causation. DOM points are parsed Markdown visible commits at frame
 * granularity, NOT React commit counts. We do NOT claim observation of
 * component-local displayedContent.
 *
 * Env gate: PERF_STREAM_CADENCE=1 (default-OFF; plain `pnpm test:e2e` skips).
 * Benchmark id: chatdb-stream-cadence-e2e-n1.
 * Artifact: schema-v1, emitted only after exact completion + Main parity +
 * environment + sample-completeness gates pass.
 *
 * Correctness gates (L1): content.exactCompletion, content.sizeReached,
 * visible.domCompleted, main.parity (with block content existence and exact
 * content), samples.completed, environment.abi145, privacy.schemaV1.
 * All numeric cadence metrics are L3 non-threshold (LOCK-EVIDENCE).
 *
 * Phase separation: steady-state primary cadence metrics (intervals,
 * chars-per-update) are reported separately from whole-window metrics.
 * The completion tail is excluded from steady-state interval metrics
 * following the same semantic as ATTR-002.
 *
 * Canonical run (fresh production build first):
 *   pnpm build
 *   PERF_STREAM_CADENCE=1 pnpm test:e2e -- tests/e2e/specs/conversation/perf-stream-cadence.spec.ts
 */
import type { Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkGate,
  type BenchmarkMetric,
  type BenchmarkResult,
  collectEnvironmentMetadata,
  writeBenchmarkResult
} from '../../../../src/main/services/chatDb/__tests__/benchResult'
import { mean, percentile, sortTimings } from '../../../../src/main/services/chatDb/__tests__/benchMetrics'
import { expect, getRequestLog, getRequestSequence, test } from '../../fixtures/electron.fixture'
import { getSlowStreamReply, SLOW_STREAM_MARKER } from '../../fixtures/mock-openai-server'
import {
  type CadenceMetrics,
  type CadencePoint,
  type LongTaskEntry,
  clipLongTasksToWindow,
  deriveCadenceMetrics,
  normalizeText,
  validateBlockReferenceIntegrity
} from '../../utils/perfStreamCadence'

// ---------------------------------------------------------------------------
// Fixed deterministic constants
// ---------------------------------------------------------------------------

const CADENCE_ENV = 'PERF_STREAM_CADENCE'
const BENCHMARK_ID = 'chatdb-stream-cadence-e2e-n1'
const BENCHMARK_NAME =
  'PERF-STREAM-CADENCE-001 N=1 single-stream visible Markdown DOM cadence (production-build E2E, Electron lane)'
const CANONICAL_COMMAND = 'pnpm test:e2e'
const MOCK_PROVIDER_ID = 'mock-openai'
const MODEL_ID = 'mock-model'
const SAMPLES = 3
const STREAM_PARAGRAPHS = 150
const STREAM_CHUNK_DELAY_MS = 60
const TEST_TIMEOUT_MS = 420000
const SEND_MESSAGE_TEXT = `cadence001 stream probe ${SLOW_STREAM_MARKER}`

const SETTLE = {
  mainParityMs: 5000,
  visibleDomMs: 5000,
  pollMs: 200
} as const

// ---------------------------------------------------------------------------
// Env gate
// ---------------------------------------------------------------------------

function cadenceGateEnabled(): boolean {
  return process.env[CADENCE_ENV] === '1'
}

// ---------------------------------------------------------------------------
// Page-context helpers (single-stream, reuse ATTR-002 patterns)
// ---------------------------------------------------------------------------

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
            createdAt: '2026-08-17T00:00:00.000Z',
            updatedAt: '2026-08-17T00:00:00.000Z'
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

// ---------------------------------------------------------------------------
// Post-send state readers (correctness gates)
// ---------------------------------------------------------------------------

async function readSampleState(
  page: Page,
  topicId: string
): Promise<{
  ids: string[]
  messages: Array<{ id: string; role: string; status: string; modelId: string | null; blocks: string[] }>
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
        modelId: m.model?.id ?? m.modelId ?? null,
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
    return { ids, messages, blocks, currentTopicId: s.messages?.currentTopicId ?? null }
  }, topicId)
}

interface MainParitySnapshot {
  messageCount: number
  allOwned: boolean
  roles: string[]
  statuses: string[]
  assistantBlockCounts: number[]
  blockStatuses: string[]
  blockOwnership: boolean
  /** Block contents for existence + exact content verification. */
  blockContents: string[]
  /** Exact assistant message→block mapping: assistant msg ID → referenced block IDs. */
  assistantBlockMap: Array<{ messageId: string; blockIds: string[] }>
  /** Per-message block reference pairs for ALL messages (user + assistant). */
  messageBlockRefs: Array<{ messageId: string; role: string; blockIds: string[] }>
  /** All block IDs returned (for extraneous-block detection). */
  allBlockIds: string[]
  /** All block IDs referenced by messages (for unreferenced-block detection). */
  allReferencedBlockIds: string[]
  /** Block details keyed by id: messageId, status, content for exact chain inspection. */
  blockDetails: Array<{ id: string; messageId: string; status: string; content: string }>
}

async function readMainTopic(page: Page, topicId: string): Promise<MainParitySnapshot> {
  return page.evaluate(async (topicId) => {
    const result = await (window as any).api.chatDb.fetchMessages({ topicId })
    if (!result?.ok) throw new Error(`fetchMessages failed for ${topicId}`)
    const messages = result.value.messages as Array<Record<string, unknown>>
    const blocks = result.value.blocks as Array<Record<string, unknown>>

    const assistantMessages = messages.filter((m) => m.role === 'assistant')
    const assistantBlockMap = assistantMessages.map((m) => ({
      messageId: String(m.id),
      blockIds: Array.isArray(m.blocks) ? (m.blocks as string[]).map(String) : []
    }))

    const allBlockIds = blocks.map((b) => String(b.id))
    const allReferencedBlockIds = messages.flatMap((m) =>
      Array.isArray(m.blocks) ? (m.blocks as string[]).map(String) : []
    )
    const blockDetails = blocks.map((b) => ({
      id: String(b.id),
      messageId: String(b.messageId ?? ''),
      status: String(b.status ?? ''),
      content: typeof b.content === 'string' ? b.content : ''
    }))

    const messageBlockRefs = messages.map((m) => ({
      messageId: String(m.id),
      role: String(m.role),
      blockIds: Array.isArray(m.blocks) ? (m.blocks as string[]).map(String) : []
    }))

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
      ),
      blockContents: blocks.map((b) => (typeof b.content === 'string' ? b.content : '')),
      assistantBlockMap,
      messageBlockRefs,
      allBlockIds,
      allReferencedBlockIds,
      blockDetails
    }
  }, topicId)
}

function mainParityReady(snapshot: MainParitySnapshot, expectedReply: string): boolean {
  // Structural checks
  if (snapshot.messageCount !== 2) return false
  if (!snapshot.allOwned) return false
  if ([...snapshot.roles].sort().join(',') !== ['assistant', 'user'].sort().join(',')) return false
  if (!snapshot.statuses.every((s) => s === 'success')) return false
  if (!snapshot.assistantBlockCounts.every((c) => c === 1)) return false
  if (!snapshot.blockStatuses.every((s) => s === 'success')) return false
  if (!snapshot.blockOwnership) return false

  // Per-message reference uniqueness (no intra-message duplicate block IDs)
  for (const ref of snapshot.messageBlockRefs) {
    if (new Set(ref.blockIds).size !== ref.blockIds.length) return false
  }

  // Global reference counts: every referenced ID must be referenced exactly once
  const globalRefCounts = new Map<string, number>()
  for (const ref of snapshot.messageBlockRefs) {
    for (const bid of ref.blockIds) {
      globalRefCounts.set(bid, (globalRefCounts.get(bid) ?? 0) + 1)
    }
  }
  for (const count of globalRefCounts.values()) {
    if (count !== 1) return false
  }

  // Returned block IDs must be unique
  if (new Set(snapshot.allBlockIds).size !== snapshot.allBlockIds.length) return false

  // Multiset equality: returned IDs multiset == referenced IDs multiset
  const returnedCounts = new Map<string, number>()
  for (const bid of snapshot.allBlockIds) {
    returnedCounts.set(bid, (returnedCounts.get(bid) ?? 0) + 1)
  }
  if (returnedCounts.size !== globalRefCounts.size) return false
  for (const [bid, count] of globalRefCounts) {
    if (returnedCounts.get(bid) !== count) return false
  }

  // Block ownership: block.messageId must match the referencing message for ALL messages
  const detailMap = new Map(snapshot.blockDetails.map((d) => [d.id, d]))
  for (const ref of snapshot.messageBlockRefs) {
    for (const bid of ref.blockIds) {
      const detail = detailMap.get(bid)
      if (!detail || detail.messageId !== ref.messageId) return false
    }
  }

  // Exact assistant block content == expectedReply and status == success
  const assistantRef = snapshot.messageBlockRefs.find((r) => r.role === 'assistant')
  if (!assistantRef || assistantRef.blockIds.length !== 1) return false
  const assistantBlock = detailMap.get(assistantRef.blockIds[0]!)
  if (!assistantBlock) return false
  if (assistantBlock.status !== 'success') return false
  if (assistantBlock.content !== expectedReply) return false

  return true
}

async function readMainTopicSettled(page: Page, topicId: string, expectedReply: string): Promise<MainParitySnapshot> {
  const deadline = Date.now() + SETTLE.mainParityMs
  let snapshot = await readMainTopic(page, topicId)
  while (!mainParityReady(snapshot, expectedReply) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE.pollMs))
    snapshot = await readMainTopic(page, topicId)
  }
  return snapshot
}

interface VisibleDomSnapshot {
  found: boolean
  display: string
  /** Raw `.markdown.textContent` (for diagnostics only, never asserted). */
  markdown: string
  /** Normalized text: all whitespace removed, case-preserved (canonical assertion target). */
  normalizedText: string
}

async function readVisibleDom(page: Page, messageId: string): Promise<VisibleDomSnapshot> {
  return page.evaluate((messageId) => {
    const el = document.getElementById(`message-${messageId}`)
    if (!el) return { found: false, display: 'none', markdown: '', normalizedText: '' }
    const md = el.querySelector('.markdown')
    const raw = md ? (md.textContent ?? '') : ''
    // Parser-independent normalization: remove all whitespace, preserve case.
    const normalizedText = raw.replace(/\s+/g, '')
    return { found: true, display: window.getComputedStyle(el).display, markdown: raw, normalizedText }
  }, messageId)
}

/**
 * L1 terminal DOM snapshot: exact provenance from the active sampler.
 * Carries raw visible text length, normalized visible text, and
 * whitespace-only case-preserving exact-match proof. This is an L1
 * correctness proof — NOT a cadence metric.
 *
 * LOCK-EVIDENCE: `observationTime` is the DOM observation timestamp
 * returned by the same page-context read that captured the Redux state.
 * `terminalSampleTime` equals `observationTime` — they are the same
 * page-context timestamp.
 */
interface TerminalDomSnapshot {
  /** Exact DOM observation timestamp (page clock, from the page-context read). */
  observationTime: number
  /** Raw `.markdown.textContent` length (L3 metric only, never asserted as correctness). */
  rawTextLength: number
  /** Whitespace-removed, case-preserved normalized text (canonical assertion target). */
  normalizedText: string
  /** True iff normalized text exactly equals the normalized expected reply. */
  exactMatch: boolean
  /**
   * Terminal sample time = observationTime from the same page-context read.
   * Used as the upper bound of the measurement window.
   */
  terminalSampleTime: number
}

/**
 * L1 terminal Redux snapshot: exact provenance from the active sampler.
 * Carries raw block content, block status, raw accumulated content
 * length, and exact content equality proof from the current store state
 * after completion. This is an L1 correctness proof — NOT a cadence metric.
 *
 * LOCK-EVIDENCE: `observationTime` is the Redux observation timestamp
 * captured immediately around the same page-context read that also
 * captured the DOM terminal state.
 */
interface TerminalReduxSnapshot {
  /** Exact Redux observation timestamp (page clock, from the page-context read). */
  observationTime: number
  /** Raw block content string from the store (exact, not derived). */
  rawContent: string
  /** Raw accumulated content length from the store (=== rawContent.length). */
  rawContentLength: number
  /** Block status at observation time (e.g. 'success'). */
  blockStatus: string
  /** True iff the store content exactly equals the expected reply. */
  exactContentMatch: boolean
}

/**
 * DOM readiness gate: the normalized `.markdown.textContent` must EXACTLY equal
 * the normalized expected reply. This is parser-independent: it removes ALL
 * whitespace from both expected source and visible DOM textContent and requires
 * exact non-whitespace character order/content equality (case-preserved).
 *
 * Returns the snapshot AND whether the normalized exact match was observed.
 */
function visibleDomReady(snapshot: VisibleDomSnapshot, normalizedExpected: string): boolean {
  return snapshot.found && snapshot.display !== 'none' && snapshot.normalizedText === normalizedExpected
}

/**
 * Independent verification: poll until the visible DOM textContent normalized
 * exactly matches the expected reply. This is NOT the primary acceptance gate;
 * the active sampler in measureCadenceSample observes the exact match while
 * instrumentation is active. This function independently verifies the result.
 */
async function readVisibleDomSettled(
  page: Page,
  messageId: string,
  normalizedExpected: string
): Promise<VisibleDomSnapshot> {
  const deadline = Date.now() + SETTLE.visibleDomMs
  let snapshot = await readVisibleDom(page, messageId)
  while (!visibleDomReady(snapshot, normalizedExpected) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE.pollMs))
    snapshot = await readVisibleDom(page, messageId)
  }
  return snapshot
}

/** Fanout proof from the mock request log. */
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
// Timed measurement — page-context cadence instrumentation
// ---------------------------------------------------------------------------

interface CadenceInstrumentationResult {
  tSend: number
  /** Per-assistant Redux block-content series (deduped by len, L3 cadence data). */
  redux: Array<{ messageId: string; series: CadencePoint[] }>
  /** Per-assistant DOM `.markdown` content series (deduped by length, L3 cadence data). */
  dom: Array<{ messageId: string; series: CadencePoint[] }>
  longTasks: LongTaskEntry[]
  frameDeltas: number[]
  completion: { messageCount: number; assistantCount: number }
  /** Terminal sample time (page-clock, set from DOM exact observation timestamp). */
  terminalSampleTime: number
  /** L1 terminal DOM snapshot: exact provenance from the active sampler. */
  terminalDomSnapshot: TerminalDomSnapshot
  /** L1 terminal Redux snapshot: exact provenance from the active sampler. */
  terminalReduxSnapshot: TerminalReduxSnapshot
}

/**
 * Measure ONE single-stream send end-to-end for cadence analysis. Installs
 * page-context instrumentation (store.subscribe Redux series, DOM
 * MutationObserver + frame-drained scan, PerformanceObserver longtask, rAF
 * frame deltas), sets the message text, dispatches a synthetic Enter keydown
 * in the same task as tSend, waits for the assistant stream to reach success
 * AND for the final DOM state to be frame-drained into the sampled series
 * through an explicit frame boundary, then detaches all instrumentation and
 * returns the bounded record.
 *
 * Cleanup invariant: ALL observers are disconnected in a finally block
 * regardless of success or failure (finding 7).
 */
function measureCadenceSample(
  page: Page,
  args: {
    topicId: string
    messageText: string
    completionTimeoutMs: number
    expectedReply: string
    normalizedExpectedVisibleText: string
  }
): Promise<CadenceInstrumentationResult> {
  return page.evaluate(
    async ({ topicId, messageText, completionTimeoutMs, expectedReply, normalizedExpectedVisibleText }) => {
      const store = (window as any).store
      const textarea = document.querySelector('.inputbar textarea') as HTMLTextAreaElement | null
      if (!textarea) throw new Error('measure: inputbar textarea not found')
      const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSet) throw new Error('measure: textarea native value setter unavailable')

      // ---- All observers created inside try scope for guaranteed cleanup ---
      let unsubscribe: (() => void) | null = null
      let observer: MutationObserver | null = null
      let perfObserver: PerformanceObserver | null = null
      let rafId = 0

      try {
        // ---- Sample-owned message-ID set ---------------------------------------
        const sampleMessageIds = new Set<string>()
        const adoptSampleMessageIds = (): void => {
          const s = store.getState()
          const ids: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
          for (const id of ids) sampleMessageIds.add(String(id))
        }

        // ---- Per-assistant Redux block-content series (deduped by len) ----------
        const reduxByAssistant = new Map<string, { lastLen: number; series: CadencePoint[] }>()
        const recordRedux = (messageId: string, len: number): void => {
          const prev = reduxByAssistant.get(messageId)
          if (prev && prev.lastLen === len) return
          const t = performance.now()
          if (prev) {
            prev.lastLen = len
          } else {
            reduxByAssistant.set(messageId, { lastLen: len, series: [] })
          }
          reduxByAssistant.get(messageId)!.series.push({ t, len })
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
            recordRedux(key, len)
          }
        }
        unsubscribe = store.subscribe(handleStoreUpdate)
        handleStoreUpdate()

        // ---- Per-assistant DOM `.markdown` series (frame-drained, deduped) ------
        const domByMessage = new Map<string, { lastLen: number; series: CadencePoint[] }>()
        let domDirty = true
        const scanDom = (): void => {
          const t = performance.now()
          for (const el of document.querySelectorAll('#messages [data-message-id]')) {
            const messageId = el.getAttribute('data-message-id')
            if (!messageId || !sampleMessageIds.has(messageId)) continue
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
        observer = new MutationObserver(() => {
          domDirty = true
        })
        if (messagesEl) observer.observe(messagesEl, { subtree: true, childList: true, characterData: true })
        scanDom()

        // ---- Long tasks (finite even when none) --------------------------------
        const longTasks: LongTaskEntry[] = []
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

        // ---- rAF frame-delta cadence + DOM drain --------------------------------
        const frameDeltas: number[] = []
        let lastFrame = performance.now()
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

        // ---- Stream progression helpers -----------------------------------------
        const topicAssistantIds = (): string[] => {
          const s = store.getState()
          const ids: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
          return ids.filter((id: string) => s.messages.entities[id]?.role === 'assistant')
        }

        // ---- rAF-polled wait (bounded watchdog) ---------------------------------
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

        // ---- Set message text, wait for React commit, send ---------------------
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
        frameDeltas.length = 0
        lastFrame = tSend
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

        // ---- Terminal snapshot declarations (set inside the wait loop) ----------
        let matchedAssistantId: string | null = null
        let terminalDomSnapshot: TerminalDomSnapshot = {
          observationTime: 0,
          rawTextLength: 0,
          normalizedText: '',
          exactMatch: false,
          terminalSampleTime: 0
        }
        let terminalReduxSnapshot: TerminalReduxSnapshot = {
          observationTime: 0,
          rawContent: '',
          rawContentLength: 0,
          blockStatus: '',
          exactContentMatch: false
        }

        // ---- Wait for Redux success + exact content match -----------------------
        // LOCK-EVIDENCE: The assistant Redux block must be success with content
        // exactly equal to the passed deterministic expected reply. This is L1
        // correctness. We poll a single page-context read that returns both
        // Redux block state and DOM text in one evaluate call.
        const reduxDeadline = performance.now() + completionTimeoutMs
        for (;;) {
          const snapshot = await new Promise<{
            assistantId: string
            content: string
            blockStatus: string
            msgStatus: string
            domRaw: string
            domNormalized: string
            /** DOM observation timestamp captured inside the page-context read. */
            observationTime: number
          }>((resolve) => {
            // Single page-context read: Redux state + DOM text together.
            // Capture observationTime inside the page context so terminal
            // provenance is a page-clock timestamp, not a post-read Node timestamp.
            const observationTime = performance.now()
            const s = store.getState()
            const ids: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
            for (const id of ids) {
              const msg = s.messages?.entities?.[id]
              if (!msg || String(msg.role ?? '') !== 'assistant') continue
              const blocks = msg.blocks ?? []
              if (blocks.length === 0) continue
              const blockId = blocks.find((bid: string) => s.messageBlocks?.entities?.[bid]?.type === 'main_text')
              const block = blockId ? s.messageBlocks?.entities?.[blockId] : null
              if (!block) continue
              const content = typeof block.content === 'string' ? block.content : ''
              const blockStatus = String(block.status ?? '')
              const msgStatus = String(msg.status ?? '')

              // DOM read from the same context
              const el = document.getElementById(`message-${id}`)
              const md = el ? el.querySelector('.markdown') : null
              const domRaw = md ? (md.textContent ?? '') : ''
              const domNormalized = domRaw.replace(/\s+/g, '')

              resolve({
                assistantId: id,
                content,
                blockStatus,
                msgStatus,
                domRaw,
                domNormalized,
                observationTime
              })
              return
            }
            // No assistant found yet — return empty
            resolve({
              assistantId: '',
              content: '',
              blockStatus: '',
              msgStatus: '',
              domRaw: '',
              domNormalized: '',
              observationTime
            })
          })

          // Gate: Redux block content exactly matches expected + block status success
          if (
            snapshot.content.length > 0 &&
            snapshot.blockStatus === 'success' &&
            snapshot.msgStatus === 'success' &&
            snapshot.content === expectedReply
          ) {
            // Gate: DOM normalized text also matches
            if (snapshot.domNormalized === normalizedExpectedVisibleText) {
              // Single page-context read produced both Redux and DOM terminal state.
              // observationTime is the page-clock timestamp captured inside the read.
              const observationTime = snapshot.observationTime
              // Redux snapshot from this read
              terminalReduxSnapshot = {
                observationTime,
                rawContent: snapshot.content,
                rawContentLength: snapshot.content.length,
                blockStatus: snapshot.blockStatus,
                exactContentMatch: snapshot.content === expectedReply
              }
              // DOM snapshot from this read (terminalSampleTime === observationTime)
              terminalDomSnapshot = {
                observationTime,
                rawTextLength: snapshot.domRaw.length,
                normalizedText: snapshot.domNormalized,
                exactMatch: snapshot.domNormalized === normalizedExpectedVisibleText,
                terminalSampleTime: observationTime
              }
              // Unconditionally append/replace the final DOM cadence point at
              // terminalDomSnapshot.observationTime. LOCK-DOM-TERMINAL: the
              // series boundary must be explicit even when length equals the
              // prior point; pure visible-delta derivation already ignores
              // zero deltas, but the raw series boundary is mandatory.
              const terminalDomPoint: { t: number; len: number } = { t: observationTime, len: snapshot.domRaw.length }
              const domState = domByMessage.get(snapshot.assistantId)
              if (domState) {
                // Remove any existing point at this exact timestamp, then append
                // the terminal point — ensures exactly one point at observationTime.
                domState.series = domState.series.filter((pt) => pt.t !== observationTime)
                domState.series.push(terminalDomPoint)
                domState.lastLen = snapshot.domRaw.length
              } else {
                domByMessage.set(snapshot.assistantId, {
                  lastLen: snapshot.domRaw.length,
                  series: [terminalDomPoint]
                })
              }
              matchedAssistantId = snapshot.assistantId
              break
            }
          }

          if (performance.now() > reduxDeadline) {
            throw new Error(
              `cadence: Redux success + content match timed out ` +
                `(assistantCount=${topicAssistantIds().length}, expected=1)`
            )
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }

        // ---- Ensure terminal Redux point exists in series -----------------------
        // If the last Redux series point has a different length (deduped),
        // append a terminal point for L3 cadence completeness using the
        // observationTime from the page-context read (not a post-read timestamp).
        if (matchedAssistantId) {
          const reduxState = reduxByAssistant.get(matchedAssistantId)
          const lastReduxLen =
            reduxState && reduxState.series.length > 0 ? reduxState.series[reduxState.series.length - 1]!.len : -1
          if (lastReduxLen !== terminalReduxSnapshot.rawContentLength) {
            if (reduxState) {
              reduxState.series.push({
                t: terminalReduxSnapshot.observationTime,
                len: terminalReduxSnapshot.rawContentLength
              })
            } else {
              reduxByAssistant.set(matchedAssistantId, {
                lastLen: terminalReduxSnapshot.rawContentLength,
                series: [{ t: terminalReduxSnapshot.observationTime, len: terminalReduxSnapshot.rawContentLength }]
              })
            }
          }
        }

        const terminalSampleTime = terminalDomSnapshot.terminalSampleTime

        // ---- Defensive invariant: all series points within window -----------
        // No DOM or Redux point may have timestamp > terminalSampleTime.
        // Filter as a defensive check without hiding a bug (the terminal point
        // construction above should already guarantee this).
        for (const entry of domByMessage.values()) {
          entry.series = entry.series.filter((pt) => pt.t <= terminalSampleTime)
        }
        for (const entry of reduxByAssistant.values()) {
          entry.series = entry.series.filter((pt) => pt.t <= terminalSampleTime)
        }

        // ---- Take remaining longtask records before disconnect ------------------
        if (perfObserver) {
          const remaining = perfObserver.takeRecords?.()
          if (remaining) {
            for (const entry of remaining) {
              longTasks.push({ startTime: entry.startTime, duration: entry.duration })
            }
          }
          perfObserver.disconnect()
          perfObserver = null
        }

        return {
          tSend,
          redux: Array.from(reduxByAssistant.entries()).map(([messageId, { series }]) => ({ messageId, series })),
          dom: Array.from(domByMessage.entries()).map(([messageId, { series }]) => ({ messageId, series })),
          longTasks,
          frameDeltas,
          completion: {
            messageCount: (store.getState().messages?.messageIdsByTopic?.[topicId] ?? []).length,
            assistantCount: topicAssistantIds().length
          },
          terminalSampleTime,
          terminalDomSnapshot,
          terminalReduxSnapshot
        }
      } finally {
        // ---- Blocker 7: Guaranteed cleanup in finally ---------------------------
        if (unsubscribe) unsubscribe()
        if (observer) observer.disconnect()
        if (perfObserver) perfObserver.disconnect()
        cancelAnimationFrame(rafId)
      }
    },
    args
  )
}

// ---------------------------------------------------------------------------
// Statistics + artifact construction
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

function statsMetrics(prefix: string, label: string, values: number[], unit = 'ms'): BenchmarkMetric[] {
  const s = summarize(values)
  return [
    { id: `${prefix}.p50`, name: `${label} p50`, value: s.p50, unit },
    { id: `${prefix}.p95`, name: `${label} p95`, value: s.p95, unit },
    { id: `${prefix}.mean`, name: `${label} mean`, value: s.mean, unit },
    { id: `${prefix}.min`, name: `${label} min`, value: s.min, unit },
    { id: `${prefix}.max`, name: `${label} max`, value: s.max, unit }
  ]
}

function charsStatsMetrics(prefix: string, label: string, values: number[]): BenchmarkMetric[] {
  return statsMetrics(prefix, label, values, 'chars')
}

function countMetric(id: string, name: string, value: number): BenchmarkMetric {
  return { id, name, value, unit: 'count' }
}

/** Accumulator across samples. */
interface Accumulator {
  visibleIntervalsMs: number[]
  charsPerUpdate: number[]
  visibleUpdateCounts: number[]
  finalVisibleLengths: number[]
  reduxIntervalsMs: number[]
  reduxUpdateCounts: number[]
  domToReduxRatios: number[]
  frameCounts: number[]
  overlapCounts: number[]
  overlapUnambiguous: boolean[]
  longTaskDurations: number[]
  frameDeltasAll: number[]
  // Steady-state
  steadyVisibleIntervalsMs: number[]
  steadyCharsPerUpdate: number[]
  steadyVisibleUpdateCounts: number[]
  steadyReduxIntervalsMs: number[]
  steadyReduxUpdateCounts: number[]
}

function emptyAccumulator(): Accumulator {
  return {
    visibleIntervalsMs: [],
    charsPerUpdate: [],
    visibleUpdateCounts: [],
    finalVisibleLengths: [],
    reduxIntervalsMs: [],
    reduxUpdateCounts: [],
    domToReduxRatios: [],
    frameCounts: [],
    overlapCounts: [],
    overlapUnambiguous: [],
    longTaskDurations: [],
    frameDeltasAll: [],
    steadyVisibleIntervalsMs: [],
    steadyCharsPerUpdate: [],
    steadyVisibleUpdateCounts: [],
    steadyReduxIntervalsMs: [],
    steadyReduxUpdateCounts: []
  }
}

/**
 * Correctness gates for ONE sample. Runs AFTER timing was recorded;
 * a gate failure aborts and produces no artifact.
 */
async function assertSampleCorrectness(
  page: Page,
  args: {
    sampleIndex: number
    topicId: string
    expectedReply: string
    result: CadenceInstrumentationResult
    fanoutRequests: Array<{ model: string; stream: boolean }>
  }
): Promise<CadenceMetrics> {
  const { sampleIndex, topicId, expectedReply, result, fanoutRequests } = args

  // ---- Fanout: exactly 1 streaming request -----------------------------------
  expect(fanoutRequests.length, `sample ${sampleIndex}: must produce exactly 1 streaming request`).toBe(1)
  expect(fanoutRequests[0]!.model, `sample ${sampleIndex}: request model must be mock-model`).toBe(MODEL_ID)
  expect(fanoutRequests[0]!.stream, `sample ${sampleIndex}: request must be streaming`).toBe(true)

  // ---- Redux projection ------------------------------------------------------
  const state = await readSampleState(page, topicId)
  expect(state.currentTopicId, `sample ${sampleIndex}: sample topic must be active`).toBe(topicId)
  expect(state.messages, `sample ${sampleIndex}: topic must hold exactly 2 messages`).toHaveLength(2)
  const userMessages = state.messages.filter((m) => m.role === 'user')
  const assistantMessages = state.messages.filter((m) => m.role === 'assistant')
  expect(userMessages, `sample ${sampleIndex}: exactly one user message`).toHaveLength(1)
  expect(assistantMessages, `sample ${sampleIndex}: exactly one assistant message`).toHaveLength(1)
  expect(assistantMessages[0]!.status, `sample ${sampleIndex}: assistant stream must reach success`).toBe('success')
  expect(assistantMessages[0]!.blocks, `sample ${sampleIndex}: assistant must own exactly one block`).toHaveLength(1)

  // ---- Exact reply completion ------------------------------------------------
  const block = state.blocks.find((b) => b.id === assistantMessages[0]!.blocks[0])
  expect(block, `sample ${sampleIndex}: block must be loaded`).toBeTruthy()
  expect(block!.status, `sample ${sampleIndex}: block status must be success`).toBe('success')
  expect(block!.content, `sample ${sampleIndex}: assistant must complete with exact deterministic reply`).toBe(
    expectedReply
  )

  // ---- Blocker 2: Terminal DOM snapshot verification (L1 proof) ---------------
  // The active sampler in measureCadenceSample captured the terminal DOM snapshot
  // while instrumentation was active. Verify the snapshot proves exact match.
  const assistantId = assistantMessages[0]!.id
  const normalizedExpected = normalizeText(expectedReply)
  expect(
    result.terminalDomSnapshot.exactMatch,
    `sample ${sampleIndex}: terminal DOM snapshot must prove exact normalized match`
  ).toBe(true)
  expect(
    result.terminalDomSnapshot.normalizedText,
    `sample ${sampleIndex}: terminal DOM normalized text must exactly equal normalized expected reply`
  ).toBe(normalizedExpected)
  expect(
    result.terminalDomSnapshot.rawTextLength,
    `sample ${sampleIndex}: terminal DOM raw text length must be > 0`
  ).toBeGreaterThan(0)
  expect(
    result.terminalDomSnapshot.observationTime,
    `sample ${sampleIndex}: terminal DOM observation time must be within measurement window`
  ).toBeGreaterThanOrEqual(result.tSend)
  expect(
    result.terminalDomSnapshot.observationTime,
    `sample ${sampleIndex}: terminal DOM observation time must be <= terminalSampleTime`
  ).toBeLessThanOrEqual(result.terminalSampleTime)
  // Independent verification: settled DOM read confirms the exact match
  const visibleDom = await readVisibleDomSettled(page, assistantId, normalizedExpected)
  expect(visibleDom.found, `sample ${sampleIndex}: visible stream wrapper rendered`).toBe(true)
  expect(visibleDom.display, `sample ${sampleIndex}: visible stream displayed`).not.toBe('none')
  expect(
    visibleDom.normalizedText,
    `sample ${sampleIndex}: independent DOM verification must EXACTLY equal normalized expected reply`
  ).toBe(normalizedExpected)
  // finalVisibleLength in metrics comes from deriveCadenceMetrics (L3 DOM series).
  // The snapshot rawTextLength above is L1 proof; this variable is for clarity.

  // ---- Blocker 3: Main SQLite parity with exact message→block mapping --------
  const main = await readMainTopicSettled(page, topicId, expectedReply)
  expect(main.messageCount, `sample ${sampleIndex}: Main must hold exactly 2 messages`).toBe(2)
  expect(main.allOwned, `sample ${sampleIndex}: all Main rows topic-owned`).toBe(true)
  expect(main.roles.sort(), `sample ${sampleIndex}: Main roles must be [assistant, user]`).toEqual([
    'assistant',
    'user'
  ])
  expect(
    main.statuses.every((s) => s === 'success'),
    `sample ${sampleIndex}: all statuses success`
  ).toBe(true)
  // Exact assistant→block mapping: exactly 1 assistant message
  expect(main.assistantBlockMap.length, `sample ${sampleIndex}: exactly 1 assistant message`).toBe(1)
  const assistantMsgId = main.assistantBlockMap[0]!.messageId
  // Exactly 1 referenced block ID per assistant message
  expect(
    main.assistantBlockMap[0]!.blockIds.length,
    `sample ${sampleIndex}: assistant must reference exactly 1 block`
  ).toBe(1)
  const assistantBlockId = main.assistantBlockMap[0]!.blockIds[0]!
  // Referenced block exists exactly once
  expect(
    main.allBlockIds.filter((id) => id === assistantBlockId).length,
    `sample ${sampleIndex}: referenced block must exist exactly once`
  ).toBe(1)
  // Exact Set equality: every returned block is referenced and vice versa
  const returnedSet = new Set(main.allBlockIds)
  const referencedSet = new Set(main.allReferencedBlockIds)
  expect(
    returnedSet.size,
    `sample ${sampleIndex}: returned and referenced block ID sets must have same cardinality`
  ).toBe(referencedSet.size)
  expect(
    [...returnedSet].every((id) => referencedSet.has(id)),
    `sample ${sampleIndex}: every returned block ID must be referenced`
  ).toBe(true)
  // Resolve the one referenced block by exact ID and prove messageId, status, content
  const blockDetail = main.blockDetails.find((b) => b.id === assistantBlockId)
  expect(blockDetail, `sample ${sampleIndex}: assistant referenced block must exist in blockDetails`).toBeTruthy()
  expect(blockDetail!.messageId, `sample ${sampleIndex}: block.messageId must match assistant message ID`).toBe(
    assistantMsgId
  )
  expect(blockDetail!.status, `sample ${sampleIndex}: block status must be success`).toBe('success')
  expect(blockDetail!.content, `sample ${sampleIndex}: block content must exactly match expected reply`).toBe(
    expectedReply
  )

  // ---- Hard assertions: block reference integrity (pure helper) ---------------
  // Comprehensive integrity check: per-message uniqueness, block ownership,
  // global reference uniqueness, returned-ID uniqueness, multiset equality,
  // and exact assistant block content/status. This is NOT a trust of the
  // settle predicate — it is an independent hard assertion.
  const integrityError = validateBlockReferenceIntegrity(
    main.messageBlockRefs,
    main.allBlockIds,
    main.blockDetails,
    expectedReply
  )
  expect(
    integrityError,
    `sample ${sampleIndex}: block reference integrity must pass (${integrityError ?? 'OK'})`
  ).toBeNull()

  // ---- Hard assertions: explicit per-message reference ownership --------------
  // Every message's block reference IDs must be unique within that message
  for (const ref of main.messageBlockRefs) {
    expect(
      new Set(ref.blockIds).size,
      `sample ${sampleIndex}: message ${ref.messageId} block references must be unique`
    ).toBe(ref.blockIds.length)
  }
  // Every referenced block's messageId must equal the referencing message's ID
  for (const ref of main.messageBlockRefs) {
    for (const bid of ref.blockIds) {
      const detail = main.blockDetails.find((b) => b.id === bid)
      expect(detail, `sample ${sampleIndex}: referenced block ${bid} must exist in blockDetails`).toBeTruthy()
      expect(
        detail!.messageId,
        `sample ${sampleIndex}: block ${bid} ownership must match message ${ref.messageId}`
      ).toBe(ref.messageId)
    }
  }
  // No duplicate global references (multiset check)
  const globalRefCounts = new Map<string, number>()
  for (const ref of main.messageBlockRefs) {
    for (const bid of ref.blockIds) {
      globalRefCounts.set(bid, (globalRefCounts.get(bid) ?? 0) + 1)
    }
  }
  for (const [bid, count] of globalRefCounts) {
    expect(count, `sample ${sampleIndex}: block ${bid} must be referenced exactly once (got ${count})`).toBe(1)
  }
  // Returned block IDs must be unique
  expect(new Set(main.allBlockIds).size, `sample ${sampleIndex}: returned block IDs must be unique`).toBe(
    main.allBlockIds.length
  )
  // Multiset equality: returned IDs multiset == all referenced IDs multiset
  const returnedCounts = new Map<string, number>()
  for (const bid of main.allBlockIds) {
    returnedCounts.set(bid, (returnedCounts.get(bid) ?? 0) + 1)
  }
  expect(
    returnedCounts.size,
    `sample ${sampleIndex}: returned and referenced block ID multiset must have same cardinality`
  ).toBe(globalRefCounts.size)
  for (const [bid, count] of globalRefCounts) {
    expect(returnedCounts.get(bid), `sample ${sampleIndex}: block ${bid} multiset count must match`).toBe(count)
  }

  // ---- Completion sanity ------------------------------------------------------
  expect(result.completion.messageCount, `sample ${sampleIndex}: completion message count`).toBe(2)
  expect(result.completion.assistantCount, `sample ${sampleIndex}: completion assistant count`).toBe(1)

  // ---- Derive cadence metrics ------------------------------------------------
  const reduxSeries = result.redux.find((e) => e.messageId === assistantId)
  const domSeries = result.dom.find((e) => e.messageId === assistantId)
  expect(reduxSeries, `sample ${sampleIndex}: Redux series must exist for assistant`).toBeTruthy()
  expect(domSeries, `sample ${sampleIndex}: DOM series must exist for assistant`).toBeTruthy()

  // ---- Blocker 4: Terminal Redux snapshot verification (L1 proof) ------------
  // The terminal Redux snapshot captures exact store state after completion.
  // Require blockStatus success, exact content match, raw content, and raw
  // content length equal to expectedReply.length.
  expect(
    result.terminalReduxSnapshot.blockStatus,
    `sample ${sampleIndex}: terminal Redux snapshot blockStatus must be success`
  ).toBe('success')
  expect(
    result.terminalReduxSnapshot.exactContentMatch,
    `sample ${sampleIndex}: terminal Redux snapshot must prove exact content match`
  ).toBe(true)
  expect(
    result.terminalReduxSnapshot.rawContentLength,
    `sample ${sampleIndex}: terminal Redux snapshot raw content length must equal expected reply length`
  ).toBe(expectedReply.length)
  expect(
    result.terminalReduxSnapshot.rawContent,
    `sample ${sampleIndex}: terminal Redux snapshot raw content must exactly equal expected reply`
  ).toBe(expectedReply)
  expect(
    result.terminalReduxSnapshot.observationTime,
    `sample ${sampleIndex}: terminal Redux observation time must be within measurement window`
  ).toBeGreaterThanOrEqual(result.tSend)
  expect(
    result.terminalReduxSnapshot.observationTime,
    `sample ${sampleIndex}: terminal Redux observation time must be <= terminalSampleTime`
  ).toBeLessThanOrEqual(result.terminalSampleTime)
  // Also verify the last Redux series point reaches expected length (cadence boundary)
  const lastReduxPoint = reduxSeries!.series[reduxSeries!.series.length - 1]
  expect(lastReduxPoint, `sample ${sampleIndex}: Redux series must have at least one point`).toBeTruthy()
  expect(
    lastReduxPoint!.len,
    `sample ${sampleIndex}: terminal Redux series point must have exact expected reply length`
  ).toBe(expectedReply.length)

  // Clip long tasks to the measurement window for overlap and metrics
  const clippedLongTasks = clipLongTasksToWindow(result.longTasks, result.tSend, result.terminalSampleTime)
  // Verify clipped entries are within the measurement window
  for (const lt of clippedLongTasks) {
    expect(lt.startTime, `sample ${sampleIndex}: clipped long task start must be >= tSend`).toBeGreaterThanOrEqual(
      result.tSend
    )
    expect(
      lt.startTime + lt.duration,
      `sample ${sampleIndex}: clipped long task end must be <= terminalSampleTime`
    ).toBeLessThanOrEqual(result.terminalSampleTime)
  }

  const metrics = deriveCadenceMetrics(
    domSeries!.series,
    reduxSeries!.series,
    clippedLongTasks,
    result.frameDeltas.length,
    expectedReply.length,
    result.tSend,
    result.terminalSampleTime
  )

  // Correctness gates for cadence derivation
  expect(metrics.visibleUpdateCount, `sample ${sampleIndex}: must have at least 1 visible DOM update`).toBeGreaterThan(
    0
  )
  expect(metrics.reduxUpdateCount, `sample ${sampleIndex}: must have at least 1 Redux content commit`).toBeGreaterThan(
    0
  )
  expect(metrics.finalVisibleLength, `sample ${sampleIndex}: final visible length must be > 0 chars`).toBeGreaterThan(0)
  expect(metrics.domToReduxRatio, `sample ${sampleIndex}: domToReduxRatio must be finite`).toBeGreaterThan(0)
  // charsPerUpdate: every entry must be positive (growing series)
  expect(
    metrics.charsPerUpdate.every((c) => c > 0),
    `sample ${sampleIndex}: all charsPerUpdate entries must be positive`
  ).toBe(true)
  // visibleIntervalsMs: must have entries (at least 2 visible updates)
  expect(
    metrics.visibleIntervalsMs.length,
    `sample ${sampleIndex}: must have visible intervals (>= 2 visible updates)`
  ).toBeGreaterThan(0)
  // Blocker 6: steady-state metrics must be reportable (may be empty if completion
  // happens in the same commit as first content, but steady counts should be finite)
  expect(
    Number.isFinite(metrics.steadyVisibleUpdateCount),
    `sample ${sampleIndex}: steadyVisibleUpdateCount must be finite`
  ).toBe(true)
  expect(
    Number.isFinite(metrics.steadyReduxUpdateCount),
    `sample ${sampleIndex}: steadyReduxUpdateCount must be finite`
  ).toBe(true)
  // Phase derivation: missing final Redux boundary is an error
  // The last Redux commit must reach expectedFinalLength; otherwise steady state
  // incorrectly includes the completion tail. This is the invalid fallback gate.
  const lastReduxLen = reduxSeries!.series[reduxSeries!.series.length - 1]!.len
  expect(
    lastReduxLen,
    `sample ${sampleIndex}: last Redux commit must reach expected reply length (missing final boundary = invalid)`
  ).toBe(expectedReply.length)
  // Overlap semantics: timestamp-in-long-task-interval correlation is NOT frame overlap
  expect(
    metrics.overlapSemanticsUnambiguous,
    `sample ${sampleIndex}: overlap semantics unambiguous iff long tasks exist`
  ).toBe(clippedLongTasks.length > 0 && metrics.visibleUpdateCount > 0)

  return metrics
}

/** Build the schema-v1 artifact. All numeric metrics are L3 non-threshold. */
function buildBenchmarkResult(
  acc: Accumulator,
  environment: BenchmarkResult['environment'],
  expectedReplyLength: number
): BenchmarkResult {
  const samples = SAMPLES
  const totalReduxUpdates = acc.reduxUpdateCounts.reduce((a, b) => a + b, 0)
  const totalVisibleUpdates = acc.visibleUpdateCounts.reduce((a, b) => a + b, 0)
  const avgDomToReduxRatio =
    acc.domToReduxRatios.length > 0 ? acc.domToReduxRatios.reduce((a, b) => a + b, 0) / acc.domToReduxRatios.length : 0
  const totalLongTasks = acc.longTaskDurations.length
  const totalOverlap = acc.overlapCounts.reduce((a, b) => a + b, 0)
  const anyUnambiguous = acc.overlapUnambiguous.some((u) => u)

  // Steady-state totals
  const totalSteadyReduxUpdates = acc.steadyReduxUpdateCounts.reduce((a, b) => a + b, 0)
  const totalSteadyVisibleUpdates = acc.steadyVisibleUpdateCounts.reduce((a, b) => a + b, 0)

  const correctness: BenchmarkGate[] = [
    {
      id: 'content.exactCompletion',
      name: 'every stream completed with exact deterministic content',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: the single assistant reached block status success with the exact deterministic reply (${STREAM_PARAGRAPHS}-paragraph slow stream)`
    },
    {
      id: 'content.sizeReached',
      name: 'terminal Redux point has exact expected reply length',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: the last Redux content commit reached the exact reply length (${expectedReplyLength} chars)`
    },
    {
      id: 'visible.domCompleted',
      name: 'normalized DOM textContent exactly matches normalized expected reply',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: normalized .markdown.textContent (all whitespace removed, case preserved) exactly equaled the normalized expected reply; terminal DOM snapshot captured`
    },
    {
      id: 'main.parity',
      name: 'Main SQLite parity with exact per-message block ownership and duplicate-free mapping',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: every message's block references are unique; every referenced block ID resolves exactly once with block.messageId matching the referencing message; no duplicate global references; returned block ID multiset equals all referenced IDs; assistant block content exactly matches expected reply with success status; pure integrity validation passed`
    },
    {
      id: 'samples.completed',
      name: 'all samples produced finite cadence metrics with exact clipping',
      kind: 'correctness',
      passed: true,
      detail: `${samples}/${samples} samples: visible intervals, chars-per-update (chars unit), Redux intervals, domToRedux ratio, frame counts, clipped long-task durations, and timestamp-in-long-task-interval correlation all recorded finite`
    },
    {
      id: 'environment.abi145',
      name: 'measured runtime is the Electron ABI 145 lane',
      kind: 'correctness',
      passed: true,
      detail: `abiLane=electron, abi=${environment.abi}, command=${environment.command}`
    },
    {
      id: 'privacy.schemaV1',
      name: 'artifact complies with the PERF-001 schema v1 closed set',
      kind: 'correctness',
      passed: true,
      detail:
        'metrics/gates/scale carry only numbers and fixed strings; no message content, credentials, paths, model IDs, or raw DB sizes'
    }
  ]

  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: BENCHMARK_ID,
      name: BENCHMARK_NAME,
      scale: {
        samplesPerProfile: SAMPLES,
        streamParagraphs: STREAM_PARAGRAPHS,
        streamChunkDelayMs: STREAM_CHUNK_DELAY_MS,
        totalReduxUpdates,
        totalVisibleUpdates,
        avgDomToReduxRatio,
        totalLongTasks,
        totalOverlap,
        totalSteadyReduxUpdates,
        totalSteadyVisibleUpdates
      }
    },
    environment,
    metrics: [
      // --- Visible cadence (whole window) ---
      ...statsMetrics(
        'cadence.visible.interval',
        'Inter-visible-update intervals, whole window (positive visible DOM length deltas, frame-granular commits)',
        acc.visibleIntervalsMs
      ),
      ...charsStatsMetrics(
        'cadence.visible.charsPerUpdate',
        'Chars gained per visible DOM update, whole window (positive deltas only, batch size axis)',
        acc.charsPerUpdate
      ),
      countMetric(
        'cadence.visible.updateCount.total',
        'Total visible DOM update count across all samples',
        totalVisibleUpdates
      ),
      ...statsMetrics(
        'cadence.visible.updateCount.perSample',
        'Visible DOM update count per sample',
        acc.visibleUpdateCounts,
        'count'
      ),
      {
        id: 'cadence.visible.finalLength.mean',
        name: 'Mean final visible Markdown DOM textContent length',
        value:
          acc.finalVisibleLengths.length > 0
            ? acc.finalVisibleLengths.reduce((a, b) => a + b, 0) / acc.finalVisibleLengths.length
            : 0,
        unit: 'chars'
      },
      // --- Visible cadence (steady state) ---
      ...statsMetrics(
        'cadence.visible.steady.interval',
        'Inter-visible-update intervals, steady state (first content to first commit reaching final length)',
        acc.steadyVisibleIntervalsMs
      ),
      ...charsStatsMetrics(
        'cadence.visible.steady.charsPerUpdate',
        'Chars gained per visible DOM update, steady state (positive deltas only)',
        acc.steadyCharsPerUpdate
      ),
      countMetric(
        'cadence.visible.steady.updateCount.total',
        'Total steady-state visible DOM update count across all samples',
        totalSteadyVisibleUpdates
      ),
      ...statsMetrics(
        'cadence.visible.steady.updateCount.perSample',
        'Steady-state visible DOM update count per sample',
        acc.steadyVisibleUpdateCounts,
        'count'
      ),
      // --- Redux cadence (whole window) ---
      ...statsMetrics(
        'cadence.redux.interval',
        'Redux content commit intervals (per-assistant main_text block, store.subscribe-sampled)',
        acc.reduxIntervalsMs
      ),
      countMetric(
        'cadence.redux.updateCount.total',
        'Total Redux content commit count across all samples',
        totalReduxUpdates
      ),
      ...statsMetrics(
        'cadence.redux.updateCount.perSample',
        'Redux content commit count per sample',
        acc.reduxUpdateCounts,
        'count'
      ),
      // --- Redux cadence (steady state) ---
      ...statsMetrics(
        'cadence.redux.steady.interval',
        'Redux content commit intervals, steady state',
        acc.steadyReduxIntervalsMs
      ),
      countMetric(
        'cadence.redux.steady.updateCount.total',
        'Total steady-state Redux content commit count across all samples',
        totalSteadyReduxUpdates
      ),
      ...statsMetrics(
        'cadence.redux.steady.updateCount.perSample',
        'Steady-state Redux content commit count per sample',
        acc.steadyReduxUpdateCounts,
        'count'
      ),
      // --- DOM-to-Redux ratio (dimensionless) ---
      ...statsMetrics(
        'cadence.domToRedux.ratio',
        'DOM update count / Redux update count (>1 means DOM updates more frequently than Redux commits)',
        acc.domToReduxRatios,
        'ratio'
      ),
      // --- Frame cadence ---
      ...statsMetrics(
        'cadence.frame.delta',
        'Renderer rAF frame-delta cadence during the measured send (send-to-completion window)',
        acc.frameDeltasAll
      ),
      countMetric(
        'cadence.frame.count.total',
        'Total sampled frame-delta count across all samples',
        acc.frameCounts.reduce((a, b) => a + b, 0)
      ),
      // --- Long-task correlation (non-additive, timestamp interval correlation only) ---
      countMetric(
        'cadence.longTask.count.total',
        'Total long task count across all samples (clipped to measurement window)',
        totalLongTasks
      ),
      {
        id: 'cadence.longTask.totalMs',
        name: 'Aggregate long task total duration',
        value: acc.longTaskDurations.reduce((a, b) => a + b, 0),
        unit: 'ms'
      },
      {
        id: 'cadence.longTask.maxMs',
        name: 'Aggregate long task max duration',
        value: totalLongTasks > 0 ? Math.max(...acc.longTaskDurations) : 0,
        unit: 'ms'
      },
      countMetric(
        'cadence.longTask.overlapCount.total',
        'Total visible DOM updates whose timestamp falls within a long-task interval (TIMESTAMP INTERVAL CORRELATION, NOT frame overlap or causation)',
        totalOverlap
      ),
      {
        id: 'cadence.longTask.overlapUnambiguous',
        name: 'Overlap semantics unambiguous (at least one long task AND one visible update)',
        value: anyUnambiguous ? 1 : 0,
        unit: 'flag'
      }
    ],
    gates: correctness
  }
}

// ---------------------------------------------------------------------------
// The measurement test — one focused N=1 run, one artifact
// ---------------------------------------------------------------------------

test.describe('PERF-STREAM-CADENCE-001 single-stream cadence', () => {
  // Default-OFF env-gate: unset/empty env SKIPS this measurement-only spec.
  test.skip(!cadenceGateEnabled(), 'PERF_STREAM_CADENCE=1 required (measurement-only, default-off)')

  test('measures single-stream visible Markdown DOM cadence and batch size', async ({ electronApp, mainWindow }) => {
    test.setTimeout(TEST_TIMEOUT_MS)
    const page = mainWindow

    const assistantId = await page.evaluate(() => (window as any).store.getState().assistants?.assistants?.[0]?.id)
    expect(assistantId, 'the fixture must provide a default assistant').toBeTruthy()

    const expectedReply = getSlowStreamReply(MODEL_ID)
    const acc = emptyAccumulator()

    await test.step('Phase 1: measured single-stream sends', async () => {
      for (let s = 0; s < SAMPLES; s++) {
        const topicId = `cadence001-sample-${s}`
        await createAndActivateTopic(page, topicId, `Cadence001 Sample ${s}`, assistantId)

        const seqBefore = getRequestSequence()
        const result = await measureCadenceSample(page, {
          topicId,
          messageText: SEND_MESSAGE_TEXT,
          completionTimeoutMs: 120000,
          expectedReply,
          normalizedExpectedVisibleText: normalizeText(expectedReply)
        })
        const fanoutRequests = sampleFanoutRequests(seqBefore)
        const cadenceMetrics = await assertSampleCorrectness(page, {
          sampleIndex: s,
          topicId,
          expectedReply,
          result,
          fanoutRequests
        })

        // Accumulate
        acc.visibleIntervalsMs.push(...cadenceMetrics.visibleIntervalsMs)
        acc.charsPerUpdate.push(...cadenceMetrics.charsPerUpdate)
        acc.visibleUpdateCounts.push(cadenceMetrics.visibleUpdateCount)
        acc.finalVisibleLengths.push(cadenceMetrics.finalVisibleLength)
        acc.reduxIntervalsMs.push(...cadenceMetrics.reduxIntervalsMs)
        acc.reduxUpdateCounts.push(cadenceMetrics.reduxUpdateCount)
        acc.domToReduxRatios.push(cadenceMetrics.domToReduxRatio)
        acc.frameCounts.push(cadenceMetrics.frameCount)
        acc.overlapCounts.push(cadenceMetrics.visibleTimestampLongTaskOverlap)
        acc.overlapUnambiguous.push(cadenceMetrics.overlapSemanticsUnambiguous)
        // Clip long tasks to the measurement window for aggregate metrics
        const clippedTasksForAcc = clipLongTasksToWindow(result.longTasks, result.tSend, result.terminalSampleTime)
        acc.longTaskDurations.push(...clippedTasksForAcc.map((t) => t.duration))
        acc.frameDeltasAll.push(...result.frameDeltas)
        // Steady-state
        acc.steadyVisibleIntervalsMs.push(...cadenceMetrics.steadyVisibleIntervalsMs)
        acc.steadyCharsPerUpdate.push(...cadenceMetrics.steadyCharsPerUpdate)
        acc.steadyVisibleUpdateCounts.push(cadenceMetrics.steadyVisibleUpdateCount)
        acc.steadyReduxIntervalsMs.push(...cadenceMetrics.steadyReduxIntervalsMs)
        acc.steadyReduxUpdateCounts.push(cadenceMetrics.steadyReduxUpdateCount)

        console.log(
          `[E2E][PERF-STREAM-CADENCE-001] sample ${s}: ` +
            `visibleUpdates=${cadenceMetrics.visibleUpdateCount}, ` +
            `reduxUpdates=${cadenceMetrics.reduxUpdateCount}, ` +
            `domToRedux=${cadenceMetrics.domToReduxRatio.toFixed(2)}, ` +
            `finalVisible=${cadenceMetrics.finalVisibleLength}, ` +
            `frames=${cadenceMetrics.frameCount}, ` +
            `longTasks=${result.longTasks.length}, ` +
            `overlap=${cadenceMetrics.visibleTimestampLongTaskOverlap}, ` +
            `steadyVisible=${cadenceMetrics.steadyVisibleUpdateCount}, ` +
            `steadyRedux=${cadenceMetrics.steadyReduxUpdateCount}`
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
      const result = buildBenchmarkResult(acc, environment, expectedReply.length)
      const artifactPath = writeBenchmarkResult(result)
      expect(fs.existsSync(artifactPath), 'artifact must exist after a passing run').toBe(true)
      console.log(`[E2E][PERF-STREAM-CADENCE-001] schema v1 artifact: ${path.basename(artifactPath)}`)
    })
  })
})
