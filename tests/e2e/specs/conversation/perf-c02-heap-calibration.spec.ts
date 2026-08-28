/**
 * PERF-C02 — renderer-side heap calibration (measurement-only, directional synthetic).
 *
 * Purpose (bounded C-02, LOCK-C01-001..006 + C-02 lock + zero-delta inconclusive lock):
 * - Resident conversation projections belong to the renderer; a Node main-native
 *   heap proxy is a design deviation. This spec is a measurement-only Electron
 *   E2E calibration artifact that samples the REAL renderer process and labels
 *   evidence as directional/synthetic, without changing production behavior or
 *   selecting policy.
 * - Deterministic synthetic projection is materialized through the EXISTING
 *   production Redux entity projection path only: discover the live assistant
 *   ID from renderer store, dispatch `assistants/addTopic` with the synthetic
 *   topic metadata (existing Redux slice), persist via typed ChatDb IPC
 *   (ensureTopic + pasteMessagesToTopic — the existing Main SQLite authority),
 *   set display count via existing `newMessages/setDisplayCount` when the
 *   intended bounded synthetic projection exceeds the default window, then
 *   activate via the EXISTING rendered topic-item click path
 *   (`[data-testid="topic-item"][data-topic-id="..."]` click → HomePage →
 *   useActiveTopic → loadTopicMessagesThunk → Chat/Messages production
 *   projections: createLatestMessageWindow → createMessageViewportGroupModel →
 *   projectMessageViewportGroups and computeContextInfo) observed through DOM
 *   (#messages [data-stable-group-id], #messages [data-message-id],
 *   #messages [data-context-boundary]) with deterministic final-topic-scoped waits for
 *   Redux message IDs, loading false, DOM message count scoped to the final
 *   synthetic topic inside #messages (`#messages [data-message-id^="c02-heap-topic-…-msg-"]` vs global `#messages [data-message-id]`),
 *   exact stable group count inside #messages, and explicit [data-context-boundary] inside #messages with final-topic-owned anchor.
 *   No runtime/setActiveTopic activation, no detached `window.__c02Resident`
 *   synthetic holder, no hand-maintained grouping algorithm replica, no new
 *   IPC/preload/schema. Direct import of production renderer modules inside
 *   page.evaluate is blocked without a production hook (Electron bundle
 *   isolation); the rendered DOM path is the narrowest hook-free production
 *   derivation and is retained. If the rendered path cannot be materialized,
 *   the artifact fails closed or narrows claims (derived counts 0, detail notes
 *   blocker). No new IPC/preload/schema/migration/context-window/sync changes.
 *   productionPath is complete ONLY when the final clicked synthetic topic
 *   demonstrably owns #messages DOM (scoped===global===expectedVisible via #messages [data-message-id]), the exact
 *   expected stable group count inside #messages is observed with ownership proof, and LOCK-004 context evidence is valid per explicit inside-messages signal (mandatory fail-closed): whole-topic windows (positive integer 1..25) require no divider anywhere + null anchor (valid absent), partial windows require divider inside #messages with final-topic-owned anchor (valid present); outside/global divider is invalid in either branch;
 *   fallback [id^="message-"], global document queries, or inferred first-group anchor never satisfies
 *   complete — incomplete/ambiguous observations are explicitly partial/inconclusive. Authoritative calibration complete
 *   strictly requires precise && finite positive heap delta in addition to this #messages production DOM proof and derived predicate-valid productionPath (caller bool cannot override invalid evidence).
 * - Sampling uses the least invasive available renderer API: Chromium
 *   `performance.memory` (usedJSHeapSize/totalJSHeapSize/jsHeapSizeLimit) via
 *   `page.evaluate`. No Node `process.memoryUsage` proxy — that would be main-process.
 *   When `C02_HEAP_CALIBRATION=1`, the fixture launch adds
 *   `--enable-precise-memory-info --js-flags=--expose-gc` so values are granular;
 *   without the flag values are bucketed and heapDelta=0 must be treated as
 *   inconclusive, not amplification 0. If the renderer heap API is unavailable,
 *   the spec fails closed with an explicit unsupported-environment result and emits
 *   NO artifact.
 * - Canonical logical payload bytes (phase4-logical-payload-v1) and heap
 *   amplification (heap delta / logical, heap used / logical) are computed
 *   separately and emitted as distinct L3 directional metrics (schema v1). A
 *   separate `heap.deltaInformative` metric/gate uses the single authoritative
 *   definition `effective = (precision === 'precise') && finite positive delta`
 *   for metric, gate, and ratio emission; bucketed positive deltas remain raw
 *   diagnostic heap.delta but are inconclusive and emitted as ratio 0 (not valid
 *   amplification). Zero, negative, non-finite, or bucketed deltas are
 *   inconclusive in all machine-readable fields. Authoritative calibration complete
 *   (`calibration.complete` metric/gate and `allocation.resident`/`productionPath.complete` gates) requires
 *   effective precise heap AND final-topic-owned #messages production DOM proof; invalid heap or fallback/global DOM never yields complete.
 * - Opt-in only: `C02_HEAP_CALIBRATION=1 pnpm test:e2e -- tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts`
 *   Plain `pnpm test:e2e` stays green (default-off, inert).
 *
 * Canonical run (fresh production build first):
 *   pnpm build
 *   C02_HEAP_CALIBRATION=1 pnpm test:e2e -- tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts
 *
 * Locks honored: ARCH-001..ARCH-012, LOCK-P5-001..005, LOCK-C01-001..006.
 * No runtime cache/window/eviction/TTL/LRU/admission/heap-capacity policy, no
 * B-01/B-02/B-05 limit selection, no threshold/closure claim.
 *
 * Evidence labeling: every metric/gate detail explicitly marks synthetic,
 * directional, non-adoption, non-threshold. Artifact is L3 directional only.
 * Measured authority is renderer Redux projection (messages entity +
 * messageIdsByTopic + blocks entity) plus derived viewport/group/context
 * projections observed via actual rendered DOM (production
 * createLatestMessageWindow / projectMessageViewportGroups / computeContextInfo);
 * not a detached synthetic array. Production path is recorded in artifact.
 */

import type { Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

import {
  type BenchmarkResult,
  collectEnvironmentMetadata,
  writeBenchmarkResult
} from '../../../../src/main/services/chatDb/__tests__/benchResult'
import { expect, test } from '../../fixtures/electron.fixture'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import {
  assertChatDbReady,
  assertTextareaReady,
  bypassOnboarding,
  launchElectronApp,
  seedMockProvider,
  waitForHomeReady,
  waitForMainElectronWindow
} from '../../utils/prepare-app'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { probeAndAssertRuntimeAppData } from '../../utils/runtime-app-data'
import { createOwnedTmpRoot, removeOwnedTmpRoot, validateProfileLaunchToken } from '../../utils/run-ownership'
import {
  buildC02BenchmarkResult,
  buildC02MixedBenchmarkResult,
  buildC02MixedSyntheticTopics,
  buildC02MixedSyntheticTopicsWithPrefix,
  buildC02MultiBenchmarkResult,
  buildC02SyntheticTopics,
  buildC02SyntheticTopicsWithPrefix,
  c02ExpectedProjectedTotalForTopics,
  c02ExpectedVisibleCountForTopic,
  c02HeapGateEnabled,
  c02MixedTotalMessages,
  C02_DEFAULT_CONTEXTCOUNT,
  C02_PRODUCTION_WINDOW_MAX,
  c02PerTopicExpectedVisibleCounts,
  canonicalBytesForTopics,
  classifyEffectiveHeapDeltaInformative,
  computeHeapAmplification,
  detectHeapPrecisionLabel,
  isC02ContextEvidenceValid,
  isC02ExactTopicOwned,
  isC02MixedHeapProfile,
  isC02ProductionPathComplete,
  isC02WholeTopicWindow,
  RENDERER_HEAP_METHOD,
  resolveC02HeapProfile,
  resolveC02HeapProfiles,
  validateHeapSample,
  validateLogicalBytes,
  validateSyntheticTopics,
  type C02HeapProfile,
  type C02MixedHeapProfile,
  type HeapPrecisionLabel,
  type LogicalPayloadTopicInput,
  type RendererHeapSample
} from '../../utils/perfHeapCalibration'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Safe canonical command recorded in artifact (no path segments). */
const CANONICAL_COMMAND = 'pnpm test:e2e'

/**
 * Bounded matrix timeout — calibration harness only, directional non-policy.
 * Single-profile (default) retains Playwright default 60s (60000).
 * Four-profile isolated matrix (C02_HEAP_CALIBRATION=all) launches 4 disposable
 * Electron apps/profiles sequentially with independent Redux/heap sampling; observed
 * 60s default timed out after 2/4 profiles (small+default) while launching large/boundary.
 * 300s (5 min) is explicit, bounded, truthful budget for the 4× isolated workload:
 * ~60s per profile for launch + production Redux projection + precise heap sampling + cleanup,
 * with headroom for CI variance and strict per-profile gates retained.
 * No separate threshold/policy/baseline adoption; matrix remains opt-in, directional only.
 */
const C02_MATRIX_TIMEOUT_MS = 300_000

/**
 * Bounded matrix helper wait — isolated production Redux projection only.
 * Single-profile retains the existing fixed 30s helper wait (legacy semantics).
 * Matrix large profile (3×150×4096B) observed to exceed 30s in an isolated
 * `page.waitForFunction` Redux wait; 60s is explicit, bounded, truthful
 * for the largest existing profile without making waits unbounded or globally
 * excessive. Used only when the matrix harness drives `activateReduxProjection`.
 * No production source, profile size, gate, or artifact change.
 */
const C02_MATRIX_WAIT_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// Renderer heap sampling — actual renderer process via performance.memory
// ---------------------------------------------------------------------------

/**
 * Sample the REAL renderer JS heap via `performance.memory` inside `page.evaluate`.
 * This runs in the renderer process, not Node main. Returns null when the API
 * is unavailable (fail-closed, no Node proxy).
 *
 * Why this is actual renderer evidence: `performance.memory` is exposed by the
 * Chromium renderer (Blink) and reports the renderer V8 heap (usedJSHeapSize,
 * totalJSHeapSize). The closure executes in the renderer via Playwright's
 * `page.evaluate`, so the numbers come from the renderer process. A Node
 * `process.memoryUsage()` proxy would report the main process and is explicitly
 * NOT used.
 *
 * Precise memory: when launched with --enable-precise-memory-info (opt-in via
 * prepare-app.ts when C02_HEAP_CALIBRATION is set) values are granular;
 * without the flag Chromium buckets values (zero delta is inconclusive).
 */
async function sampleRendererHeap(page: Page): Promise<RendererHeapSample | null> {
  return page.evaluate(() => {
    // Best-effort GC if exposed via --js-flags=--expose-gc — never required, never fails if missing.
    try {
      const w = window as unknown as Record<string, unknown>
      if (typeof w.gc === 'function') (w.gc as () => void)()
    } catch {
      // ignore
    }
    const mem = (performance as unknown as Record<string, unknown>).memory as Record<string, unknown> | undefined
    if (!mem) return null
    const used = mem.usedJSHeapSize
    const total = mem.totalJSHeapSize
    const limit = mem.jsHeapSizeLimit
    if (typeof used !== 'number' || typeof total !== 'number' || typeof limit !== 'number') return null
    if (!Number.isFinite(used) || !Number.isFinite(total) || !Number.isFinite(limit)) return null
    return {
      method: 'performance.memory',
      usedJSHeapSize: used,
      totalJSHeapSize: total,
      jsHeapSizeLimit: limit
    } as RendererHeapSample
  })
}

/**
 * Materialize synthetic projection through the EXISTING production Redux
 * projection path plus actual rendered Chat derivation (no inline replicas).
 *
 * Canonical activation path — existing typed contract + existing rendered path
 * (proven in perf101-topic-switch-measurement.spec.ts):
 * 1. Discover the live assistant ID from renderer store (`store.getState()`).
 * 2. For each synthetic topic: dispatch `assistants/addTopic` with the live
 *    assistant ID + synthetic topic metadata (existing slice), then persist via
 *    typed ChatDb IPC `ensureTopic` + `pasteMessagesToTopic` (existing Main).
 * 3. Set renderer display count via existing `newMessages/setDisplayCount` when
 *    the bounded synthetic projection exceeds the default (10) so the intended
 *    window renders.
 * 4. Click the existing visible topic item
 *    `[data-testid="topic-item"][data-topic-id="..."]` — the app's real onClick
 *    handler → HomePage setActiveTopic → useActiveTopic → loadTopicMessagesThunk
 *    → Chat/Messages production projections (createLatestMessageWindow →
 *    createMessageViewportGroupModel → projectMessageViewportGroups and
 *    computeContextInfo). No runtime/setActiveTopic, no new hook.
 * 5. Wait deterministically for Redux message IDs, loading false,
 *    DOM #messages [data-message-id] count scoped to final topic, stable group count
 *    #messages [data-stable-group-id], and context boundary #messages [data-context-boundary] inside #messages with final-topic-owned anchor
 *    as appropriate, then observe DOM. [id^="message-"] and global document queries are diagnostic-only and never satisfy complete.
 *    Retention is a tiny observation marker referencing actual rendered DOM/state, not an inline algorithm replica.
 *    If DOM groups cannot be materialized inside #messages, productionPath is not complete and
 *    the artifact fails closed or narrows claims (derived counts 0).
 *
 * Returns parity counts and production-derived DOM stats. Direct import of
 * `createMessageViewportGroupModel` etc. inside page.evaluate is impossible
 * without a production hook (Electron bundle isolation) — the rendered DOM
 * observation is the narrowest hook-free production derivation.
 */
async function activateReduxProjection(
  page: Page,
  syntheticTopics: LogicalPayloadTopicInput[],
  opts?: { waitTimeoutMs?: number }
): Promise<{
  rendererLogicalBytes: number
  topicsCreated: number
  messagesCreated: number
  blocksCreated: number
  usedTypedPath: boolean
  reduxVerified: boolean
  projectionStats: {
    reduxMessages: number
    reduxBlocks: number
    groupCount: number
    displayMessages: number
    anchorGroupKey: string | null
    contextBoundaryPresent: boolean
    contextBoundaryInsideMessages: boolean
    finalTopicDomProof: boolean
    groupExactMatched?: boolean
    contextBoundaryObservedWait?: boolean
    groupsWithFinalTopic?: number
    globalDisplayMessages: number
  }
  productionPath: string
  productionPathComplete?: boolean
  failedBlocker?: string
}> {
  // Single-source canonical activation: use the exact syntheticTopics already
  // constructed for canonicalBytesForTopics (same IDs/prefixes/payload). No
  // independent profile-based reconstruction — the canonical objects are the sole
  // message/block source for typed UI/IPC payloads.
  if (!Array.isArray(syntheticTopics) || syntheticTopics.length === 0) {
    return {
      rendererLogicalBytes: 0,
      topicsCreated: 0,
      messagesCreated: 0,
      blocksCreated: 0,
      usedTypedPath: false,
      reduxVerified: false,
      projectionStats: {
        reduxMessages: 0,
        reduxBlocks: 0,
        groupCount: 0,
        displayMessages: 0,
        anchorGroupKey: null,
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: false,
        globalDisplayMessages: 0
      },
      productionPath: 'blocked: syntheticTopics empty — no canonical input to activate',
      failedBlocker:
        'syntheticTopics empty: activation requires the same non-empty canonical topics used for canonicalBytesForTopics'
    }
  }
  const topics: Array<{
    topicId: string
    messages: Array<Record<string, unknown>>
    blocks: Array<Record<string, unknown>>
  }> = syntheticTopics.map((t) => ({
    topicId: t.topicId,
    messages: t.messages as Array<Record<string, unknown>>,
    blocks: t.blocks as Array<Record<string, unknown>>
  }))
  const messageTotal = syntheticTopics.reduce((acc, t) => acc + t.messages.length, 0)

  // Clean any legacy detached holder if present (must not be measured authority).
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    try {
      delete (w as Record<string, unknown>).__c02Resident
      delete (w as Record<string, unknown>).__c02ResidentTopics
      delete (w as Record<string, unknown>).__c02ProjectionRetention
    } catch {
      // ignore
    }
  })

  // Discover the live assistant id from renderer store (canonical production ownership)
  const liveAssistantId = await page.evaluate(
    () =>
      (window as any).store.getState().assistants?.assistants?.[0]?.id ??
      (window as any).store.getState().assistants?.defaultAssistant?.id ??
      null
  )
  if (!liveAssistantId) {
    return {
      rendererLogicalBytes: 0,
      topicsCreated: 0,
      messagesCreated: 0,
      blocksCreated: 0,
      usedTypedPath: false,
      reduxVerified: false,
      projectionStats: {
        reduxMessages: 0,
        reduxBlocks: 0,
        groupCount: 0,
        displayMessages: 0,
        anchorGroupKey: null,
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: false,
        globalDisplayMessages: 0
      },
      productionPath:
        'blocked: live assistant id unavailable from renderer store — cannot dispatch assistants/addTopic without production hook',
      failedBlocker:
        'live assistant id unavailable: renderer store has no assistants[0].id — cannot register synthetic topic via canonical path'
    }
  }

  // Step 1: dispatch assistants/addTopic with live assistant ID + persist via typed ChatDb
  let usedTypedPath = false
  for (const t of topics) {
    // Register in assistants state so the sidebar renders the topic
    const addOk = await page.evaluate(
      async ({ topicId, assistantId, name }) => {
        try {
          const store = (window as any).store
          if (!store || typeof store.dispatch !== 'function') return { ok: false, err: 'store missing' }
          store.dispatch({
            type: 'assistants/addTopic',
            payload: {
              assistantId,
              topic: {
                id: topicId,
                assistantId,
                name,
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z'
              }
            }
          })
          return { ok: true }
        } catch (e) {
          return { ok: false, err: e instanceof Error ? e.message : String(e) }
        }
      },
      { topicId: t.topicId, assistantId: liveAssistantId, name: `C02 Heap ${t.topicId}` }
    )
    if (!addOk.ok) {
      return {
        rendererLogicalBytes: 0,
        topicsCreated: 0,
        messagesCreated: 0,
        blocksCreated: 0,
        usedTypedPath: false,
        reduxVerified: false,
        projectionStats: {
          reduxMessages: 0,
          reduxBlocks: 0,
          groupCount: 0,
          displayMessages: 0,
          anchorGroupKey: null,
          contextBoundaryPresent: false,
          contextBoundaryInsideMessages: false,
          finalTopicDomProof: false,
          globalDisplayMessages: 0
        },
        productionPath: 'blocked: assistants/addTopic dispatch failed',
        failedBlocker: `assistants/addTopic failed for ${t.topicId}: ${addOk.err}`
      }
    }

    // Ensure topic exists in Main via typed ChatDb bridge, then paste messages
    const persist = await page.evaluate(
      async ({ topicId, assistantId, name, entries }) => {
        try {
          const api = (window as unknown as Record<string, unknown>).api as Record<string, unknown> | undefined
          const chatDb = api?.chatDb as Record<string, (arg: unknown) => Promise<unknown>> | undefined
          if (
            !chatDb ||
            typeof chatDb.ensureTopic !== 'function' ||
            typeof chatDb.pasteMessagesToTopic !== 'function'
          ) {
            return { ok: false, err: 'chatDb missing' }
          }
          const ensured = (await chatDb.ensureTopic({ topicId, assistantId, name })) as unknown as {
            ok: boolean
            error?: unknown
          }
          if (!ensured || ensured.ok !== true)
            return { ok: false, err: `ensureTopic failed ${JSON.stringify(ensured)}` }
          const pasted = (await chatDb.pasteMessagesToTopic({ topicId, entries })) as unknown as {
            ok: boolean
            error?: unknown
          }
          if (!pasted || pasted.ok !== true) return { ok: false, err: `paste failed ${JSON.stringify(pasted)}` }
          return { ok: true }
        } catch (e) {
          return { ok: false, err: e instanceof Error ? e.message : String(e) }
        }
      },
      {
        topicId: t.topicId,
        assistantId: liveAssistantId,
        name: `C02 Heap ${t.topicId}`,
        entries: t.messages.map((m) => {
          const bid = (m.blocks as string[])[0]!
          const block = t.blocks.find((b) => String(b.id) === bid)!
          return { message: m, blocks: [block] }
        })
      }
    )
    if (!persist.ok) {
      return {
        rendererLogicalBytes: 0,
        topicsCreated: topics.length,
        messagesCreated: messageTotal,
        blocksCreated: 0,
        usedTypedPath: false,
        reduxVerified: false,
        projectionStats: {
          reduxMessages: 0,
          reduxBlocks: 0,
          groupCount: 0,
          displayMessages: 0,
          anchorGroupKey: null,
          contextBoundaryPresent: false,
          contextBoundaryInsideMessages: false,
          finalTopicDomProof: false,
          globalDisplayMessages: 0
        },
        productionPath: 'blocked: ChatDb persist failed via ensureTopic/pasteMessagesToTopic',
        failedBlocker: `typed ChatDb persist failed for ${t.topicId}: ${persist.err}`
      }
    }
  }
  usedTypedPath = true

  // Step 2: set display count with existing newMessages/setDisplayCount if required
  // Bounded synthetic projection: each canonical topic has messages.length messages;
  // default displayCount is 10, so raise to the max per-topic count to render the full window.
  // Heterogeneous distributions use max per-topic messageCount — derived strictly from
  // the same canonical syntheticTopics that feed canonicalBytesForTopics.
  const desiredDisplayCount = Math.max(...syntheticTopics.map((t) => t.messages.length))
  if (desiredDisplayCount !== 10) {
    await page.evaluate((capacity) => {
      const store = (window as any).store
      store.dispatch({ type: 'newMessages/setDisplayCount', payload: capacity })
    }, desiredDisplayCount)
    const actual = await page.evaluate(() => (window as any).store.getState().messages?.displayCount)
    if (actual !== desiredDisplayCount) {
      return {
        rendererLogicalBytes: 0,
        topicsCreated: topics.length,
        messagesCreated: messageTotal,
        blocksCreated: messageTotal,
        usedTypedPath,
        reduxVerified: false,
        projectionStats: {
          reduxMessages: 0,
          reduxBlocks: 0,
          groupCount: 0,
          displayMessages: 0,
          anchorGroupKey: null,
          contextBoundaryPresent: false,
          contextBoundaryInsideMessages: false,
          finalTopicDomProof: false,
          globalDisplayMessages: 0
        },
        productionPath: 'blocked: setDisplayCount verification failed',
        failedBlocker: `newMessages/setDisplayCount failed: expected ${desiredDisplayCount}, got ${String(actual)}`
      }
    }
  }

  const lastTopicId = topics[topics.length - 1]?.topicId ?? ''
  // Production latest-window clamp (1..100) — calibration measures actual production
  // projection, not invented larger window. Large profile retains 150 messages logically
  // (canonicalBytes deterministically on full 150) but latest window projects 100.
  // Use shared canonical-topic helpers for per-topic expected counts under the clamp.
  // Each topic wait derives its own expected from its specific canonical topic;
  // final-topic-specific expected retained only for final ownership checks.
  const perTopicExpectedVisible = c02PerTopicExpectedVisibleCounts(syntheticTopics)
  const expectedProjectedTotal = c02ExpectedProjectedTotalForTopics(syntheticTopics)
  const expectedVisibleFinal = c02ExpectedVisibleCountForTopic(syntheticTopics[syntheticTopics.length - 1]!)
  // Matrix-only bounded wait for the largest existing profile (3×150×4096B).
  // Single-profile retains legacy 30s; matrix caller passes C02_MATRIX_WAIT_TIMEOUT_MS (60s).
  const helperWaitTimeoutMs = opts?.waitTimeoutMs ?? 30_000

  // Step 3: canonical activation via existing rendered topic-item clicks — one click per synthetic topic
  // so all synthetic topics become resident in Redux via the production loadTopicMessagesThunk path
  // (HomePage → useActiveTopic → loadTopicMessagesThunk). Each click waits deterministically for
  // Redux IDs, loading false, and topic-scoped DOM proof (existing [data-message-id]
  // attributes tied to the clicked synthetic topic id) with per-topic expected count under the production window clamp.
  // No global count can satisfy completeness — the final topic must demonstrably own the measured DOM.
  for (let topicIdx = 0; topicIdx < topics.length; topicIdx++) {
    const topic = topics[topicIdx]!
    const topicId = topic.topicId
    const topicExpected = perTopicExpectedVisible[topicIdx]!
    try {
      const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
      await item.waitFor({ state: 'attached', timeout: 15000 })
      await item.scrollIntoViewIfNeeded()
      await item.waitFor({ state: 'visible', timeout: 15000 })
      await item.click()
    } catch (e) {
      return {
        rendererLogicalBytes: 0,
        topicsCreated: topics.length,
        messagesCreated: messageTotal,
        blocksCreated: messageTotal,
        usedTypedPath,
        reduxVerified: false,
        projectionStats: {
          reduxMessages: 0,
          reduxBlocks: 0,
          groupCount: 0,
          displayMessages: 0,
          anchorGroupKey: null,
          contextBoundaryPresent: false,
          contextBoundaryInsideMessages: false,
          finalTopicDomProof: false,
          globalDisplayMessages: 0
        },
        productionPath: 'blocked: topic-item click failed — sidebar item not interactable',
        failedBlocker: `canonical topic-item click failed for ${topicId}: ${e instanceof Error ? e.message : String(e)}`
      }
    }
    try {
      await page.waitForFunction(
        ({ topicId, expected }) => {
          const s = (window as any).store.getState()
          const ids = s.messages?.messageIdsByTopic?.[topicId]
          const loading = s.messages?.loadingByTopic?.[topicId]
          return Array.isArray(ids) && ids.length === expected && loading !== true
        },
        { topicId, expected: topicExpected },
        { timeout: helperWaitTimeoutMs }
      )
    } catch (e) {
      return {
        rendererLogicalBytes: 0,
        topicsCreated: topics.length,
        messagesCreated: messageTotal,
        blocksCreated: messageTotal,
        usedTypedPath,
        reduxVerified: false,
        projectionStats: {
          reduxMessages: 0,
          reduxBlocks: 0,
          groupCount: 0,
          displayMessages: 0,
          anchorGroupKey: null,
          contextBoundaryPresent: false,
          contextBoundaryInsideMessages: false,
          finalTopicDomProof: false,
          globalDisplayMessages: 0
        },
        productionPath: 'blocked: Redux messageIdsByTopic / loading wait timed out after topic-item click',
        failedBlocker: `Redux wait failed for ${topicId}: ${e instanceof Error ? e.message : String(e)}`
      }
    }
    try {
      await page.waitForFunction(
        ({ topicId, expected }) => {
          // Strict topic-scoped DOM proof: only production #messages [data-message-id] selectors.
          // [id^="message-"] is diagnostic-only and never satisfies authoritative wait/complete.
          // Per-topic expected ensures heterogeneous 20/50/100/150 shapes do not timeout on early topics.
          const globalData = document.querySelectorAll('#messages [data-message-id]').length
          const scopedData = document.querySelectorAll(`#messages [data-message-id^="${topicId}-msg-"]`).length
          return scopedData === expected && globalData === expected
        },
        { topicId, expected: topicExpected },
        { timeout: helperWaitTimeoutMs }
      )
    } catch (e) {
      return {
        rendererLogicalBytes: 0,
        topicsCreated: topics.length,
        messagesCreated: messageTotal,
        blocksCreated: messageTotal,
        usedTypedPath,
        reduxVerified: false,
        projectionStats: {
          reduxMessages: 0,
          reduxBlocks: 0,
          groupCount: 0,
          displayMessages: 0,
          anchorGroupKey: null,
          contextBoundaryPresent: false,
          contextBoundaryInsideMessages: false,
          finalTopicDomProof: false,
          globalDisplayMessages: 0
        },
        productionPath: 'blocked: DOM message count wait timed out after topic-item click',
        failedBlocker: `DOM #messages [data-message-id] scoped wait failed for ${topicId}: expected ${topicExpected} visible messages owned by that topic (global===scoped===expected); [id^="message-"] is diagnostic-only and not authoritative: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  // Stable groups: exact expected count required for productionPath complete.
  // Authoritative proof is strictly #messages [data-stable-group-id]; arbitrary non-zero fallback may NOT satisfy complete — it is diagnostic only and forces partial/inconclusive.
  let groupExactMatched = false
  try {
    await page.waitForFunction(
      (expected) => document.querySelectorAll('#messages [data-stable-group-id]').length === expected,
      expectedVisibleFinal,
      { timeout: 15000 }
    )
    groupExactMatched = true
  } catch {
    groupExactMatched = false
    // Diagnostic fallback: observe whether ANY groups materialized inside #messages, without claiming completeness.
    await page
      .waitForFunction(() => document.querySelectorAll('#messages [data-stable-group-id]').length > 0, undefined, {
        timeout: 5000
      })
      .catch(() => {})
  }

  // Deterministic context-boundary observation: wait for the divider that the production
  // projection emits inside #messages ([data-context-boundary]). Presence is explicit and
  // must be inside #messages; absence is not converted to a fake anchor. This wait is
  // best-effort — final evaluation marks context evidence unavailable when absent and makes
  // productionPath partial/inconclusive.
  let boundaryObserved = false
  try {
    await page.waitForFunction(() => !!document.querySelector('#messages [data-context-boundary]'), undefined, {
      timeout: 5000
    })
    boundaryObserved = true
  } catch {
    boundaryObserved = false
  }
  // Keep for narrowing detail (diagnostic, never satisfies complete)
  void groupExactMatched
  void boundaryObserved

  // Verify Redux residency post-activation (useActiveTopic → loadTopicMessagesThunk path)
  const reduxInfo = await page.evaluate(
    (topicIds) => {
      const s = (window as any).store.getState()
      const messageIdsByTopic = (s.messages?.messageIdsByTopic ?? {}) as Record<string, string[]>
      const blockEntities = (s.messageBlocks?.entities ?? {}) as Record<string, unknown>
      let reduxMessages = 0
      for (const id of topicIds) reduxMessages += messageIdsByTopic[id]?.length ?? 0
      return { reduxMessages, reduxBlocks: Object.keys(blockEntities).length }
    },
    topics.map((t) => t.topicId)
  )
  // Latest-window projection: Redux holds windowed count (e.g. 100 for large 150) while
  // canonical logicalBytes retain full 150 per topic as retained payload denominator.
  // Large therefore demonstrates truncated projection (hasMoreBefore true via window completeness).
  const reduxVerified =
    reduxInfo.reduxMessages === expectedProjectedTotal && reduxInfo.reduxBlocks >= expectedProjectedTotal

  // Observe derived projections via actual rendered DOM (production path) — final-topic-scoped, boundary-explicit.
  // Authoritative proof is strictly #messages [data-*] production selectors; [id^="message-"] is diagnostic-only and never satisfies complete.
  const domStats = await page.evaluate((lastTopicId) => {
    const root = document.querySelector('#messages')
    const groupEls = document.querySelectorAll('#messages [data-stable-group-id]')
    const domGroupCount = groupEls.length

    // Strict production selectors — authoritative counts use only #messages [data-message-id]
    const scopedData = document.querySelectorAll(`#messages [data-message-id^="${lastTopicId}-msg-"]`).length
    const globalData = document.querySelectorAll('#messages [data-message-id]').length
    // Diagnostic fallback selectors — never feed authoritative complete predicate
    const diagnosticScopedAlt = document.querySelectorAll(`[id^="message-${lastTopicId}-msg-"]`).length
    const diagnosticGlobalAlt = document.querySelectorAll('[id^="message-"]').length
    const domDisplayMessagesScoped = scopedData
    const domDisplayMessagesGlobal = globalData

    // Groups that contain the final topic's messages (proof that groups are not stale) — strictly production group selectors
    // Collision-safe exact ownership: gid must contain topicId as exact token with boundary (not substring prefix like c02-heap-topic-01 inside c02-heap-topic-011)
    function isExactTopicOwnedLocal(anchor: string | null, topicId: string): boolean {
      if (anchor === null || typeof anchor !== 'string' || typeof topicId !== 'string') return false
      if (anchor.length === 0 || topicId.length === 0) return false
      let idx = anchor.indexOf(topicId)
      while (idx !== -1) {
        const beforeChar = idx > 0 ? anchor[idx - 1] : ''
        const beforeOk =
          idx === 0 ||
          beforeChar === ':' ||
          beforeChar === '|' ||
          beforeChar === '-' ||
          beforeChar === '_' ||
          !/[A-Za-z0-9]/.test(beforeChar)
        const afterIdx = idx + topicId.length
        const afterChar = afterIdx < anchor.length ? anchor[afterIdx] : ''
        const afterOk =
          afterIdx === anchor.length || afterChar === '-' || afterChar === ':' || afterChar === '|' || afterChar === '_'
        if (beforeOk && afterOk) return true
        idx = anchor.indexOf(topicId, idx + 1)
      }
      return false
    }
    let groupsWithFinalTopic = 0
    for (let i = 0; i < groupEls.length; i++) {
      const el = groupEls[i] as HTMLElement
      const gid = el.getAttribute('data-stable-group-id') ?? ''
      if (isExactTopicOwnedLocal(gid, lastTopicId)) {
        groupsWithFinalTopic++
        continue
      }
      // Strict descendant check — only [data-message-id], never [id^="message-"] for authoritative ownership
      // This selector `^=` is already exact boundary-safe (topicId + '-msg-')
      const hasDesc = el.querySelector(`[data-message-id^="${lastTopicId}-msg-"]`) !== null
      if (hasDesc) groupsWithFinalTopic++
    }

    // Strict context boundary — must be inside #messages subtree; anchor must be final-topic-owned
    // Improved: detect ALL boundary elements and reject if ANY lies outside #messages even when valid inside exists (simultaneous inside+outside false-positive fix)
    let anchorGroupKey: string | null = null
    let contextBoundaryPresent = false
    let contextBoundaryInsideMessages = false
    const allBoundaries = document.querySelectorAll('[data-context-boundary]')
    const insideBoundaries = document.querySelectorAll('#messages [data-context-boundary]')
    const hasOutside = Array.from(allBoundaries).some((el) => !el.closest('#messages'))
    if (hasOutside) {
      // Any divider outside #messages invalidates evidence even when inside valid divider exists — fail-closed mixed rejection per LOCK-004
      contextBoundaryPresent = true
      contextBoundaryInsideMessages = false
      anchorGroupKey = null
    } else if (insideBoundaries.length > 0 && root && root.contains(insideBoundaries[0] as Element)) {
      const boundary = insideBoundaries[0] as Element
      contextBoundaryPresent = true
      contextBoundaryInsideMessages = true
      let prev = boundary.previousElementSibling
      let found: string | null = null
      let hops = 0
      while (prev && hops < 20) {
        const gid = (prev as HTMLElement).getAttribute('data-stable-group-id')
        if (gid) {
          found = gid
          break
        }
        const inner = prev.querySelector('[data-stable-group-id]')
        if (inner) {
          const innerGid = inner.getAttribute('data-stable-group-id')
          if (innerGid) {
            found = innerGid
            break
          }
        }
        prev = prev.previousElementSibling
        hops++
      }
      anchorGroupKey = found
    } else {
      // No divider anywhere — valid only for whole-topic <=25 with null anchor; empty allBoundaries also falls here (no outside, no inside)
      contextBoundaryPresent = false
      contextBoundaryInsideMessages = false
      anchorGroupKey = null
    }

    return {
      domGroupCount,
      domDisplayMessagesScoped,
      domDisplayMessagesGlobal,
      diagnosticScopedAlt,
      diagnosticGlobalAlt,
      groupsWithFinalTopic,
      anchorGroupKey,
      contextBoundaryPresent,
      contextBoundaryInsideMessages
    }
  }, lastTopicId)

  // Authoritative productionPath lock: complete ONLY when final-topic-owned #messages production selectors,
  // exact expected DOM counts, and context evidence (strict divider with ownership OR valid whole-topic absent) passes.
  // Fallback [id^="message-"], global document queries, or arbitrary non-zero fallbacks never satisfy complete outside whole-topic.
  const finalTopicDomProof =
    domStats.domDisplayMessagesScoped === expectedVisibleFinal &&
    domStats.domDisplayMessagesGlobal === expectedVisibleFinal
  const groupCountExact = domStats.domGroupCount === expectedVisibleFinal
  const groupOwnershipProof = domStats.groupsWithFinalTopic === expectedVisibleFinal && groupCountExact
  const anchorOwnedByFinalTopic = isC02ExactTopicOwned(domStats.anchorGroupKey, lastTopicId)
  const isWholeTopic = isC02WholeTopicWindow(expectedVisibleFinal)
  const wholeTopicNoDividerValid =
    isWholeTopic &&
    !domStats.contextBoundaryPresent &&
    !domStats.contextBoundaryInsideMessages &&
    domStats.anchorGroupKey === null
  const contextEvidenceOk = isC02ContextEvidenceValid({
    contextBoundaryPresent: domStats.contextBoundaryPresent,
    contextBoundaryInsideMessages: domStats.contextBoundaryInsideMessages,
    anchorGroupKey: domStats.anchorGroupKey,
    lastTopicId,
    expectedVisibleFinal
  })
  const productionPathComplete = isC02ProductionPathComplete({
    reduxVerified,
    finalTopicDomProof,
    groupCountExact,
    groupOwnershipProof,
    contextBoundaryPresent: domStats.contextBoundaryPresent,
    contextBoundaryInsideMessages: domStats.contextBoundaryInsideMessages,
    anchorGroupKey: domStats.anchorGroupKey,
    lastTopicId,
    expectedVisibleFinal
  })

  let productionPathDetail: string
  if (productionPathComplete) {
    if (wholeTopicNoDividerValid) {
      productionPathDetail = `canonical user path complete: assistants/addTopic (live assistant ID) → ChatDb ensureTopic/pasteMessagesToTopic → newMessages/setDisplayCount (when required) → [data-testid="topic-item"][data-topic-id="${lastTopicId}"] click → HomePage setActiveTopic → useActiveTopic → loadTopicMessagesThunk → Chat/Messages production projections (createLatestMessageWindow → createMessageViewportGroupModel → projectMessageViewportGroups + computeContextInfo) observed via DOM #messages [data-stable-group-id]/[data-message-id] (no [data-context-boundary] by design — whole-topic window ${expectedVisibleFinal} <= ${C02_DEFAULT_CONTEXTCOUNT} turns, divider absent is valid); productionPath complete — finalTopic=${lastTopicId} owns #messages DOM (scoped ${domStats.domDisplayMessagesScoped}/${expectedVisibleFinal}, global ${domStats.domDisplayMessagesGlobal}/${expectedVisibleFinal} via #messages [data-message-id]), groups exact ${domStats.domGroupCount}/${expectedVisibleFinal} (owned ${domStats.groupsWithFinalTopic}/${expectedVisibleFinal} via #messages [data-stable-group-id]), whole-topic context valid (no divider, anchor null by design)`
    } else {
      productionPathDetail = `canonical user path complete: assistants/addTopic (live assistant ID) → ChatDb ensureTopic/pasteMessagesToTopic → newMessages/setDisplayCount (when required) → [data-testid="topic-item"][data-topic-id="${lastTopicId}"] click → HomePage setActiveTopic → useActiveTopic → loadTopicMessagesThunk → Chat/Messages production projections (createLatestMessageWindow → createMessageViewportGroupModel → projectMessageViewportGroups + computeContextInfo) observed via DOM #messages [data-stable-group-id]/[data-message-id]/[data-context-boundary]; productionPath complete — finalTopic=${lastTopicId} owns #messages DOM (scoped ${domStats.domDisplayMessagesScoped}/${expectedVisibleFinal}, global ${domStats.domDisplayMessagesGlobal}/${expectedVisibleFinal} via #messages [data-message-id]), groups exact ${domStats.domGroupCount}/${expectedVisibleFinal} (owned ${domStats.groupsWithFinalTopic}/${expectedVisibleFinal} via #messages [data-stable-group-id]), contextBoundary inside #messages anchor=${domStats.anchorGroupKey} (final-topic-owned, [id^="message-"] fallback diagnostic-only excluded)`
    }
  } else {
    const reasons: string[] = []
    if (!reduxVerified)
      reasons.push(
        `Redux unverified (reduxMessages=${reduxInfo.reduxMessages}/${messageTotal}, reduxBlocks=${reduxInfo.reduxBlocks}/${messageTotal})`
      )
    if (!finalTopicDomProof)
      reasons.push(
        `final-topic DOM proof failed for ${lastTopicId} (scoped ${domStats.domDisplayMessagesScoped}/${expectedVisibleFinal}, global ${domStats.domDisplayMessagesGlobal}/${expectedVisibleFinal} — global/stale or partial cannot satisfy complete)`
      )
    if (!groupCountExact)
      reasons.push(
        `group count not exact (observed ${domStats.domGroupCount}/${expectedVisibleFinal} — arbitrary non-zero fallback cannot satisfy complete; diagnostic groupsWithFinalTopic=${domStats.groupsWithFinalTopic})`
      )
    else if (!groupOwnershipProof)
      reasons.push(
        `group ownership failed (groupsWithFinalTopic ${domStats.groupsWithFinalTopic}/${expectedVisibleFinal} — groups do not demonstrably belong to final topic)`
      )
    if (!contextEvidenceOk) {
      if (isWholeTopic && !domStats.contextBoundaryPresent && domStats.anchorGroupKey === null) {
        // Whole-topic absent is valid, but we are here only when contextEvidenceOk false,
        // so this branch should not happen for valid whole-topic; treat as inconclusive due to other evidence
        reasons.push(
          `whole-topic divider absent but context evidence still invalid for ${lastTopicId} (unexpected — isWholeTopic=${isWholeTopic} expectedVisible=${expectedVisibleFinal} present=${domStats.contextBoundaryPresent} anchor=${domStats.anchorGroupKey ?? 'null'})`
        )
      } else if (!domStats.contextBoundaryPresent)
        reasons.push(
          '[data-context-boundary] absent inside #messages — context evidence unavailable (global boundary outside #messages or missing; not inferred from first group; partial/inconclusive outside whole-topic <=25; diagnostic alt counts not authoritative)'
        )
      else if (!domStats.contextBoundaryInsideMessages)
        reasons.push(
          '[data-context-boundary] found globally but not inside #messages subtree — strict proof requires #messages [data-context-boundary]; inconclusive'
        )
      else if (!domStats.anchorGroupKey)
        reasons.push(
          'context boundary present inside #messages but anchorGroupKey unresolvable (no predecessor [data-stable-group-id]; inconclusive)'
        )
      else if (!anchorOwnedByFinalTopic)
        reasons.push(
          `context boundary anchor not final-topic-owned (anchor=${domStats.anchorGroupKey} does not contain ${lastTopicId}; explicit final-topic ownership required; diagnostic [id^="message-"] fallback never satisfies complete)`
        )
    }
    productionPathDetail = `canonical user path attempted: assistants/addTopic (live assistant ID) → ChatDb → [data-testid="topic-item"][data-topic-id="${lastTopicId}"] click → HomePage/useActiveTopic → loadTopicMessagesThunk → Messages/Chat; productionPath partial/inconclusive — ${reasons.join('; ')}; heap delta reflects Redux entity only when DOM incomplete, derived counts narrowed (inconclusive group/context)`
  }

  // Minimal retention marker referencing actual rendered DOM/state (not replica)
  await page.evaluate(
    ({
      reduxMessages,
      reduxBlocks,
      domGroupCount,
      domDisplayMessagesScoped,
      domDisplayMessagesGlobal,
      anchorGroupKey,
      lastTopicId,
      contextBoundaryPresent,
      finalTopicDomProof,
      groupsWithFinalTopic
    }) => {
      const w = window as unknown as Record<string, unknown>
      ;(w as Record<string, unknown>).__c02ProjectionRetention = {
        reduxMessages,
        reduxBlocks,
        domGroupCount,
        domDisplayMessagesScoped,
        domDisplayMessagesGlobal,
        domDisplayMessages: domDisplayMessagesScoped,
        anchorGroupKey,
        contextBoundaryPresent,
        finalTopicDomProof,
        groupsWithFinalTopic,
        lastTopicId,
        ts: Date.now()
      }
    },
    {
      reduxMessages: reduxInfo.reduxMessages,
      reduxBlocks: reduxInfo.reduxBlocks,
      domGroupCount: domStats.domGroupCount,
      domDisplayMessagesScoped: domStats.domDisplayMessagesScoped,
      domDisplayMessagesGlobal: domStats.domDisplayMessagesGlobal,
      anchorGroupKey: domStats.anchorGroupKey,
      contextBoundaryPresent: domStats.contextBoundaryPresent,
      finalTopicDomProof,
      groupsWithFinalTopic: domStats.groupsWithFinalTopic,
      lastTopicId
    }
  )

  // Renderer logical bytes parity estimate (directional, non-canonical)
  let rendererLogicalBytes = 0
  try {
    const json = JSON.stringify(topics)
    rendererLogicalBytes = new TextEncoder().encode(json).length
  } catch {
    rendererLogicalBytes = 0
  }

  return {
    rendererLogicalBytes,
    topicsCreated: topics.length,
    messagesCreated: messageTotal,
    blocksCreated: messageTotal,
    usedTypedPath,
    reduxVerified,
    projectionStats: {
      reduxMessages: reduxInfo.reduxMessages,
      reduxBlocks: reduxInfo.reduxBlocks,
      groupCount: domStats.domGroupCount,
      displayMessages: domStats.domDisplayMessagesScoped,
      anchorGroupKey: domStats.anchorGroupKey,
      contextBoundaryPresent: domStats.contextBoundaryPresent,
      contextBoundaryInsideMessages: domStats.contextBoundaryInsideMessages,
      finalTopicDomProof,
      groupExactMatched: groupCountExact,
      groupsWithFinalTopic: domStats.groupsWithFinalTopic,
      globalDisplayMessages: domStats.domDisplayMessagesGlobal
    },
    productionPath: productionPathDetail,
    productionPathComplete
  }
}

// ---------------------------------------------------------------------------
// Spec — default-off, opt-in, inert to normal runs
// ---------------------------------------------------------------------------

test.describe('PERF-C02 renderer heap calibration (measurement-only, directional synthetic)', () => {
  // Default-off: plain `pnpm test:e2e` stays green. Opt-in only.
  test.skip(!c02HeapGateEnabled(), 'C02 heap calibration is opt-in: set C02_HEAP_CALIBRATION=1 to run')

  test('samples actual renderer heap and emits schema-v1 directional artifact', async ({
    mainWindow,
    electronApp,
    mockPort
  }) => {
    // Resolve profiles (fail-loud on bad env — no silent skip). Single-profile "1"/"true" preserved; matrix via "all"/"matrix".
    const profiles = (() => {
      try {
        return resolveC02HeapProfiles()
      } catch {
        return [{ id: 'c02-default-v1', profile: resolveC02HeapProfile() }]
      }
    })()
    const isMatrix = profiles.length > 1
    if (isMatrix) {
      // Bounded harness budget for the observed 4-profile isolated workload. Applies
      // before any isolated app launch/activation so the timeout governs the full matrix;
      // single-profile retains Playwright default 60s (no elevation here).
      test.setTimeout(C02_MATRIX_TIMEOUT_MS)
    }

    if (!isMatrix) {
      const entry = profiles[0]!
      const profile = entry.profile
      const isMixedSingle = isC02MixedHeapProfile(profile)

      // Deterministic synthetic topics — canonical logical bytes (phase4-logical-payload-v1)
      // Mixed single must use heterogeneous mixed builder so C02_HEAP_CALIBRATION=mixed-* creates true heterogeneous workload.
      const syntheticTopics = isMixedSingle
        ? buildC02MixedSyntheticTopicsWithPrefix(profile as C02MixedHeapProfile, 'c02-mixed-topic')
        : buildC02SyntheticTopics(profile as C02HeapProfile)
      const synthProblems = validateSyntheticTopics(syntheticTopics)
      expect(synthProblems, `synthetic topics must canonicalize: ${synthProblems.join('; ')}`).toEqual([])
      const logicalBytes = canonicalBytesForTopics(syntheticTopics)
      expect(validateLogicalBytes(logicalBytes), 'canonical logical bytes must be finite positive').toEqual([])

      // Sample heap BEFORE activation — actual renderer process
      const heapBefore = await sampleRendererHeap(mainWindow)
      const beforeProblems = validateHeapSample(heapBefore)
      if (heapBefore === null) {
        // Fail closed: actual renderer heap API unavailable — no artifact, explicit blocker
        throw new Error(
          `[PERF-C02] heap calibration unsupported: performance.memory not available in this renderer/Chromium build (method=${RENDERER_HEAP_METHOD}). No artifact emitted. This is the expected blocker when the renderer heap cannot be sampled without production changes; do not substitute a Node main-native heap proxy.`
        )
      }
      expect(beforeProblems, `heap before sample must be valid: ${beforeProblems.join('; ')}`).toEqual([])

      // Activate Redux projection via existing production path + actual rendered Chat derivation
      // Bounded correction: pass the exact same syntheticTopics used for canonicalBytesForTopics
      // (single source) — no prefix default/mutation; IDs match accounting.
      const allocation = await activateReduxProjection(mainWindow, syntheticTopics)
      if (allocation.failedBlocker) {
        throw new Error(
          `[PERF-C02] heap calibration blocked: ${allocation.failedBlocker}. No artifact emitted — this is fail-closed per decision rights; do not retain detached holder or Node proxy.`
        )
      }
      if (isMixedSingle) {
        const mixed = profile as C02MixedHeapProfile
        expect(allocation.topicsCreated, 'synthetic topics must be created in renderer (mixed)').toBe(
          mixed.topicSpecs.length
        )
        expect(allocation.messagesCreated, 'synthetic messages must be created in renderer (mixed)').toBe(
          c02MixedTotalMessages(mixed)
        )
      } else {
        const uniform = profile as C02HeapProfile
        expect(allocation.topicsCreated, 'synthetic topics must be created in renderer').toBe(uniform.syntheticTopics)
        expect(allocation.messagesCreated, 'synthetic messages must be created in renderer').toBe(
          uniform.syntheticTopics * uniform.syntheticMessagesPerTopic
        )
      }
      expect(allocation.reduxVerified, 'Redux entity projection must be verified resident (messages + blocks)').toBe(
        true
      )
      // Cross-check: synthetic topic is registered in assistants state with live assistant ID (acceptance 1)
      const finalTopicId = syntheticTopics[syntheticTopics.length - 1]!.topicId
      const assistantCheck = await mainWindow.evaluate((topicId) => {
        const s = (window as unknown as Record<string, unknown>).store as
          | { getState: () => Record<string, unknown> }
          | undefined
        const state = s?.getState() as Record<string, unknown> | undefined
        const assistants = ((state?.assistants as Record<string, unknown> | undefined)?.assistants ?? []) as Array<{
          id: string
          topics: Array<{ id: string }>
        }>
        for (const a of assistants) {
          if (a.topics.some((t) => t.id === topicId)) return { found: true, assistantId: a.id }
        }
        return { found: false, assistantId: null }
      }, finalTopicId)
      expect(
        assistantCheck.found,
        'measured synthetic topic must be registered in assistants state with live assistant ID'
      ).toBe(true)

      // Final-topic DOM proof — strict #messages production selectors must own the measured DOM; fallback/global stale counts never satisfy.
      // Audit lock: productionPath complete only when final-topic identity inside #messages, exact expected #messages DOM messages/groups,
      // and context-boundary inside #messages with final-topic-owned anchor all pass; [id^="message-"] fallback and global queries cannot satisfy it.
      // Authoritative calibration complete additionally requires effective precise heap (checked after heap sampling).
      const expectedSingleVisible = c02ExpectedVisibleCountForTopic(syntheticTopics[syntheticTopics.length - 1]!)
      expect(
        allocation.projectionStats.finalTopicDomProof,
        `final-topic DOM proof must be true for ${finalTopicId} via #messages [data-message-id]: scoped ${allocation.projectionStats.displayMessages} vs global ${allocation.projectionStats.globalDisplayMessages} vs expected ${expectedSingleVisible} (min(N, productionWindow ${C02_PRODUCTION_WINDOW_MAX}) — retains 150 logically but projects 100 for large; scoped===global===expected inside #messages required; global/stale or [id^="message-"] fallback is not proof)`
      ).toBe(true)
      expect(
        allocation.projectionStats.groupCount,
        `stable group count inside #messages must be exact expectedVisible (${expectedSingleVisible}) via #messages [data-stable-group-id] — arbitrary non-zero fallback cannot produce complete evidence; global [data-stable-group-id] never authoritative`
      ).toBe(expectedSingleVisible)
      expect(
        allocation.projectionStats.groupsWithFinalTopic,
        `groups must demonstrably belong to final topic ${finalTopicId} via #messages [data-stable-group-id]/[data-message-id] (groupsWithFinalTopic === expectedVisible ${expectedSingleVisible}); [id^="message-"] descendant never satisfies`
      ).toBe(expectedSingleVisible)
      // Context evidence per LOCK-004 (fail-closed, explicit inside-messages signal mandatory): whole-topic windows (positive integer 1..25) require no divider anywhere + null anchor (valid absent), partial windows require divider inside #messages + final-owned anchor (valid present); outside/global invalid
      const isWholeTopicSingle = isC02WholeTopicWindow(expectedSingleVisible)
      if (isWholeTopicSingle) {
        expect(
          allocation.projectionStats.contextBoundaryPresent,
          `whole-topic window ${expectedSingleVisible} <= ${C02_DEFAULT_CONTEXTCOUNT} must have no divider by design (boundaryMessageId null when startIndex 0) — contextBoundaryPresent must be false`
        ).toBe(false)
        expect(
          allocation.projectionStats.contextBoundaryInsideMessages,
          `whole-topic window ${expectedSingleVisible} <= ${C02_DEFAULT_CONTEXTCOUNT} must have no divider anywhere by design — contextBoundaryInsideMessages must be false (explicit inside signal mandatory per LOCK-004; whole-topic 1..25 no-divider/null-anchor branch)`
        ).toBe(false)
        expect(
          allocation.projectionStats.anchorGroupKey,
          `whole-topic window has no resolvable divider anchor by design — anchorGroupKey must be null for ${finalTopicId}`
        ).toBeNull()
      } else {
        expect(
          allocation.projectionStats.contextBoundaryPresent,
          '#messages [data-context-boundary] must be present explicitly inside #messages — absent or global boundary outside #messages is not converted to first group as fake anchor; partial/inconclusive when absent outside whole-topic <=25'
        ).toBe(true)
        expect(
          allocation.projectionStats.contextBoundaryInsideMessages,
          '#messages [data-context-boundary] must be present explicitly inside #messages (mandatory explicit inside signal per LOCK-004; partial windows require divider inside #messages + final-owned anchor) — contextBoundaryInsideMessages must be true'
        ).toBe(true)
        expect(
          isC02ExactTopicOwned(allocation.projectionStats.anchorGroupKey, finalTopicId),
          `context boundary anchor must be resolvable inside #messages and final-topic-owned (exact boundary-safe isC02ExactTopicOwned predecessor #messages [data-stable-group-id] containing ${finalTopicId}) when boundary present — anchor=${allocation.projectionStats.anchorGroupKey ?? 'null'}`
        ).toBe(true)
      }
      expect(
        isC02ContextEvidenceValid({
          contextBoundaryPresent: allocation.projectionStats.contextBoundaryPresent,
          contextBoundaryInsideMessages: allocation.projectionStats.contextBoundaryInsideMessages,
          anchorGroupKey: allocation.projectionStats.anchorGroupKey,
          lastTopicId: finalTopicId,
          expectedVisibleFinal: expectedSingleVisible
        }),
        `context evidence must be valid via harness predicate per LOCK-004 branches (whole-topic 1..25 no-divider/null-anchor OR partial inside-divider/final-owned with explicit inside signal mandatory, fail-closed when omitted) for ${finalTopicId} expectedVisible=${expectedSingleVisible} present=${allocation.projectionStats.contextBoundaryPresent} insideMessages=${allocation.projectionStats.contextBoundaryInsideMessages} anchor=${allocation.projectionStats.anchorGroupKey ?? 'null'}`
      ).toBe(true)
      expect(
        !!allocation.productionPathComplete,
        `productionPath must be complete — locked detail: ${allocation.productionPath}`
      ).toBe(true)
      expect(
        allocation.productionPath.includes('productionPath complete'),
        `productionPath detail must contain "productionPath complete" marker: ${allocation.productionPath}`
      ).toBe(true)

      // Small settle after deterministic waits already performed inside activation (React commit)
      await mainWindow.waitForTimeout(250)

      // Sample heap AFTER activation — actual renderer process
      const heapAfter = await sampleRendererHeap(mainWindow)
      const afterProblems = validateHeapSample(heapAfter)
      if (heapAfter === null) {
        throw new Error(
          `[PERF-C02] heap calibration unsupported after allocation: performance.memory became unavailable. No artifact emitted.`
        )
      }
      expect(afterProblems, `heap after sample must be valid: ${afterProblems.join('; ')}`).toEqual([])

      // Amplification computed separately from logical bytes (never conflated)
      const amplification = computeHeapAmplification(heapBefore, heapAfter, logicalBytes)
      expect(
        Number.isFinite(amplification.deltaRatio),
        'amplification deltaRatio must be finite (L3 directional)'
      ).toBe(true)
      expect(
        Number.isFinite(amplification.absoluteRatio),
        'amplification absoluteRatio must be finite (L3 directional)'
      ).toBe(true)

      // Detect precision via argv flag (opt-in precise launch reflects in electron process argv)
      const appArgv = await electronApp.evaluate(() => process.argv as string[])
      const precisionLabel: HeapPrecisionLabel = detectHeapPrecisionLabel(appArgv, heapBefore.method)

      // Classify delta informativeness — single authoritative definition effective = precise && finite positive
      const baseInformativeness = classifyEffectiveHeapDeltaInformative(amplification.heapDeltaBytes, precisionLabel)
      // Authoritative calibration complete strictly requires effective precise heap — fail closed if inconclusive
      expect(
        precisionLabel,
        `heap precision must be precise for authoritative complete — precision=${precisionLabel} is bucketed/inconclusive and never yields complete calibration evidence`
      ).toBe('precise')
      expect(
        baseInformativeness.informative,
        `effective heap must be informative (precision===precise && finite positive delta) — ${baseInformativeness.reason}; precision=${precisionLabel}, delta=${amplification.heapDeltaBytes} is inconclusive and cannot yield complete calibration evidence (raw heap.delta remains diagnostic, ratios 0)`
      ).toBe(true)

      // Correctness gates — no thresholds, only completeness/parity/privacy + informativeness
      // Verify the typed ChatDb path preserved authority (fetchMessages) where used
      if (allocation.usedTypedPath) {
        for (const t of syntheticTopics) {
          const fetched = await mainWindow.evaluate(async (topicId) => {
            const api = (window as unknown as Record<string, unknown>).api as Record<string, unknown> | undefined
            const chatDb = api?.chatDb as Record<string, (arg: unknown) => Promise<unknown>> | undefined
            if (!chatDb || typeof chatDb.fetchMessages !== 'function') return null
            return chatDb.fetchMessages({ topicId })
          }, t.topicId)
          // fetchMessages returns { ok, value: { messages, blocks }} — verify shape minimally
          expect(fetched, `typed path parity: fetchMessages must return a value for ${t.topicId}`).not.toBeNull()
        }
      }

      // Build and validate schema-v1 artifact — directional/synthetic labeled
      // Collect reproducibility metadata; override abi/node from the real Electron main process
      // (the test runner is Node, but the measured runtime is the Electron app).
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

      const result = isMixedSingle
        ? buildC02MixedBenchmarkResult(
            environment,
            profile as C02MixedHeapProfile,
            logicalBytes,
            allocation.rendererLogicalBytes,
            heapBefore,
            heapAfter,
            allocation,
            baseInformativeness,
            precisionLabel
          )
        : buildC02BenchmarkResult(
            environment,
            profile as C02HeapProfile,
            logicalBytes,
            allocation.rendererLogicalBytes,
            heapBefore,
            heapAfter,
            allocation,
            baseInformativeness,
            precisionLabel
          )
      // Authoritative artifact status — complete requires effective precise heap AND #messages production DOM proof
      const calibMetric = result.metrics.find((m) => m.id === 'calibration.complete')
      expect(
        calibMetric?.value,
        `authoritative calibration.complete metric must be 1 (effective heap + #messages proof) — got ${calibMetric?.value}; invalid heap or fallback/global DOM never yields complete`
      ).toBe(1)
      const calibGate = result.gates.find((g) => g.id === 'calibration.complete')
      expect(calibGate?.passed, `calibration.complete gate must pass — ${calibGate?.detail ?? 'missing detail'}`).toBe(
        true
      )
      const prodCompleteGate = result.gates.find((g) => g.id === 'productionPath.complete')
      expect(
        prodCompleteGate?.passed,
        `productionPath.complete gate (authoritative) must pass — requires effective heap + #messages proof: ${prodCompleteGate?.detail ?? 'missing'}`
      ).toBe(true)
      const allocationGate = result.gates.find((g) => g.id === 'allocation.resident')
      expect(
        allocationGate?.passed,
        `allocation.resident gate (authoritative) must pass — requires effective heap + #messages proof`
      ).toBe(true)

      // Privacy: no content/credentials/paths — enforced by schema validator at write time
      const artifactPath = writeBenchmarkResult(result)
      expect(fs.existsSync(artifactPath), 'artifact must exist after a passing run').toBe(true)
      console.log(`[PERF-C02] heap calibration artifact: ${path.basename(artifactPath)}`)
      // Log effective values (0 when inconclusive, not valid amplification)
      const effectiveDeltaRatio = baseInformativeness.informative ? amplification.deltaRatio : 0
      const effectiveAbsoluteRatio = baseInformativeness.informative ? amplification.absoluteRatio : 0
      console.log(
        `[PERF-C02] directional synthetic: logicalBytes=${logicalBytes}, heapDelta=${amplification.heapDeltaBytes} (raw diagnostic), effective deltaRatio=${effectiveDeltaRatio.toFixed(3)}, effective absoluteRatio=${effectiveAbsoluteRatio.toFixed(3)}, method=${heapBefore.method}, precision=${precisionLabel}, effectiveInformative=${baseInformativeness.informative}`
      )
      if (!baseInformativeness.informative) {
        console.log(
          `[PERF-C02] INCONCLUSIVE: ${baseInformativeness.reason}; precision=${precisionLabel}. Raw heap.delta remains diagnostic but amplification ratios are 0 (not valid evidence). Not amplification 0.`
        )
      }
      console.log(
        `[PERF-C02] MEASURED AUTHORITY: Redux entity projection (messages entity + messageIdsByTopic + blocks entity) + derived viewport/group/context via actual rendered DOM (groups=${allocation.projectionStats.groupCount} exact=${allocation.projectionStats.groupExactMatched ? 1 : 0}, display scoped=${allocation.projectionStats.displayMessages} global=${allocation.projectionStats.globalDisplayMessages} groupsWithFinalTopic=${allocation.projectionStats.groupsWithFinalTopic ?? 0}, finalTopicProof=${allocation.projectionStats.finalTopicDomProof ? 1 : 0}) — productionPath: ${allocation.productionPath}`
      )
      console.log(
        `[PERF-C02] PRODUCTION PROJECTION PATH (canonical): assistants/addTopic (live assistant ID) → ChatDb ensureTopic/pasteMessagesToTopic → newMessages/setDisplayCount (when required, clamped to latest-window ${C02_PRODUCTION_WINDOW_MAX}) → [data-testid="topic-item"][data-topic-id="${finalTopicId}"] click → HomePage setActiveTopic → useActiveTopic → loadTopicMessagesThunk → Chat/Messages production projections (createLatestMessageWindow → createMessageViewportGroupModel → projectMessageViewportGroups + computeContextInfo) observed via DOM #messages [data-stable-group-id]/#messages [data-message-id]/#messages [data-context-boundary]; productionPath=${allocation.productionPath}; derivedProductionPathComplete per LOCK-004 branches (whole-topic 1..25 no-divider/null-anchor OR partial inside-divider/final-owned with explicit inside signal mandatory, fail-closed; caller ${allocation.productionPathComplete ? 1 : 0} ignored when invalid) authoritativeCalibrationComplete per derived predicate; groups exact ${allocation.projectionStats.groupCount}/${expectedSingleVisible} via #messages [data-stable-group-id] (logical retained ${isMixedSingle ? c02MixedTotalMessages(profile as C02MixedHeapProfile) + ' total' : (profile as C02HeapProfile).syntheticMessagesPerTopic + ' per topic'} , projected ${expectedSingleVisible}) contextBoundaryPresent=${allocation.projectionStats.contextBoundaryPresent ? 1 : 0} insideMessages=${allocation.projectionStats.contextBoundaryInsideMessages ? 1 : 0} anchor=${allocation.projectionStats.anchorGroupKey ?? 'null'} finalTopicOwned=${isC02ExactTopicOwned(allocation.projectionStats.anchorGroupKey, finalTopicId) ? 1 : 0} (exact boundary-safe isC02ExactTopicOwned, fallback [id^="message-"]/global never satisfies; valid branches: whole-topic 1..25 no-divider/null-anchor, partial divider inside #messages with final-owned anchor; explicit inside signal mandatory per LOCK-004)`
      )
      if (isMixedSingle) {
        const mixed = profile as C02MixedHeapProfile
        console.log(
          `[PERF-C02] NOTE: values are directional/synthetic from deterministic MIXED synthetic projection (${mixed.topicSpecs.length} topics heterogeneous ${mixed.topicSpecs.map((s) => s.messageCount + '×' + s.blockContentBytes + 'B').join(', ')}), not production baseline/threshold/policy/real user-data distribution.`
        )
      } else {
        const uniform = profile as C02HeapProfile
        console.log(
          `[PERF-C02] NOTE: values are directional/synthetic from deterministic synthetic projection (${uniform.syntheticTopics} topics × ${uniform.syntheticMessagesPerTopic} msgs × ${uniform.blockContentBytes}B), not production baseline/threshold/policy/real user-data distribution.`
        )
      }
    } else {
      // Multi-profile matrix — INDEPENDENT per-profile isolation via fresh
      // disposable profile/app/session per profile using existing E2E ownership
      // (createOwnedTmpRoot / launchElectronApp / probeAndAssertRuntimeAppData
      // / bypassOnboarding / seedMockProvider / waitForHomeReady / closeElectronWithExactCleanup).
      // Sequential profiles in one app share Redux/persisted state and contaminate
      // heap deltas — fresh profile/app per profile is required for independent
      // delta measurement. Each profile's canonical logical bytes denominator is
      // segment-free (segmentCount 0) so it aligns with entities actually
      // materialized/verified (messages+blocks only).
      const entries: Array<{
        profileId: string
        profile: C02HeapProfile | C02MixedHeapProfile
        logicalBytes: number
        rendererLogicalBytes: number
        heapBefore: RendererHeapSample
        heapAfter: RendererHeapSample
        allocation: Awaited<ReturnType<typeof activateReduxProjection>>
        informativeness: { informative: boolean; reason: string }
        precision: HeapPrecisionLabel
        finalTopicId: string
      }> = []
      const effectiveMockPort = mockPort
      for (const entry of profiles) {
        const prefix = `c02-${entry.id}-topic`
        const isMixedEntry = isC02MixedHeapProfile(entry.profile)
        const syntheticTopics = isMixedEntry
          ? buildC02MixedSyntheticTopicsWithPrefix(entry.profile as C02MixedHeapProfile, prefix)
          : buildC02SyntheticTopicsWithPrefix(entry.profile as C02HeapProfile, prefix)
        const synthProblems = validateSyntheticTopics(syntheticTopics)
        expect(
          synthProblems,
          `synthetic topics must canonicalize for ${entry.id}: ${synthProblems.join('; ')}`
        ).toEqual([])
        const logicalBytes = canonicalBytesForTopics(syntheticTopics)
        expect(
          validateLogicalBytes(logicalBytes),
          `canonical logical bytes must be finite positive for ${entry.id}`
        ).toEqual([])

        const isolatedRoot = createOwnedTmpRoot()
        const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const isolatedUserDataDir = `${isolatedRoot}/c02-isolated-${entry.id}-${token}`
        validateProfileLaunchToken(isolatedRoot, isolatedUserDataDir, true)
        let isolatedApp: import('@playwright/test').ElectronApplication | null = null
        let isolatedWindow: import('@playwright/test').Page | null = null
        try {
          isolatedApp = await launchElectronApp({ userDataDir: isolatedUserDataDir, ownedTmpRoot: isolatedRoot })
          isolatedWindow = await waitForMainElectronWindow(isolatedApp)
          const probed = await probeAndAssertRuntimeAppData(isolatedWindow, isolatedUserDataDir)
          void probed
          await bypassOnboarding(isolatedWindow)
          await seedMockProvider(isolatedWindow, effectiveMockPort)
          await waitForHomeReady(isolatedWindow)
          await assertChatDbReady(isolatedWindow)
          await assertTextareaReady(isolatedWindow)

          const heapBefore = await sampleRendererHeap(isolatedWindow)
          const beforeProblems = validateHeapSample(heapBefore)
          if (heapBefore === null) {
            throw new Error(
              `[PERF-C02] heap calibration unsupported for profile ${entry.id}: performance.memory not available. No artifact emitted.`
            )
          }
          expect(
            beforeProblems,
            `heap before sample must be valid for ${entry.id}: ${beforeProblems.join('; ')}`
          ).toEqual([])

          // Bounded correction: pass the exact same syntheticTopics used for canonicalBytesForTopics
          const allocation = await activateReduxProjection(isolatedWindow, syntheticTopics, {
            waitTimeoutMs: C02_MATRIX_WAIT_TIMEOUT_MS
          })
          if (allocation.failedBlocker) {
            throw new Error(
              `[PERF-C02] heap calibration blocked for profile ${entry.id}: ${allocation.failedBlocker}. No artifact emitted.`
            )
          }
          if (isMixedEntry) {
            const mixed = entry.profile as C02MixedHeapProfile
            expect(allocation.topicsCreated, `synthetic topics must be created for ${entry.id} (mixed)`).toBe(
              mixed.topicSpecs.length
            )
            expect(allocation.messagesCreated, `synthetic messages must be created for ${entry.id} (mixed)`).toBe(
              c02MixedTotalMessages(mixed)
            )
          } else {
            const uniform = entry.profile as C02HeapProfile
            expect(allocation.topicsCreated, `synthetic topics must be created for ${entry.id}`).toBe(
              uniform.syntheticTopics
            )
            expect(allocation.messagesCreated, `synthetic messages must be created for ${entry.id}`).toBe(
              uniform.syntheticTopics * uniform.syntheticMessagesPerTopic
            )
          }
          expect(allocation.reduxVerified, `Redux entity projection must be verified for ${entry.id}`).toBe(true)

          const finalTopicId = syntheticTopics[syntheticTopics.length - 1]!.topicId
          expect(
            allocation.projectionStats.finalTopicDomProof,
            `final-topic DOM proof must be true for ${entry.id} ${finalTopicId}`
          ).toBe(true)
          expect(!!allocation.productionPathComplete, `productionPath must be complete for ${entry.id}`).toBe(true)

          await isolatedWindow.waitForTimeout(250)
          const heapAfter = await sampleRendererHeap(isolatedWindow)
          const afterProblems = validateHeapSample(heapAfter)
          if (heapAfter === null) {
            throw new Error(
              `[PERF-C02] heap calibration unsupported after allocation for ${entry.id}: performance.memory became unavailable. No artifact emitted.`
            )
          }
          expect(afterProblems, `heap after sample must be valid for ${entry.id}: ${afterProblems.join('; ')}`).toEqual(
            []
          )

          const appArgv = await isolatedApp.evaluate(() => process.argv as string[])
          const precisionLabel: HeapPrecisionLabel = detectHeapPrecisionLabel(appArgv, heapBefore.method)
          const amplification = computeHeapAmplification(heapBefore, heapAfter, logicalBytes)
          const baseInformativeness = classifyEffectiveHeapDeltaInformative(
            amplification.heapDeltaBytes,
            precisionLabel
          )
          expect(precisionLabel, `heap precision must be precise for ${entry.id} — precision=${precisionLabel}`).toBe(
            'precise'
          )
          expect(
            baseInformativeness.informative,
            `effective heap must be informative for ${entry.id} — ${baseInformativeness.reason}`
          ).toBe(true)

          entries.push({
            profileId: entry.id,
            profile: entry.profile,
            logicalBytes,
            rendererLogicalBytes: allocation.rendererLogicalBytes,
            heapBefore,
            heapAfter,
            allocation,
            informativeness: baseInformativeness,
            precision: precisionLabel,
            finalTopicId: syntheticTopics[syntheticTopics.length - 1]!.topicId
          })
          console.log(
            `[PERF-C02] matrix profile ${entry.id}: isolated profile ${isolatedUserDataDir} logicalBytes=${logicalBytes}, heapDelta=${amplification.heapDeltaBytes}, deltaRatio=${amplification.deltaRatio.toFixed(3)}, precision=${precisionLabel}`
          )
        } finally {
          try {
            if (isolatedApp) {
              await closeElectronWithExactCleanup(isolatedUserDataDir, {
                close: () => isolatedApp!.close(),
                findExactProcesses: findProcessesByUserDataDir,
                terminateExactProcesses: (dir) => terminateProcessesByUserDataDir(dir, null)
              })
            }
          } catch (e) {
            throw new Error(
              `[PERF-C02] matrix isolation cleanup failed for ${entry.id} (${isolatedUserDataDir}): ${e instanceof Error ? e.message : String(e)}`
            )
          } finally {
            try {
              await removeOwnedTmpRoot(isolatedRoot, [isolatedUserDataDir])
            } catch (e) {
              throw new Error(
                `[PERF-C02] matrix isolation root cleanup failed for ${entry.id} (${isolatedRoot}): ${e instanceof Error ? e.message : String(e)}`
              )
            }
          }
        }
      }

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
      const result = buildC02MultiBenchmarkResult(environment, entries)
      for (const m of result.metrics) {
        expect(Number.isFinite(m.value), `metric ${m.id} must be finite`).toBe(true)
      }
      const matrixGate = result.gates.find((g) => g.id === 'calibration.matrix.complete')
      expect(matrixGate?.passed, `matrix calibration gate must pass — ${matrixGate?.detail ?? 'missing'}`).toBe(true)
      const artifactPath = writeBenchmarkResult(result)
      expect(fs.existsSync(artifactPath), 'artifact must exist after matrix run').toBe(true)
      console.log(
        `[PERF-C02] heap calibration matrix artifact: ${path.basename(artifactPath)} with ${entries.length} profiles — directional synthetic, not adopted`
      )
    }
  })
})
