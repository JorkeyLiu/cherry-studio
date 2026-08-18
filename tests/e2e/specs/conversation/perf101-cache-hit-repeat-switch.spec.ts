/**
 * PERF-101 cache-hit repeat-switch measurement (production-build Playwright E2E).
 *
 * Purpose (docs/performance-workstreams.md, PERF-TOPIC-SWITCH measurement slice):
 *   Deterministic, bounded, correctness-first measurements that COMPARE the
 *   cache-miss first-open path with the cache-hit repeat-switch path —
 *   switching away from a previously hydrated topic and then back — exposing
 *   the missing repeat-switch endpoint. This slice is MEASUREMENT-ONLY:
 *   no runtime optimization, no threshold, and no fix direction is implied
 *   (LOCK-001, docs/performance-workstreams.md §4).
 *
 * Default-off (LOCK-002):
 *   This spec is skipped unless PERF101_CACHE_HIT=1 is set in the runner
 *   environment. It must not alter ordinary test behavior when unset.
 *
 * Measurement design:
 *   The existing PERF-101 spec structurally uses DISTINCT never-activated
 *   target topics and cannot measure cache-hit repeat switching. This spec
 *   uses ONE target topic per sample that is:
 *     1. Activated once (cache-miss) — measured, then
 *     2. Switched away from (back to source), then
 *     3. Switched back to (cache-hit repeat switch) — measured.
 *
 *   The cache-hit path is defined by `loadTopicMessagesThunk` returning
 *   early on a non-empty `messageIdsByTopic[topicId]` cache, while
 *   `Chat.tsx` remounts `Messages` keyed by `topic.id`. The repeat-switch
 *   measurement captures the cost of: sidebar click dispatch →
 *   `loadTopicMessagesThunk` cache-hit early return → React key-based
 *   `Messages` remount → window/context recalculation → DOM re-render.
 *
 *   Because `loadTopicMessagesThunk` does NOT dispatch `messagesReceived`
 *   on cache hit, there is no message-count Redux commit to observe.
 *   Instead, the cache-hit activation metric observes the `currentTopicId`
 *   change to the target topic. This is an independent activation event
 *   measured separately from the `repeatSwitchRender` DOM endpoint.
 *
 * Metrics emitted (schema v1):
 *   - `cacheMiss.firstUsefulRender.{p50,p95,mean,min,max}` — first open
 *   - `cacheMiss.loadCommit.{p50,p95,mean,min,max}` — first open Redux commit
 *   - `cacheHit.repeatSwitchRender.{p50,p95,mean,min,max}` — cache-hit return
 *   - `cacheHit.activationCommit.{p50,p95,mean,min,max}` — cache-hit topic activation commit (currentTopicId change)
 *   These are deliberately separate metric prefixes so both can be compared
 *   in the same artifact.
 *
 * Correctness:
 *   Every sample's cache-hit return is gated for: (a) the target's
 *   visible-window boundary message rendered in #messages with its
 *   deterministic seed content, (b) Redux holds the full expected count,
 *   (c) loading settled false, (d) currentTopicId === target, (e) exact
 *   visible DOM window, (f) no source-topic contamination, (g) Main
 *   parity, (h) no error states.
 *
 * Instrumentation boundary (LOCK-001/003/006/008):
 *   All instrumentation lives in the test page context only: a
 *   `store.subscribe` listener and a MutationObserver installed inside
 *   `page.evaluate`. No production code is changed, no application
 *   instrumentation is added, and no Main-process wiring is touched.
 *
 * Schema v1 / privacy:
 *   The artifact carries only numbers and fixed non-sensitive strings.
 *   No message contents, credentials, paths, raw DB sizes, profile data,
 *   model IDs, or other sensitive identifiers enter the artifact.
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
import { expect, test } from '../../fixtures/electron.fixture'

// ---------------------------------------------------------------------------
// Opt-in gate — default-off (LOCK-002)
// ---------------------------------------------------------------------------

const CACHE_HIT_ENV = 'PERF101_CACHE_HIT'

function isCacheHitEnabled(): boolean {
  const raw = (process.env[CACHE_HIT_ENV] ?? '').trim()
  return raw === '1' || raw.toLowerCase() === 'true'
}

// ---------------------------------------------------------------------------
// Deterministic bounded scale
// ---------------------------------------------------------------------------

const SCALE = {
  sourceTopicGroups: 2,
  samplesPerProfile: 3
} as const

type ScaleProfileKind = 'quick' | 'n20-w10' | 'n20-w20' | 'n100-w10'

interface ScaleProfile {
  kind: ScaleProfileKind
  benchmarkId: string
  benchmarkName: string
  targetTopicMessageCount: number
  sourceTopicMessageCount: number
  samplesPerProfile: number
  rendererDisplayCount: number
  testTimeoutMs: number
  profileCode: number
}

const PERF101_SCALE_ENV = 'PERF101_SCALE'

/** The quick profile remains the default and keeps the renderer default W10. */
const QUICK_PROFILE: ScaleProfile = {
  kind: 'quick',
  benchmarkId: 'perf101-cache-hit-repeat-switch',
  benchmarkName:
    'PERF-101 cache-hit repeat-switch measurement — cache-miss first-open vs cache-hit return (production-build E2E, Electron lane)',
  targetTopicMessageCount: 4,
  sourceTopicMessageCount: SCALE.sourceTopicGroups * 2,
  samplesPerProfile: SCALE.samplesPerProfile,
  rendererDisplayCount: 10,
  testTimeoutMs: 300000,
  profileCode: 10
}

function buildProfile(
  kind: Exclude<ScaleProfileKind, 'quick'>,
  targetTopicMessageCount: number,
  rendererDisplayCount: number,
  profileCode: number
): ScaleProfile {
  return {
    kind,
    benchmarkId: `perf101-cache-hit-repeat-switch-${kind}`,
    benchmarkName: `PERF-101 cache-hit repeat-switch N${targetTopicMessageCount}/W${rendererDisplayCount} scale measurement (production-build E2E, Electron lane)`,
    targetTopicMessageCount,
    sourceTopicMessageCount: SCALE.sourceTopicGroups * 2,
    samplesPerProfile: SCALE.samplesPerProfile,
    rendererDisplayCount,
    testTimeoutMs: targetTopicMessageCount === 100 ? 600000 : 420000,
    profileCode
  }
}

const N20_W10_PROFILE = buildProfile('n20-w10', 20, 10, 11)
const N20_W20_PROFILE = buildProfile('n20-w20', 20, 20, 12)
const N100_W10_PROFILE = buildProfile('n100-w10', 100, 10, 13)

/** Resolve the cache-hit profiles using the cache-miss PERF101_SCALE aliases; unset/empty keeps quick. */
function resolveScaleProfile(): ScaleProfile {
  const raw = (process.env[PERF101_SCALE_ENV] ?? '').trim()
  if (raw.length === 0) return QUICK_PROFILE

  const normalized = raw.toLowerCase()
  if (normalized === 'n20-w10') return N20_W10_PROFILE
  if (normalized === 's0-20') return N20_W20_PROFILE
  if (normalized === 'n100-w10') return N100_W10_PROFILE

  throw new Error(
    `[PERF-101-CH] unsupported PERF101_SCALE value "${raw}" — expected "n20-w10", "s0-20" or "n100-w10" (unset/empty keeps the default quick profile)`
  )
}

/** Scaled profiles must set W before the first topic activation. */
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
          content: `p101ch seed user ${topicId} g${i}`,
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
        model: { id: `p101ch-m${modelIndex}`, name: `P101CH Model ${modelIndex}` },
        modelId: `p101ch-m${modelIndex}`,
        blocks: [assistantBlockId]
      },
      blocks: [
        {
          id: assistantBlockId,
          messageId: assistantIdMsg,
          type: 'main_text',
          status: 'success',
          content: `p101ch seed assistant ${topicId} g${i}`,
          createdAt: SEED_CREATED_AT
        }
      ]
    })
  }
  return entries
}

function firstMessageId(topicId: string): string {
  return `${topicId}-g0-u`
}

function visibleWindowMessageCount(topicMessageCount: number, rendererDisplayCount: number): number {
  return Math.min(topicMessageCount, rendererDisplayCount)
}

function windowBoundaryIndex(topicMessageCount: number, rendererDisplayCount: number): number {
  return Math.max(0, topicMessageCount - rendererDisplayCount)
}

// ---------------------------------------------------------------------------
// Page-context helpers — seeding, activation, state reads
// ---------------------------------------------------------------------------

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
// Cache-miss precondition
// ---------------------------------------------------------------------------

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
    `cache-miss precondition: ${targetTopicId} must have NO messageIdsByTopic entry before the measured click`
  ).toBe(false)
  expect(
    redux.entityLeak,
    `cache-miss precondition: ${targetTopicId} must have no exact expected target message id in the renderer cache`
  ).toBe(false)
  const main = await readMainTopic(page, targetTopicId)
  expect(
    main.count,
    `cache-miss precondition: ${targetTopicId} must be persisted in Main with exactly ${expectedCount} messages`
  ).toBe(expectedCount)
  expect(main.allOwned, `cache-miss precondition: all ${targetTopicId} Main messages must be topic-owned`).toBe(true)
}

// ---------------------------------------------------------------------------
// Cache-hit precondition — topic must be hydrated in Redux
// ---------------------------------------------------------------------------

async function assertCacheHitPrecondition(page: Page, targetTopicId: string, expectedCount: number): Promise<void> {
  const redux = await page.evaluate(
    ({ targetTopicId, expectedCount }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[targetTopicId]
      return {
        idsDefined: Array.isArray(ids),
        idsLength: Array.isArray(ids) ? ids.length : 0,
        loading: s.messages?.loadingByTopic?.[targetTopicId] === true,
        currentTopicId: s.messages?.currentTopicId ?? null
      }
    },
    { targetTopicId, expectedCount }
  )
  expect(
    redux.idsDefined,
    `cache-hit precondition: ${targetTopicId} must have a messageIdsByTopic entry (hydrated)`
  ).toBe(true)
  expect(
    redux.idsLength,
    `cache-hit precondition: ${targetTopicId} must have exactly ${expectedCount} cached messages`
  ).toBe(expectedCount)
  expect(redux.loading, `cache-hit precondition: ${targetTopicId} must not be loading`).toBe(false)
}

// ---------------------------------------------------------------------------
// Correctness gates — post-timing, same contract as PERF-101
// ---------------------------------------------------------------------------

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
  expect(
    redux.ids,
    `switch: ${targetTopicId} must be fully loaded in Redux (all ${expectedCount} messages)`
  ).toHaveLength(expectedCount)
  expect(redux.ids[0], `switch: ${targetTopicId} first id must be the seeded first user message`).toBe(
    expectedFirstMessageId
  )
  expect(redux.currentTopicId, `switch: currentTopicId must be ${targetTopicId}`).toBe(targetTopicId)
  expect(redux.loading, `switch: ${targetTopicId} loading flag must be settled false`).toBe(false)

  const domIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#messages [data-message-id]')).map((el) => el.getAttribute('data-message-id'))
  )
  expect(
    domIds,
    `switch: ${targetTopicId} expected visible window must render exactly ${expectedVisibleCount} messages`
  ).toHaveLength(expectedVisibleCount)
  const domIdSet = new Set(domIds)
  const expectedWindowSet = new Set(expectedWindowIds)
  expect(domIdSet, `switch: ${targetTopicId} DOM ids must equal the expected latest-window id set exactly`).toEqual(
    expectedWindowSet
  )
  expect(
    domIds,
    `switch: ${targetTopicId} DOM order must be newest-to-oldest (column-reverse) over the expected latest window`
  ).toEqual([...expectedWindowIds].reverse())

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

  const main = await readMainTopic(page, targetTopicId)
  expect(main.count, `switch: Main must hold exactly ${expectedCount} messages after the load`).toBe(expectedCount)
  expect(main.allOwned, 'switch: all Main messages must remain topic-owned').toBe(true)
}

// ---------------------------------------------------------------------------
// Timed measurement helpers
// ---------------------------------------------------------------------------

interface SwitchSample {
  /** Click -> first useful render (boundary DOM content + full Redux count + exact visible DOM window, non-loading). */
  firstUsefulRenderMs: number
  /** Click -> activation commit: message-count commit (cache-miss) or currentTopicId activation (cache-hit). */
  activationCommitMs: number
}

/**
 * Measure ONE topic switch from a sidebar click to first useful render.
 * Used for both cache-miss (first open) and cache-hit (repeat switch).
 *
 * `commitMode` controls the activation-commit observer:
 *   - 'message-count': watches `messageIdsByTopic[topicId]` count reaching
 *     `expectedCount` — correct for cache-miss where `loadTopicMessagesThunk`
 *     dispatches `messagesReceived` with the full message set.
 *   - 'topic-activation': watches `currentTopicId` changing to the target —
 *     correct for cache-hit where `loadTopicMessagesThunk` returns early
 *     and does NOT dispatch `messagesReceived`; this observes the
 *     activation event independently from the render endpoint.
 */
function measureTopicSwitch(
  page: Page,
  targetTopicId: string,
  boundaryMessageId: string,
  marker: string,
  expectedCount: number,
  expectedVisibleCount: number,
  commitMode: 'message-count' | 'topic-activation'
): Promise<SwitchSample> {
  return page.evaluate(
    async ({ targetTopicId, boundaryMessageId, marker, expectedCount, expectedVisibleCount, commitMode }) => {
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

      let commitAt = -1
      const unsubscribe =
        commitMode === 'message-count'
          ? (() => {
              // Cache-miss: observe messageIdsByTopic count arriving at expectedCount
              let prevCount = getCount()
              return store.subscribe(() => {
                const count = getCount()
                if (count === prevCount) return
                prevCount = count
                if (count === expectedCount && commitAt < 0) commitAt = performance.now()
              })
            })()
          : (() => {
              // Cache-hit: observe currentTopicId activating to the target
              let prevTopicId: string | null = store.getState().messages?.currentTopicId ?? null
              return store.subscribe(() => {
                const currentId: string | null = store.getState().messages?.currentTopicId ?? null
                if (currentId === prevTopicId) return
                prevTopicId = currentId
                if (currentId === targetTopicId && commitAt < 0) commitAt = performance.now()
              })
            })()

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
          const poll = () => {
            if (settled) return
            if (isComplete()) return finish(performance.now())
            setTimeout(poll, 5)
          }
          poll()
        })
        return {
          firstUsefulRenderMs: renderAt - t0,
          activationCommitMs: commitAt >= 0 ? commitAt - t0 : -1
        }
      } finally {
        unsubscribe()
      }
    },
    { targetTopicId, boundaryMessageId, marker, expectedCount, expectedVisibleCount, commitMode }
  )
}

/**
 * Click the sidebar topic item WITHOUT measuring — used to switch away from
 * the target topic back to the source topic. Returns when the source topic's
 * messages are visible in the DOM.
 */
async function switchToTopic(page: Page, topicId: string, expectedMessageCount: number): Promise<void> {
  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await item.waitFor({ state: 'visible', timeout: 15000 })
  await item.click()
  await page.waitForFunction(
    ({ topicId, expected }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      return (
        Array.isArray(ids) &&
        ids.length === expected &&
        !s.messages?.loadingByTopic?.[topicId] &&
        s.messages?.currentTopicId === topicId
      )
    },
    { topicId, expected: expectedMessageCount },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (expected) => document.querySelectorAll('#messages [data-message-id]').length === expected,
    expectedMessageCount,
    { timeout: 30000 }
  )
}

// ---------------------------------------------------------------------------
// Statistics + artifact construction
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
  cacheMissFirstUsefulRender: number[]
  cacheMissLoadCommit: number[]
  cacheHitRepeatSwitchRender: number[]
  cacheHitLoadCommit: number[]
}

function buildBenchmarkResult(
  samples: PhaseSamples,
  environment: BenchmarkResult['environment'],
  profile: ScaleProfile
): BenchmarkResult {
  const n = profile.samplesPerProfile
  const renderedCount = visibleWindowMessageCount(profile.targetTopicMessageCount, profile.rendererDisplayCount)

  const correctness: BenchmarkGate[] = [
    {
      id: 'cacheMiss.precondition',
      name: 'every measured target was a genuine cache miss (Main-present, renderer-absent)',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples proved the target persisted in Main with exactly ${profile.targetTopicMessageCount} messages and NO renderer cache entry before the measured click`
    },
    {
      id: 'cacheMiss.firstUsefulRenderSignal',
      name: 'cache-miss first useful render resolved on real target content',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} cache-miss samples ended at the boundary message rendered with deterministic content, full Redux count, exact visible DOM window, loading settled false, currentTopicId === target`
    },
    {
      id: 'cacheHit.precondition',
      name: 'every measured target was genuinely hydrated in Redux before the repeat switch',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples proved the target had a non-empty messageIdsByTopic entry with exactly ${profile.targetTopicMessageCount} messages before the cache-hit click`
    },
    {
      id: 'cacheHit.repeatSwitchRenderSignal',
      name: 'cache-hit repeat switch rendered on real target content',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} cache-hit samples ended at the boundary message rendered with deterministic content, full Redux count, exact visible DOM window, loading settled false, currentTopicId === target`
    },
    {
      id: 'switch.loadedFullTopic',
      name: 'target topic fully loaded in Redux with the exact deterministic order',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples: messageIdsByTopic[target] length === ${profile.targetTopicMessageCount} with the seeded first user message at index 0`
    },
    {
      id: 'switch.renderedFullWindow',
      name: 'the target full expected visible window rendered in the DOM',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples: #messages [data-message-id] count === ${renderedCount} (= min(N,W)) — W stable, no scroll expansion`
    },
    {
      id: 'switch.contentIntegrity',
      name: 'every target message/block loaded with the exact deterministic seed content',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples: every message owns exactly one block entity whose content matches the deterministic seed content`
    },
    {
      id: 'switch.noSourceContamination',
      name: 'the rendered window contains exactly the target messages',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples: the DOM message-id set equals the expected visible-window id set exactly — no source/previous-topic residue`
    },
    {
      id: 'switch.mainParity',
      name: 'Main SQLite authority preserved (exact count, topic-owned rows)',
      kind: 'correctness',
      passed: true,
      detail: `${n}/${n} samples: fetchMessages(target) returns exactly ${profile.targetTopicMessageCount} rows, all owned by the target topic`
    },
    {
      id: 'environment.abi145',
      name: 'measured runtime is the Electron ABI 145 lane with the safe canonical command',
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
        'metrics/gates/scale carry only numbers and fixed strings; no message content, credentials, paths, or raw DB sizes'
    }
  ]

  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: profile.benchmarkId,
      name: profile.benchmarkName,
      scale: {
        profileCode: profile.profileCode,
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
        'cacheMiss.firstUsefulRender',
        'Cache-miss topic-item click -> first useful render (first open; endpoint resolution <= 5ms poll quantize)',
        samples.cacheMissFirstUsefulRender
      ),
      ...statsMetrics(
        'cacheMiss.loadCommit',
        'Cache-miss topic-item click -> Redux full-count projection commit (full Main load + IPC + serialization)',
        samples.cacheMissLoadCommit
      ),
      ...statsMetrics(
        'cacheHit.repeatSwitchRender',
        'Cache-hit repeat-switch click -> first useful render (Messages remount from hydrated cache; endpoint resolution <= 5ms poll quantize)',
        samples.cacheHitRepeatSwitchRender
      ),
      ...statsMetrics(
        'cacheHit.activationCommit',
        'Cache-hit repeat-switch click -> topic activation commit (currentTopicId change, measured independently from render)',
        samples.cacheHitLoadCommit
      )
    ],
    gates: correctness
  }
}

// ---------------------------------------------------------------------------
// The measurement test — default-off (LOCK-002)
// ---------------------------------------------------------------------------

const describeBlock = isCacheHitEnabled() ? test.describe : test.describe.skip

describeBlock('PERF-101 cache-hit repeat-switch measurement', () => {
  test('measures cache-miss first-open vs cache-hit repeat-switch for a hydrated topic', async ({
    electronApp,
    mainWindow
  }) => {
    const profile = resolveScaleProfile()
    test.setTimeout(profile.testTimeoutMs)
    const page = mainWindow

    const assistantId = await page.evaluate(() => (window as any).store.getState().assistants?.assistants?.[0]?.id)
    expect(assistantId, 'the fixture must provide a default assistant').toBeTruthy()

    const samples: PhaseSamples = {
      cacheMissFirstUsefulRender: [],
      cacheMissLoadCommit: [],
      cacheHitRepeatSwitchRender: [],
      cacheHitLoadCommit: []
    }

    const sourceId = 'p101ch-src-topic'
    const sourceSeeds = buildGroupSeeds(sourceId, assistantId!, SCALE.sourceTopicGroups, 0)

    // ---- Phase 1: seed + activate the source/control topic ----------------
    await test.step('Phase 1: seed and activate the source/control topic', async () => {
      await seedAndActivateTopic(
        page,
        sourceId,
        'P101CH Source',
        assistantId!,
        sourceSeeds,
        activationCapacity(profile)
      )
      console.log(
        `[E2E][PERF-101-CH] source topic activated (${sourceSeeds.length} messages; ` +
          `profile ${profile.kind}, N${profile.targetTopicMessageCount}/W${profile.rendererDisplayCount}, code ${profile.profileCode})`
      )
    })

    // ---- Phase 2+3: measured samples (cache-miss → switch away → cache-hit) --
    await test.step('Phase 2+3: measured cache-miss then cache-hit topic switches', async () => {
      for (let s = 0; s < profile.samplesPerProfile; s++) {
        const targetId = `p101ch-target-${s}`
        const expectedCount = profile.targetTopicMessageCount
        const expectedVisibleCount = visibleWindowMessageCount(expectedCount, profile.rendererDisplayCount)
        const boundaryIndex = windowBoundaryIndex(expectedCount, profile.rendererDisplayCount)

        const targetSeeds = buildGroupSeeds(targetId, assistantId!, expectedCount / 2, 1000 * (s + 1))
        await seedTopic(page, targetId, `P101CH Target ${s}`, assistantId!, targetSeeds)

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
        expect(marker, `seed content map must know the boundary message ${boundaryId}`).toBeTruthy()

        // -- A. Cache-miss precondition --
        await assertCacheMissPrecondition(page, targetId, expectedCount, expectedMessageIds)

        // -- B. Measure cache-miss first open --
        const item = page.locator(`[data-testid="topic-item"][data-topic-id="${targetId}"]`)
        await item.waitFor({ state: 'visible', timeout: 15000 })

        const cacheMissSample = await measureTopicSwitch(
          page,
          targetId,
          boundaryId,
          marker!,
          expectedCount,
          expectedVisibleCount,
          'message-count'
        )

        // Post-timing correctness gates for cache-miss
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
        expect(
          cacheMissSample.activationCommitMs,
          `cache-miss: ${targetId} projection commit must land`
        ).toBeGreaterThan(0)
        expect(
          cacheMissSample.firstUsefulRenderMs,
          `cache-miss: ${targetId} first useful render must complete`
        ).toBeGreaterThan(0)
        expect(
          cacheMissSample.firstUsefulRenderMs,
          `cache-miss: ${targetId} first useful render must not precede projection commit`
        ).toBeGreaterThanOrEqual(cacheMissSample.activationCommitMs)

        samples.cacheMissFirstUsefulRender.push(cacheMissSample.firstUsefulRenderMs)
        samples.cacheMissLoadCommit.push(cacheMissSample.activationCommitMs)

        console.log(
          `[E2E][PERF-101-CH] sample ${s} cache-miss: ` +
            `firstUsefulRender=${cacheMissSample.firstUsefulRenderMs.toFixed(1)}ms, ` +
            `activationCommit=${cacheMissSample.activationCommitMs.toFixed(1)}ms`
        )

        // -- C. Switch away from target back to source --
        await switchToTopic(page, sourceId, sourceSeeds.length)

        // -- D. Cache-hit precondition: target must be hydrated in Redux --
        await assertCacheHitPrecondition(page, targetId, expectedCount)

        // -- E. Measure cache-hit repeat switch --
        const cacheHitSample = await measureTopicSwitch(
          page,
          targetId,
          boundaryId,
          marker!,
          expectedCount,
          expectedVisibleCount,
          'topic-activation'
        )

        // Post-timing correctness gates for cache-hit
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
        expect(cacheHitSample.activationCommitMs, `cache-hit: ${targetId} activation commit must land`).toBeGreaterThan(
          0
        )
        expect(
          cacheHitSample.firstUsefulRenderMs,
          `cache-hit: ${targetId} repeat switch render must complete`
        ).toBeGreaterThan(0)
        expect(
          cacheHitSample.firstUsefulRenderMs,
          `cache-hit: ${targetId} repeat switch render must not precede activation commit`
        ).toBeGreaterThanOrEqual(cacheHitSample.activationCommitMs)

        samples.cacheHitRepeatSwitchRender.push(cacheHitSample.firstUsefulRenderMs)
        samples.cacheHitLoadCommit.push(cacheHitSample.activationCommitMs)

        console.log(
          `[E2E][PERF-101-CH] sample ${s} cache-hit: ` +
            `repeatSwitchRender=${cacheHitSample.firstUsefulRenderMs.toFixed(1)}ms, ` +
            `activationCommit=${cacheHitSample.activationCommitMs.toFixed(1)}ms`
        )
      }
      console.log(
        `[E2E][PERF-101-CH] completed ${profile.samplesPerProfile} samples, ` +
          `N=${profile.targetTopicMessageCount} messages per target, ` +
          `visible window W=${profile.rendererDisplayCount} (profile ${profile.kind})`
      )
    })

    // ---- Phase 4: emit the schema v1 artifact ONLY after the full pass -----
    await test.step('Phase 4: emit schema v1 artifact', async () => {
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
      console.log(
        `[E2E][PERF-101-CH] schema v1 artifact: ${path.basename(artifactPath)} ` +
          `(N${profile.targetTopicMessageCount}/W${profile.rendererDisplayCount}, profile ${profile.kind}, code ${profile.profileCode})`
      )
    })
  })
})
