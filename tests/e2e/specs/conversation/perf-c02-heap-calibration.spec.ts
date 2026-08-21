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
 *   expected stable group count inside #messages is observed with ownership proof, and
 *   #messages [data-context-boundary] is explicitly present inside #messages with a resolvable final-topic-owned anchor;
 *   fallback [id^="message-"], global document queries, or inferred first-group anchor never satisfies
 *   complete — incomplete/ambiguous observations are explicitly partial/inconclusive. Authoritative calibration complete
 *   strictly requires precise && finite positive heap delta in addition to this #messages production DOM proof.
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
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkGate,
  type BenchmarkMetric,
  type BenchmarkResult,
  collectEnvironmentMetadata,
  writeBenchmarkResult
} from '../../../../src/main/services/chatDb/__tests__/benchResult'
import { expect, test } from '../../fixtures/electron.fixture'
import {
  buildC02ScaleMap,
  buildC02SyntheticTopics,
  C02_BENCHMARK_ID,
  C02_BENCHMARK_NAME,
  c02HeapGateEnabled,
  canonicalBytesForTopics,
  classifyEffectiveHeapDeltaInformative,
  computeHeapAmplification,
  DEFAULT_C02_HEAP_PROFILE,
  detectHeapPrecisionLabel,
  RENDERER_HEAP_METHOD,
  resolveC02HeapProfile,
  validateHeapSample,
  validateLogicalBytes,
  validateSyntheticTopics,
  type C02HeapProfile,
  type HeapPrecisionLabel,
  type RendererHeapSample
} from '../../utils/perfHeapCalibration'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Safe canonical command recorded in artifact (no path segments). */
const CANONICAL_COMMAND = 'pnpm test:e2e'

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
  profile: C02HeapProfile
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
    finalTopicDomProof: boolean
    groupExactMatched?: boolean
    contextBoundaryObservedWait?: boolean
    groupsWithFinalTopic?: number
    globalDisplayMessages?: number
  }
  productionPath: string
  productionPathComplete?: boolean
  failedBlocker?: string
}> {
  const pad = (n: number, w: number): string => String(n).padStart(w, '0')
  // Build deterministic synthetic topics locally (same shape as before for ChatDb)
  const topics: Array<{
    topicId: string
    messages: Array<Record<string, unknown>>
    blocks: Array<Record<string, unknown>>
  }> = []
  const content = 'a'.repeat(profile.blockContentBytes)
  let messageTotal = 0
  for (let t = 0; t < profile.syntheticTopics; t++) {
    const topicId = `c02-heap-topic-${pad(t, 2)}`
    const messages: Array<Record<string, unknown>> = []
    const blocks: Array<Record<string, unknown>> = []
    for (let i = 0; i < profile.syntheticMessagesPerTopic; i++) {
      const msgId = `${topicId}-msg-${pad(i, 5)}`
      const blockId = `${topicId}-block-${pad(i, 5)}`
      messages.push({
        id: msgId,
        topicId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        assistantId: `assistant-${pad(i % 3, 2)}`,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        status: 'success',
        blocks: [blockId],
        sortOrder: i
      })
      blocks.push({
        id: blockId,
        messageId: msgId,
        type: 'main_text',
        content,
        status: 'success',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z'
      })
    }
    topics.push({ topicId, messages, blocks })
    messageTotal += messages.length
  }

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
        finalTopicDomProof: false
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
          finalTopicDomProof: false
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
          finalTopicDomProof: false
        },
        productionPath: 'blocked: ChatDb persist failed via ensureTopic/pasteMessagesToTopic',
        failedBlocker: `typed ChatDb persist failed for ${t.topicId}: ${persist.err}`
      }
    }
  }
  usedTypedPath = true

  // Step 2: set display count with existing newMessages/setDisplayCount if required
  // Bounded synthetic projection: each topic has syntheticMessagesPerTopic messages;
  // default displayCount is 10, so raise to the per-topic count to render the full window.
  const desiredDisplayCount = profile.syntheticMessagesPerTopic
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
          finalTopicDomProof: false
        },
        productionPath: 'blocked: setDisplayCount verification failed',
        failedBlocker: `newMessages/setDisplayCount failed: expected ${desiredDisplayCount}, got ${String(actual)}`
      }
    }
  }

  const lastTopicId = topics[topics.length - 1]?.topicId ?? ''
  const expectedVisible = Math.min(profile.syntheticMessagesPerTopic, desiredDisplayCount)

  // Step 3: canonical activation via existing rendered topic-item clicks — one click per synthetic topic
  // so all synthetic topics become resident in Redux via the production loadTopicMessagesThunk path
  // (HomePage → useActiveTopic → loadTopicMessagesThunk). Each click waits deterministically for
  // Redux IDs, loading false, and FINAL-TOPIC-SCOPED DOM proof (existing [data-message-id]/[id^="message-"]
  // attributes tied to the clicked synthetic topic id) before proceeding. No global count can satisfy
  // completeness — the final topic must demonstrably own the measured DOM.
  for (const topic of topics) {
    const topicId = topic.topicId
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
          finalTopicDomProof: false
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
        { topicId, expected: profile.syntheticMessagesPerTopic },
        { timeout: 30000 }
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
          finalTopicDomProof: false
        },
        productionPath: 'blocked: Redux messageIdsByTopic / loading wait timed out after topic-item click',
        failedBlocker: `Redux wait failed for ${topicId}: ${e instanceof Error ? e.message : String(e)}`
      }
    }
    try {
      await page.waitForFunction(
        ({ topicId, expected }) => {
          // Strict final-topic DOM proof: only production #messages [data-message-id] selectors.
          // [id^="message-"] is diagnostic-only and never satisfies authoritative wait/complete.
          const globalData = document.querySelectorAll('#messages [data-message-id]').length
          const scopedData = document.querySelectorAll(`#messages [data-message-id^="${topicId}-msg-"]`).length
          return scopedData === expected && globalData === expected
        },
        { topicId, expected: expectedVisible },
        { timeout: 30000 }
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
          finalTopicDomProof: false
        },
        productionPath: 'blocked: DOM message count wait timed out after topic-item click',
        failedBlocker: `DOM #messages [data-message-id] scoped wait failed for ${topicId}: expected ${expectedVisible} visible messages owned by that topic (global===scoped===expected); [id^="message-"] is diagnostic-only and not authoritative: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  // Stable groups: exact expected count required for productionPath complete.
  // Authoritative proof is strictly #messages [data-stable-group-id]; arbitrary non-zero fallback may NOT satisfy complete — it is diagnostic only and forces partial/inconclusive.
  let groupExactMatched = false
  try {
    await page.waitForFunction(
      (expected) => document.querySelectorAll('#messages [data-stable-group-id]').length === expected,
      expectedVisible,
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
  const reduxVerified = reduxInfo.reduxMessages === messageTotal && reduxInfo.reduxBlocks >= messageTotal

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
    let groupsWithFinalTopic = 0
    for (let i = 0; i < groupEls.length; i++) {
      const el = groupEls[i] as HTMLElement
      const gid = el.getAttribute('data-stable-group-id') ?? ''
      if (gid.includes(lastTopicId)) {
        groupsWithFinalTopic++
        continue
      }
      // Strict descendant check — only [data-message-id], never [id^="message-"] for authoritative ownership
      const hasDesc = el.querySelector(`[data-message-id^="${lastTopicId}-msg-"]`) !== null
      if (hasDesc) groupsWithFinalTopic++
    }

    // Strict context boundary — must be inside #messages subtree; anchor must be final-topic-owned
    let anchorGroupKey: string | null = null
    let contextBoundaryPresent = false
    let contextBoundaryInsideMessages = false
    // Strict query: only boundary inside #messages qualifies for authoritative proof
    const boundary = document.querySelector('#messages [data-context-boundary]')
    if (boundary && root && root.contains(boundary)) {
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
      // Diagnostic: check if a global boundary exists outside #messages — never satisfies authoritative complete
      const globalBoundary = document.querySelector('[data-context-boundary]')
      if (globalBoundary) {
        // Exists globally but not inside #messages — explicitly not authoritative
        contextBoundaryPresent = false
        contextBoundaryInsideMessages = false
        anchorGroupKey = null
      } else {
        contextBoundaryPresent = false
        contextBoundaryInsideMessages = false
        anchorGroupKey = null
      }
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
  // exact expected DOM counts, and explicit context boundary inside #messages with final-topic-owned anchor all pass.
  // Fallback [id^="message-"], global document queries, or arbitrary non-zero fallbacks never satisfy complete.
  const finalTopicDomProof =
    domStats.domDisplayMessagesScoped === expectedVisible && domStats.domDisplayMessagesGlobal === expectedVisible
  const groupCountExact = domStats.domGroupCount === expectedVisible
  const groupOwnershipProof = domStats.groupsWithFinalTopic === expectedVisible && groupCountExact
  const anchorOwnedByFinalTopic = domStats.anchorGroupKey !== null && domStats.anchorGroupKey.includes(lastTopicId)
  const contextEvidenceOk =
    domStats.contextBoundaryPresent &&
    domStats.contextBoundaryInsideMessages &&
    domStats.anchorGroupKey !== null &&
    anchorOwnedByFinalTopic
  const productionPathComplete =
    reduxVerified && finalTopicDomProof && groupCountExact && groupOwnershipProof && contextEvidenceOk

  let productionPathDetail: string
  if (productionPathComplete) {
    productionPathDetail = `canonical user path complete: assistants/addTopic (live assistant ID) → ChatDb ensureTopic/pasteMessagesToTopic → newMessages/setDisplayCount (when required) → [data-testid="topic-item"][data-topic-id="${lastTopicId}"] click → HomePage setActiveTopic → useActiveTopic → loadTopicMessagesThunk → Chat/Messages production projections (createLatestMessageWindow → createMessageViewportGroupModel → projectMessageViewportGroups + computeContextInfo) observed via DOM #messages [data-stable-group-id]/[data-message-id]/[data-context-boundary]; productionPath complete — finalTopic=${lastTopicId} owns #messages DOM (scoped ${domStats.domDisplayMessagesScoped}/${expectedVisible}, global ${domStats.domDisplayMessagesGlobal}/${expectedVisible} via #messages [data-message-id]), groups exact ${domStats.domGroupCount}/${expectedVisible} (owned ${domStats.groupsWithFinalTopic}/${expectedVisible} via #messages [data-stable-group-id]), contextBoundary inside #messages anchor=${domStats.anchorGroupKey} (final-topic-owned, [id^="message-"] fallback diagnostic-only excluded)`
  } else {
    const reasons: string[] = []
    if (!reduxVerified)
      reasons.push(
        `Redux unverified (reduxMessages=${reduxInfo.reduxMessages}/${messageTotal}, reduxBlocks=${reduxInfo.reduxBlocks}/${messageTotal})`
      )
    if (!finalTopicDomProof)
      reasons.push(
        `final-topic DOM proof failed for ${lastTopicId} (scoped ${domStats.domDisplayMessagesScoped}/${expectedVisible}, global ${domStats.domDisplayMessagesGlobal}/${expectedVisible} — global/stale or partial cannot satisfy complete)`
      )
    if (!groupCountExact)
      reasons.push(
        `group count not exact (observed ${domStats.domGroupCount}/${expectedVisible} — arbitrary non-zero fallback cannot satisfy complete; diagnostic groupsWithFinalTopic=${domStats.groupsWithFinalTopic})`
      )
    else if (!groupOwnershipProof)
      reasons.push(
        `group ownership failed (groupsWithFinalTopic ${domStats.groupsWithFinalTopic}/${expectedVisible} — groups do not demonstrably belong to final topic)`
      )
    if (!domStats.contextBoundaryPresent)
      reasons.push(
        '[data-context-boundary] absent inside #messages — context evidence unavailable (global boundary outside #messages or missing; not inferred from first group; partial/inconclusive; diagnostic alt counts not authoritative)'
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
// Artifact construction — schema v1, directional/synthetic labeled
// ---------------------------------------------------------------------------

function buildBenchmarkResult(
  environment: BenchmarkResult['environment'],
  profile: C02HeapProfile,
  logicalBytes: number,
  rendererLogicalBytes: number,
  heapBefore: RendererHeapSample,
  heapAfter: RendererHeapSample,
  allocation: {
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
      finalTopicDomProof: boolean
      groupExactMatched?: boolean
      groupsWithFinalTopic?: number
      globalDisplayMessages?: number
    }
    productionPath: string
    productionPathComplete?: boolean
  },
  informativeness: { informative: boolean; reason: string },
  precision: HeapPrecisionLabel
): BenchmarkResult {
  const amplification = computeHeapAmplification(heapBefore, heapAfter, logicalBytes)
  const scale = buildC02ScaleMap(profile, heapBefore.method, precision)
  // Single authoritative definition: effective = (precision === 'precise') && finite positive delta
  // Use ONE value for metric, gate, and ratio emission. Bucketed positive deltas are inconclusive.
  const effectiveInformative = informativeness.informative && precision === 'precise'
  const deltaInformativeMetric = effectiveInformative ? 1 : 0
  // Ratio emission: raw heap.delta remains diagnostic, but amplification ratios are valid ONLY when effective
  const effectiveDeltaRatio = effectiveInformative ? amplification.deltaRatio : 0
  const effectiveAbsoluteRatio = effectiveInformative ? amplification.absoluteRatio : 0

  const metrics: BenchmarkMetric[] = [
    // Canonical logical payload — phase4-logical-payload-v1, separate from heap
    {
      id: 'logical.bytes',
      name: 'canonical logical payload bytes (phase4-logical-payload-v1, directional synthetic)',
      value: logicalBytes,
      unit: 'bytes'
    },
    {
      id: 'logical.bytes.rendererEstimate',
      name: 'renderer TextEncoder JSON estimate bytes (directional parity, non-canonical)',
      value: rendererLogicalBytes,
      unit: 'bytes'
    },
    // Actual renderer heap samples — separate axis, performance.memory
    {
      id: 'heap.used.before',
      name: 'renderer heap used before allocation (performance.memory usedJSHeapSize, directional)',
      value: heapBefore.usedJSHeapSize,
      unit: 'bytes'
    },
    {
      id: 'heap.used.after',
      name: 'renderer heap used after resident Redux projection allocation (performance.memory usedJSHeapSize, directional)',
      value: heapAfter.usedJSHeapSize,
      unit: 'bytes'
    },
    {
      id: 'heap.total.after',
      name: 'renderer heap total after allocation (performance.memory totalJSHeapSize, directional)',
      value: heapAfter.totalJSHeapSize,
      unit: 'bytes'
    },
    {
      id: 'heap.limit',
      name: 'renderer heap limit (performance.memory jsHeapSizeLimit, directional)',
      value: heapAfter.jsHeapSizeLimit,
      unit: 'bytes'
    },
    {
      id: 'heap.delta',
      name: 'renderer heap delta bytes (after - before, directional synthetic; 0/negative/bucketed is inconclusive, not amplification 0 — raw diagnostic)',
      value: amplification.heapDeltaBytes,
      unit: 'bytes'
    },
    {
      id: 'heap.deltaInformative',
      name: 'heap delta informativeness gate value (1=effective informative precise positive delta, 0=inconclusive zero/negative/non-finite/bucketed — single definition precision===precise && finite positive)',
      value: deltaInformativeMetric,
      unit: 'count'
    },
    // Heap amplification — valid ONLY when effectiveInformative; otherwise 0 (inconclusive, not amplification 0)
    {
      id: 'heap.amplification.deltaRatio',
      name: 'heap amplification deltaRatio = heapDelta / logicalBytes (directional synthetic, valid ONLY when deltaInformative=1; 0 when inconclusive — bucketed positive remains 0, not valid amplification)',
      value: effectiveDeltaRatio,
      unit: 'ratio'
    },
    {
      id: 'heap.amplification.absoluteRatio',
      name: 'heap amplification absoluteRatio = heapUsedAfter / logicalBytes (directional synthetic, valid ONLY when deltaInformative=1; 0 when inconclusive)',
      value: effectiveAbsoluteRatio,
      unit: 'ratio'
    },
    // Counts for context (not thresholds)
    {
      id: 'synthetic.topics',
      name: 'synthetic topics created (directional)',
      value: allocation.topicsCreated,
      unit: 'count'
    },
    {
      id: 'synthetic.messages',
      name: 'synthetic messages created (directional)',
      value: allocation.messagesCreated,
      unit: 'count'
    },
    {
      id: 'synthetic.blocks',
      name: 'synthetic blocks created (directional, Redux messageBlocks entity)',
      value: allocation.blocksCreated,
      unit: 'count'
    },
    {
      id: 'projection.reduxMessages',
      name: 'Redux messages entity count verified resident (directional)',
      value: allocation.projectionStats.reduxMessages,
      unit: 'count'
    },
    {
      id: 'projection.reduxBlocks',
      name: 'Redux blocks entity count verified resident (directional)',
      value: allocation.projectionStats.reduxBlocks,
      unit: 'count'
    },
    {
      id: 'projection.groups',
      name: 'derived viewport groups count via actual rendered DOM #messages [data-stable-group-id] (directional, production Messages.tsx) — exact expectedVisible required for complete; global [data-stable-group-id] never authoritative',
      value: allocation.projectionStats.groupCount,
      unit: 'count'
    },
    {
      id: 'projection.displayMessages',
      name: 'derived displayMessages window count via actual rendered DOM #messages [data-message-id] scoped to final synthetic topic (directional, production Messages.tsx) — exact expectedVisible required for complete; [id^="message-"] is diagnostic-only',
      value: allocation.projectionStats.displayMessages,
      unit: 'count'
    },
    {
      id: 'projection.displayMessagesGlobal',
      name: 'global displayMessages count via actual rendered DOM #messages [data-message-id] (must equal scoped for final-topic proof; mismatch indicates stale/partial projection; global [id^="message-"] never authoritative)',
      value: allocation.projectionStats.globalDisplayMessages ?? allocation.projectionStats.displayMessages,
      unit: 'count'
    },
    {
      id: 'projection.groupsWithFinalTopic',
      name: 'groups containing final synthetic topic messages via #messages [data-stable-group-id]/[data-message-id] ownership proof; must equal exact expectedVisible for complete; [id^="message-"] descendant never satisfies',
      value: allocation.projectionStats.groupsWithFinalTopic ?? 0,
      unit: 'count'
    },
    {
      id: 'projection.finalTopicDomProof',
      name: 'final-topic DOM ownership proof via #messages [data-message-id] (1= scoped===global===expectedVisible for final clicked topic inside #messages, 0= stale/global/partial — complete requires 1; [id^="message-"] never satisfies)',
      value: allocation.projectionStats.finalTopicDomProof ? 1 : 0,
      unit: 'count'
    },
    {
      id: 'projection.contextBoundaryPresent',
      name: 'context boundary presence via #messages [data-context-boundary] inside #messages with final-topic-owned anchor (1= present inside #messages with resolvable final-topic anchor, 0= absent/global/fallback — explicit, not inferred; complete requires 1)',
      value: allocation.projectionStats.contextBoundaryPresent ? 1 : 0,
      unit: 'count'
    },
    {
      id: 'projection.productionPathComplete',
      name: 'productionPath complete flag via #messages production selectors only (1= Redux verified + final-topic ownership inside #messages + exact groups + boundary inside #messages with final-topic anchor; 0= partial/inconclusive — fallback [id^="message-"]/global cannot satisfy complete)',
      value: allocation.productionPathComplete ? 1 : 0,
      unit: 'count'
    },
    {
      id: 'calibration.complete',
      name: 'authoritative calibration complete — effective precise heap AND productionPath complete (1= precision===precise && finite positive delta && #messages final-topic DOM/groups/boundary proof; 0= inconclusive; invalid heap never yields complete)',
      value: effectiveInformative && !!allocation.productionPathComplete ? 1 : 0,
      unit: 'count'
    }
  ]

  const deltaGatePassed = effectiveInformative
  const deltaGateDetail = effectiveInformative
    ? `directional synthetic: heapDelta=${amplification.heapDeltaBytes} is finite positive with precision=${precision} (argv --enable-precise-memory-info present) — effective informative (precision===precise && finite positive) for directional amplification; deltaRatio=${effectiveDeltaRatio.toFixed(3)} valid`
    : `directional synthetic: heapDelta=${amplification.heapDeltaBytes} is INCONCLUSIVE — ${informativeness.reason}; precision=${precision}. Effective requires precision===precise && finite positive delta. Zero/negative/non-finite or bucketed (precision!=precise) delta is inconclusive and ratios are 0 (not valid amplification, raw heap.delta remains diagnostic). See heap.deltaInformative metric.`
  // Authoritative calibration complete: strictly requires BOTH effective precise heap AND final-topic-owned #messages DOM/projection proof.
  // Fallback [id^="message-"], global selectors, or bucketed/inconclusive heap never satisfy complete.
  const authoritativeComplete = effectiveInformative && !!allocation.productionPathComplete

  const gates: BenchmarkGate[] = [
    {
      id: 'synthetic.datasetComplete',
      name: 'synthetic dataset complete via canonicalization (phase4-logical-payload-v1)',
      kind: 'correctness',
      passed: true,
      detail: `directional synthetic: ${allocation.topicsCreated} topics, ${allocation.messagesCreated} messages, ${allocation.blocksCreated} blocks, logicalBytes=${logicalBytes} (canonical), typedPath=${allocation.usedTypedPath} (existing ChatDb ensureTopic/pasteMessages/fetchMessages) → Redux entity projection verified=${allocation.reduxVerified} (messages entity + messageIdsByTopic + blocks entity)`
    },
    {
      id: 'heap.sampleAvailable',
      name: 'actual renderer heap sampled via performance.memory (renderer process, not Node proxy)',
      kind: 'correctness',
      passed: true,
      detail: `directional synthetic: method=${heapBefore.method}, precision=${precision}, before=${heapBefore.usedJSHeapSize}, after=${heapAfter.usedJSHeapSize}, delta=${amplification.heapDeltaBytes} (least invasive Chromium API; no Node process.memoryUsage proxy; opt-in --enable-precise-memory-info when C02 enabled)`
    },
    {
      id: 'heap.deltaInformative',
      name: 'heap delta informativeness — effective (precision===precise && finite positive delta); zero/bucketed/negative/non-finite is never amplification 0 evidence (evidence-informativeness gate, not product threshold)',
      kind: 'correctness',
      passed: deltaGatePassed,
      detail: deltaGateDetail
    },
    {
      id: 'heap.precision',
      name: 'heap precision mode detected via argv --enable-precise-memory-info (inconclusive when bucketed, not amplification 0)',
      kind: 'correctness',
      passed: precision === 'precise',
      detail: `directional synthetic: precision=${precision} (precise requires opt-in launch flag; bucketed values are quantized and zero delta is inconclusive; effective requires precise+finite positive). Heap amplification ratios are 0 when not effective.`
    },
    {
      id: 'logical.bytesFinite',
      name: 'canonical logical bytes finite and positive (separate axis from heap)',
      kind: 'correctness',
      passed: true,
      detail: `directional synthetic: logicalBytes=${logicalBytes} (phase4-logical-payload-v1), rendererEstimate=${rendererLogicalBytes} — heap amplification reported separately, not conflated`
    },
    {
      id: 'allocation.resident',
      name: 'Redux entity projection + derived viewport/group/context via actual rendered Chat path — authoritative calibration complete requires effective heap AND productionPath (exact final-topic ownership inside #messages + exact groups inside #messages + boundary inside #messages with final-topic anchor) (renderer heap)',
      kind: 'correctness',
      passed: authoritativeComplete,
      detail: `directional synthetic: Redux projection — ${allocation.projectionStats.reduxMessages} messages, ${allocation.projectionStats.reduxBlocks} blocks; derived DOM — ${allocation.projectionStats.groupCount} groups (#messages [data-stable-group-id]) exact=${allocation.projectionStats.groupExactMatched ?? false}, displayMessages scoped=${allocation.projectionStats.displayMessages} global=${allocation.projectionStats.globalDisplayMessages ?? allocation.projectionStats.displayMessages} (finalTopicProof=${allocation.projectionStats.finalTopicDomProof ? 1 : 0} via #messages [data-message-id]), groupsWithFinalTopic=${allocation.projectionStats.groupsWithFinalTopic ?? 0}; contextBoundaryPresent inside #messages=${allocation.projectionStats.contextBoundaryPresent ? 1 : 0} anchor=${allocation.projectionStats.anchorGroupKey ?? 'null'} (must be final-topic-owned, [id^="message-"] diagnostic-only); productionPath=${allocation.productionPath}; productionPathComplete=${allocation.productionPathComplete ? 1 : 0}; effectiveInformative=${effectiveInformative ? 1 : 0} (precision=${precision}, delta=${amplification.heapDeltaBytes}); authoritativeComplete=${authoritativeComplete ? 1 : 0} (requires precise && finite positive delta && #messages proof; fallback/global never satisfies; invalid heap never yields complete). Detached holder removed; heap cost is renderer entity + production-derived projections when authoritative complete, otherwise Redux entity only and derived counts are inconclusive.`
    },
    {
      id: 'productionPath.complete',
      name: 'productionPath complete lock — final clicked synthetic topic owns #messages DOM (scoped===global===expected via #messages [data-message-id]), exact #messages group count, and [data-context-boundary] inside #messages with final-topic-owned resolvable anchor (no fallback/global satisfies complete)',
      kind: 'correctness',
      passed: authoritativeComplete,
      detail: `productionPathComplete=${allocation.productionPathComplete ? 1 : 0}; effectiveInformative=${effectiveInformative ? 1 : 0} (precision=${precision}, delta=${amplification.heapDeltaBytes}); authoritativeComplete=${authoritativeComplete ? 1 : 0}; ${allocation.productionPath} — locked: authoritative complete requires BOTH effective precise heap (precision===precise && finite positive delta) AND #messages production selectors proof; fallback [id^="message-"]/global stale DOM or bucketed delta never satisfies complete (see perf-c02-heap-calibration.spec.ts activateReduxProjection).`
    },
    {
      id: 'projection.finalTopicOwnership',
      name: 'final clicked synthetic topic owns the measured #messages DOM — #messages [data-message-id] scoped to final topic equals global and expectedVisible (no global stale count or [id^="message-"] satisfies complete)',
      kind: 'correctness',
      passed: allocation.projectionStats.finalTopicDomProof,
      detail: `finalTopicDomProof=${allocation.projectionStats.finalTopicDomProof ? 1 : 0}; scoped=${allocation.projectionStats.displayMessages}, global=${allocation.projectionStats.globalDisplayMessages ?? allocation.projectionStats.displayMessages}, expectedVisible=${profile.syntheticMessagesPerTopic} (min(N,W)), finalTopic must be ${profile.syntheticTopics - 1}th synthetic topic (c02-heap-topic-${String(profile.syntheticTopics - 1).padStart(2, '0')}); strict #messages [data-message-id] only, [id^="message-"] diagnostic-only excluded`
    },
    {
      id: 'projection.contextBoundaryExplicit',
      name: 'context boundary presence is explicit via #messages [data-context-boundary] inside #messages with final-topic-owned anchor — absent/global/outside is not converted to first group as fake anchor (partial/inconclusive when absent)',
      kind: 'correctness',
      passed:
        allocation.projectionStats.contextBoundaryPresent &&
        allocation.projectionStats.anchorGroupKey !== null &&
        (allocation.projectionStats.anchorGroupKey?.includes(
          `c02-heap-topic-${String(profile.syntheticTopics - 1).padStart(2, '0')}`
        ) ??
          false),
      detail: `contextBoundaryPresent inside #messages=${allocation.projectionStats.contextBoundaryPresent ? 1 : 0}, anchorGroupKey=${allocation.projectionStats.anchorGroupKey ?? 'null'} finalTopicOwned=${(allocation.projectionStats.anchorGroupKey?.includes(`c02-heap-topic-${String(profile.syntheticTopics - 1).padStart(2, '0')}`) ?? false) ? 1 : 0}; when absent or outside #messages or not final-topic-owned the artifact is partial/inconclusive and does not infer first [data-stable-group-id] as anchor; global [data-context-boundary] outside #messages never satisfies`
    },
    {
      id: 'calibration.complete',
      name: 'authoritative calibration complete — effective precise heap (precision===precise && finite positive delta) AND final-topic-owned #messages production DOM with exact groups and explicit context boundary inside #messages (invalid heap or fallback/global DOM never yields complete)',
      kind: 'correctness',
      passed: authoritativeComplete,
      detail: `authoritativeComplete=${authoritativeComplete ? 1 : 0}; effectiveInformative=${effectiveInformative ? 1 : 0} (precision=${precision}, delta=${amplification.heapDeltaBytes}), productionPathComplete=${allocation.productionPathComplete ? 1 : 0} (finalTopicProof=${allocation.projectionStats.finalTopicDomProof ? 1 : 0}, groupsWithFinalTopic=${allocation.projectionStats.groupsWithFinalTopic ?? 0}, contextInsideMessages=${allocation.projectionStats.contextBoundaryPresent ? 1 : 0}); complete evidence strictly requires precise && finite positive heap delta AND #messages [data-message-id]/[data-stable-group-id]/[data-context-boundary] with final-topic-owned anchor — zero/negative/non-finite/bucketed deltas, [id^="message-"] fallback, or global selectors are inconclusive`
    },
    {
      id: 'environment.abi145',
      name: 'measured runtime is Electron ABI 145 lane with safe canonical command',
      kind: 'correctness',
      passed: true,
      detail: `abiLane=electron, abi=${environment.abi}, command=${environment.command} (no path segments)`
    },
    {
      id: 'privacy.schemaV1',
      name: 'artifact complies with PERF-001 schema v1 closed set (no content/credential/path/raw DB size)',
      kind: 'correctness',
      passed: true,
      detail:
        'directional synthetic: metrics/gates/scale carry only numbers and fixed strings; no message content, credentials, paths, model IDs, ask IDs, or raw DB sizes (enforced at write time)'
    }
  ]

  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: C02_BENCHMARK_ID,
      name: C02_BENCHMARK_NAME,
      scale: scale as unknown as Record<string, number>
    },
    environment,
    metrics,
    gates
  }
}

// ---------------------------------------------------------------------------
// Spec — default-off, opt-in, inert to normal runs
// ---------------------------------------------------------------------------

test.describe('PERF-C02 renderer heap calibration (measurement-only, directional synthetic)', () => {
  // Default-off: plain `pnpm test:e2e` stays green. Opt-in only.
  test.skip(!c02HeapGateEnabled(), 'C02 heap calibration is opt-in: set C02_HEAP_CALIBRATION=1 to run')

  test('samples actual renderer heap and emits schema-v1 directional artifact', async ({ mainWindow, electronApp }) => {
    // Resolve profile (fail-loud on bad env — no silent skip)
    const profile = resolveC02HeapProfile()

    // Deterministic synthetic topics — canonical logical bytes (phase4-logical-payload-v1)
    const syntheticTopics = buildC02SyntheticTopics(profile)
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
    const allocation = await activateReduxProjection(mainWindow, profile)
    if (allocation.failedBlocker) {
      throw new Error(
        `[PERF-C02] heap calibration blocked: ${allocation.failedBlocker}. No artifact emitted — this is fail-closed per decision rights; do not retain detached holder or Node proxy.`
      )
    }
    expect(allocation.topicsCreated, 'synthetic topics must be created in renderer').toBe(profile.syntheticTopics)
    expect(allocation.messagesCreated, 'synthetic messages must be created in renderer').toBe(
      profile.syntheticTopics * profile.syntheticMessagesPerTopic
    )
    expect(allocation.reduxVerified, 'Redux entity projection must be verified resident (messages + blocks)').toBe(true)
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
    expect(
      allocation.projectionStats.finalTopicDomProof,
      `final-topic DOM proof must be true for ${finalTopicId} via #messages [data-message-id]: scoped ${allocation.projectionStats.displayMessages} vs global ${allocation.projectionStats.globalDisplayMessages ?? allocation.projectionStats.displayMessages} vs expected ${Math.min(profile.syntheticMessagesPerTopic, profile.syntheticMessagesPerTopic)} (scoped===global===expected inside #messages required; global/stale or [id^="message-"] fallback is not proof)`
    ).toBe(true)
    expect(
      allocation.projectionStats.groupCount,
      `stable group count inside #messages must be exact expectedVisible (${Math.min(profile.syntheticMessagesPerTopic, profile.syntheticMessagesPerTopic)}) via #messages [data-stable-group-id] — arbitrary non-zero fallback cannot produce complete evidence; global [data-stable-group-id] never authoritative`
    ).toBe(Math.min(profile.syntheticMessagesPerTopic, profile.syntheticMessagesPerTopic))
    expect(
      allocation.projectionStats.groupsWithFinalTopic,
      `groups must demonstrably belong to final topic ${finalTopicId} via #messages [data-stable-group-id]/[data-message-id] (groupsWithFinalTopic === expectedVisible); [id^="message-"] descendant never satisfies`
    ).toBe(Math.min(profile.syntheticMessagesPerTopic, profile.syntheticMessagesPerTopic))
    expect(
      allocation.projectionStats.contextBoundaryPresent,
      '#messages [data-context-boundary] must be present explicitly inside #messages — absent or global boundary outside #messages is not converted to first group as fake anchor; partial/inconclusive when absent'
    ).toBe(true)
    expect(
      allocation.projectionStats.anchorGroupKey !== null &&
        allocation.projectionStats.anchorGroupKey.includes(finalTopicId),
      `context boundary anchor must be resolvable inside #messages and final-topic-owned (predecessor #messages [data-stable-group-id] containing ${finalTopicId}) when boundary present — anchor=${allocation.projectionStats.anchorGroupKey ?? 'null'}`
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
    expect(Number.isFinite(amplification.deltaRatio), 'amplification deltaRatio must be finite (L3 directional)').toBe(
      true
    )
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

    const result = buildBenchmarkResult(
      environment,
      profile,
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
      `[PERF-C02] MEASURED AUTHORITY: Redux entity projection (messages entity + messageIdsByTopic + blocks entity) + derived viewport/group/context via actual rendered DOM (groups=${allocation.projectionStats.groupCount} exact=${allocation.projectionStats.groupExactMatched ? 1 : 0}, display scoped=${allocation.projectionStats.displayMessages} global=${allocation.projectionStats.globalDisplayMessages ?? allocation.projectionStats.displayMessages} groupsWithFinalTopic=${allocation.projectionStats.groupsWithFinalTopic ?? 0}, finalTopicProof=${allocation.projectionStats.finalTopicDomProof ? 1 : 0}) — productionPath: ${allocation.productionPath}`
    )
    console.log(
      `[PERF-C02] PRODUCTION PROJECTION PATH (canonical): assistants/addTopic (live assistant ID) → ChatDb ensureTopic/pasteMessagesToTopic → newMessages/setDisplayCount (when required) → [data-testid="topic-item"][data-topic-id="${finalTopicId}"] click → HomePage setActiveTopic → useActiveTopic → loadTopicMessagesThunk → Chat/Messages production projections (createLatestMessageWindow → createMessageViewportGroupModel → projectMessageViewportGroups + computeContextInfo) observed via DOM #messages [data-stable-group-id]/#messages [data-message-id]/#messages [data-context-boundary]; productionPath=${allocation.productionPath}; productionPathComplete=${allocation.productionPathComplete ? 1 : 0} authoritativeCalibrationComplete=${baseInformativeness.informative && !!allocation.productionPathComplete ? 1 : 0} (requires precise && finite positive delta + final-topic-owned #messages proof) groups exact ${allocation.projectionStats.groupCount}/${Math.min(profile.syntheticMessagesPerTopic, profile.syntheticMessagesPerTopic)} via #messages [data-stable-group-id] contextBoundaryInsideMessages=${allocation.projectionStats.contextBoundaryPresent ? 1 : 0} anchor=${allocation.projectionStats.anchorGroupKey ?? 'null'} finalTopicOwned=${allocation.projectionStats.anchorGroupKey?.includes(finalTopicId) ? 1 : 0} (fallback [id^="message-"]/global never satisfies; [data-context-boundary] must be inside #messages with final-topic anchor)`
    )
    console.log(
      `[PERF-C02] NOTE: values are directional/synthetic from deterministic synthetic projection (${profile.syntheticTopics} topics × ${profile.syntheticMessagesPerTopic} msgs × ${profile.blockContentBytes}B), not production baseline/threshold/policy/real user-data distribution.`
    )
  })
})
