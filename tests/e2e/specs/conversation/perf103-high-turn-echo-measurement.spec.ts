/**
 * PERF-103 high-turn echo-latency measurement (production-build Playwright E2E,
 * default-OFF).
 *
 * Purpose: extend the PERF-103 echo-latency baseline to measure send echo
 * behavior in topics with prior turn history, separating user-message DOM
 * echo, Redux commit, assistant first-visible output, and stream completion.
 * This is measurement-only: no production application behavior is changed.
 *
 * Env gate: PERF103_HIGH_TURN=1 (default-OFF; plain `pnpm test:e2e` skips).
 * Invocation:
 *   pnpm build
 *   PERF103_HIGH_TURN=1 PERF103_HIGH_TURN_TURNS=20 pnpm test:e2e -- tests/e2e/specs/conversation/perf103-high-turn-echo-measurement.spec.ts
 *
 * Scale: priorTurns is configurable via PERF103_HIGH_TURN_TURNS (default
 * 20, max 298). Prior history is batch-seeded through the typed ChatDb bridge.
 * The measured topic contains priorTurns + 1 user +
 * priorTurns + 1 assistant = 2*(priorTurns+1) messages. The measured
 * send is always the LAST message in the topic.
 *
 * Measurements (all on single page clock):
 *   t0 = performance.now() in same task as synthetic Enter keydown
 *   - reduxCommitMs: t0 -> Redux user-message commit (store.subscribe, not poll-quantized)
 *   - firstRenderMs: t0 -> first `.message-user` DOM commit with sample marker
 *   - assistantFirstVisibleMs: t0 -> first `.message-assistant` DOM commit after t0
 *   - streamCompletionMs: t0 -> assistant message status 'success' in Redux
 *   - reduxToDomMs: Redux commit -> first `.message-user` DOM commit
 *
 * Correctness gates (L1): all PERF-103 baseline gates preserved with dynamic
 * message count. No thresholds. All numeric metrics are L3 non-threshold.
 *
 * LOCK-001: Measurement-only; no production application behavior changes.
 * LOCK-002: Default-off; plain `pnpm test:e2e` skips this spec.
 * LOCK-003: Standard production-build E2E fixture and schema/diagnostic conventions.
 * LOCK-004: SQLite remains Main authority via typed IPC.
 * LOCK-005: Prior history is batch-seeded; this spec does not measure
 * sequential-send pressure.
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

// ---------------------------------------------------------------------------
// Env gate
// ---------------------------------------------------------------------------

const HIGH_TURN_ENV = 'PERF103_HIGH_TURN'
const TURNS_ENV = 'PERF103_HIGH_TURN_TURNS'

function highTurnEnabled(): boolean {
  return process.env[HIGH_TURN_ENV] === '1'
}

function priorTurnCount(): number {
  const raw = parseInt(process.env[TURNS_ENV] ?? '20', 10)
  if (!Number.isFinite(raw) || raw < 1) return 20
  return Math.min(raw, 298) // Max 298 prior turns → 598 messages including the measured turn pair
}

// ---------------------------------------------------------------------------
// Deterministic bounded scale
// ---------------------------------------------------------------------------

const SCALE = {
  warmupSamples: 2,
  measuredSamples: 10,
  get priorTurns(): number {
    return priorTurnCount()
  },
  get messagesPerTopic(): number {
    return (this.priorTurns + 1) * 2
  },
  observerFallbackMs: 5,
  echoDefinitionCode: 1,
  attributionDefinitionCode: 1
} as const

const PROFILE_CODE = 1

// ---------------------------------------------------------------------------
// Metric/gate identity contract
// ---------------------------------------------------------------------------

const STAT_SUFFIXES = ['p50', 'p95', 'mean', 'min', 'max'] as const

const BASELINE_STAT_PREFIXES = [
  'echo.reduxCommit',
  'echo.firstRender',
  'echo.reduxToDom',
  'echo.assistantFirstVisible',
  'echo.streamCompletion'
] as const

const ATTRIBUTION_STAT_PREFIXES = [
  'attribution.longtaskOverlapTotalMs',
  'attribution.longtaskOverlapMaxMs',
  'attribution.frameDeltaMaxMs'
] as const

const ATTRIBUTION_COUNT_RATIO_IDS = [
  'attribution.longtaskSupportedCount',
  'attribution.longtaskSupportedRatio',
  'attribution.mutationResolvedCount',
  'attribution.mutationResolvedRatio',
  'attribution.longtaskOverlapSampleCount',
  'attribution.longtaskOverlapSampleRatio'
] as const

const BASELINE_METRIC_IDS: readonly string[] = [
  ...BASELINE_STAT_PREFIXES.flatMap((prefix) => STAT_SUFFIXES.map((suffix) => `${prefix}.${suffix}`)),
  'echo.samples',
  ...ATTRIBUTION_STAT_PREFIXES.flatMap((prefix) => STAT_SUFFIXES.map((suffix) => `${prefix}.${suffix}`)),
  ...ATTRIBUTION_COUNT_RATIO_IDS
]

const BASELINE_GATE_IDS: readonly string[] = [
  'echo.renderSignal',
  'echo.requestCount',
  'echo.reduxToDomOrder',
  'content.exactReply',
  'main.parity',
  'samples.completed',
  'environment.abi145',
  'privacy.schemaV1',
  'instrumentation.complete',
  'instrumentation.cleanupEndpoint'
]

const BASELINE_METRIC_COUNT = BASELINE_METRIC_IDS.length
const BASELINE_GATE_COUNT = BASELINE_GATE_IDS.length
const TOTAL_METRIC_COUNT = BASELINE_METRIC_COUNT
const TOTAL_GATE_COUNT = BASELINE_GATE_COUNT

const BENCHMARK_ID = 'perf103-high-turn-echo'
const BENCHMARK_NAME =
  'PERF-103 high-turn echo-latency measurement with batch-seeded history (production-build E2E, Electron lane)'
const CANONICAL_COMMAND = 'pnpm test:e2e'
const MOCK_PROVIDER_ID = 'mock-openai'
const MOCK_MODEL = 'mock-model'
const MOCK_MODEL_IDENTITY = {
  id: MOCK_MODEL,
  provider: MOCK_PROVIDER_ID,
  name: 'Mock Model',
  group: 'mock'
} as const
const MARKER_PREFIX = 'p103ht'

function markerFor(sampleIndex: number): string {
  return `${MARKER_PREFIX}-${sampleIndex}`
}

function expectedReplyFor(markerText: string): string {
  return `[Mock ${MOCK_MODEL}] You said: "${markerText.slice(0, 100)}"`
}

function assistantOutputMarkerFor(markerText: string): string {
  return `[Mock ${MOCK_MODEL}] You said: "${markerText.slice(0, 100)}`
}

const SETTLE = {
  mainParityMs: 5000,
  pollMs: 200
} as const

const WATCHDOG = {
  sidebarItemMs: 15000,
  topicActivationMs: 30000,
  textCommitMs: 5000,
  echoMs: 30000,
  completionMs: 60000
} as const

const TEST_TIMEOUT_MS = 1800000

const SEED_CREATED_AT = '2026-08-17T00:00:00.000Z'

/** Configure the test assistant before any seeded topic can establish an anchor. */
async function configureHighTurnContext(page: Page, contextCount: number): Promise<string> {
  const assistantId = await page.evaluate(() => (window as any).store.getState().assistants?.assistants?.[0]?.id)
  expect(assistantId, 'the fixture must provide a default assistant').toBeTruthy()
  await page.evaluate(
    ({ assistantId, contextCount }) => {
      ;(window as any).store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: { assistantId, settings: { contextCount } }
      })
    },
    { assistantId, contextCount }
  )
  const configuredContextCount = await page.evaluate((assistantId) => {
    const assistant = (window as any).store
      .getState()
      .assistants?.assistants?.find((item: any) => item.id === assistantId)
    return assistant?.settings?.contextCount
  }, assistantId)
  expect(configuredContextCount, 'the deterministic test assistant context window must be configured').toBe(
    contextCount
  )
  return assistantId
}

interface SeedEntry {
  message: Record<string, unknown>
  blocks: Array<Record<string, unknown>>
}

function seedCreatedAt(index: number): string {
  return new Date(Date.parse(SEED_CREATED_AT) + index * 1000).toISOString()
}

/** Build deterministic prior user/assistant turns without touching the renderer cache. */
function buildPriorSeeds(topicId: string, assistantId: string, turnCount: number): SeedEntry[] {
  const entries: SeedEntry[] = []
  for (let i = 0; i < turnCount; i++) {
    const userId = `${topicId}-prior-${i}-u`
    const assistantMessageId = `${topicId}-prior-${i}-a`
    const userBlockId = `${topicId}-prior-${i}-ub`
    const assistantBlockId = `${topicId}-prior-${i}-ab`
    const userCreatedAt = seedCreatedAt(i * 2)
    const assistantCreatedAt = seedCreatedAt(i * 2 + 1)
    const modelId = `p103ht-m${i}`

    entries.push({
      message: {
        id: userId,
        role: 'user',
        assistantId,
        topicId,
        status: 'success',
        createdAt: userCreatedAt,
        blocks: [userBlockId]
      },
      blocks: [
        {
          id: userBlockId,
          messageId: userId,
          type: 'main_text',
          status: 'success',
          content: `p103ht prior user ${topicId} ${i}`,
          createdAt: userCreatedAt
        }
      ]
    })
    entries.push({
      message: {
        id: assistantMessageId,
        role: 'assistant',
        assistantId,
        topicId,
        status: 'success',
        createdAt: assistantCreatedAt,
        askId: userId,
        model: { id: modelId, provider: MOCK_PROVIDER_ID, name: `P103HT Model ${i}`, group: 'mock' },
        modelId,
        blocks: [assistantBlockId]
      },
      blocks: [
        {
          id: assistantBlockId,
          messageId: assistantMessageId,
          type: 'main_text',
          status: 'success',
          content: `p103ht prior assistant ${topicId} ${i}`,
          createdAt: assistantCreatedAt
        }
      ]
    })
  }
  return entries
}

// ---------------------------------------------------------------------------
// Page-context helpers — topic activation, state reads
// ---------------------------------------------------------------------------

async function createAndActivateTopic(
  page: Page,
  topicId: string,
  name: string,
  assistantId: string,
  priorEntries: SeedEntry[] = []
): Promise<void> {
  const result = await page.evaluate(
    async ({ topicId, name, assistantId, priorEntries }) => {
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
      if (priorEntries.length > 0) {
        const pasted = await chatDb.pasteMessagesToTopic({ topicId, entries: priorEntries })
        if (!pasted?.ok) return { ok: false, error: 'pasteMessagesToTopic failed' }
      }
      return { ok: true }
    },
    { topicId, name, assistantId, priorEntries }
  )
  if (!result.ok) throw new Error(`createAndActivateTopic(${topicId}): ${result.error}`)

  await assertSeedMainParity(page, topicId, priorEntries)
  const cacheBeforeActivation = await page.evaluate((topicId) => {
    const state = (window as any).store.getState()
    return !Array.isArray(state.messages?.messageIdsByTopic?.[topicId])
  }, topicId)
  expect(
    cacheBeforeActivation,
    `batch seed ${topicId}: renderer message cache must remain empty before activation`
  ).toBe(true)

  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await item.waitFor({ state: 'visible', timeout: WATCHDOG.sidebarItemMs })
  await page.evaluate((topicId) => {
    const store = (window as any).store
    const lifecycle = { sawTrue: false, sawFalseAfterTrue: false }
    const inspect = (): void => {
      const loading = store.getState().messages?.loadingByTopic?.[topicId]
      if (loading === true) lifecycle.sawTrue = true
      if (lifecycle.sawTrue && loading === false) lifecycle.sawFalseAfterTrue = true
    }
    lifecycle.sawTrue = false
    lifecycle.sawFalseAfterTrue = false
    const unsubscribe = store.subscribe(inspect)
    ;(window as any).__p103HighTurnLoadingLifecycle = { lifecycle, unsubscribe }
    inspect()
  }, topicId)

  try {
    await item.click()

    await page.waitForFunction(
      ({ topicId, expectedIds }) => {
        const s = (window as any).store?.getState()
        const lifecycle = (window as any).__p103HighTurnLoadingLifecycle?.lifecycle
        if (!s || !lifecycle) return false
        const ids = s.messages?.messageIdsByTopic?.[topicId]
        if (
          s.messages?.currentTopicId !== topicId ||
          s.messages?.loadingByTopic?.[topicId] !== false ||
          !lifecycle.sawTrue ||
          !lifecycle.sawFalseAfterTrue
        ) {
          return false
        }
        if (!Array.isArray(ids) || ids.length !== expectedIds.length) return false
        if (ids.some((id: string, index: number) => id !== expectedIds[index])) return false
        return expectedIds.every((id: string) => {
          const message = s.messages?.entities?.[id]
          return (
            message?.status === 'success' &&
            Array.isArray(message.blocks) &&
            message.blocks.length === 1 &&
            s.messageBlocks?.entities?.[message.blocks[0]]?.messageId === id &&
            s.messageBlocks?.entities?.[message.blocks[0]]?.status === 'success'
          )
        })
      },
      { topicId, expectedIds: priorEntries.map((entry) => String(entry.message.id)) },
      { timeout: WATCHDOG.topicActivationMs }
    )
  } finally {
    await page.evaluate(() => {
      const state = (window as any).__p103HighTurnLoadingLifecycle
      state?.unsubscribe?.()
      delete (window as any).__p103HighTurnLoadingLifecycle
    })
  }

  if (priorEntries.length > 0) {
    const lastPriorId = String(priorEntries.at(-1)!.message.id)
    await page.waitForFunction(
      (lastPriorId) => {
        const messages = document.querySelectorAll('#messages [data-message-id]')
        return messages.length > 0 && document.getElementById(`message-${lastPriorId}`) !== null
      },
      lastPriorId,
      { timeout: WATCHDOG.topicActivationMs }
    )
  }
  await assertHydratedSeedParity(page, topicId, priorEntries)
}

async function readSampleState(
  page: Page,
  topicId: string
): Promise<{
  ids: string[]
  messages: Array<{
    id: string
    role: string
    status: string
    assistantId: string | null
    askId: string | null
    modelId: string | null
    model: { id: string; provider: string; name: string; group: string } | null
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
      const model = m.model as Record<string, unknown> | undefined
      return {
        id,
        role: String(m.role ?? ''),
        status: String(m.status ?? ''),
        assistantId: m.assistantId == null ? null : String(m.assistantId),
        askId: m.askId == null ? null : String(m.askId),
        modelId: model?.id == null ? (m.modelId == null ? null : String(m.modelId)) : String(model.id),
        model:
          model == null
            ? null
            : {
                id: String(model.id ?? ''),
                provider: String(model.provider ?? ''),
                name: String(model.name ?? ''),
                group: String(model.group ?? '')
              },
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

interface MainParitySnapshot {
  messageCount: number
  ids: string[]
  allOwned: boolean
  roleCounts: { user: number; assistant: number }
  assistantIds: (string | null)[]
  askIds: (string | null)[]
  modelIds: (string | null)[]
  models: Array<{ id: string; provider: string; name: string; group: string } | null>
  statuses: string[]
  messageBlockCounts: number[]
  messageBlockIds: string[][]
  blockIds: string[]
  blockContents: string[]
  blockStatuses: string[]
  blockOwnership: boolean
}

async function readMainTopic(page: Page, topicId: string): Promise<MainParitySnapshot> {
  return page.evaluate(async (topicId) => {
    const result = await (window as any).api.chatDb.fetchMessages({ topicId })
    if (!result?.ok) throw new Error(`fetchMessages failed for ${topicId}`)
    const messages = result.value.messages as Array<Record<string, unknown>>
    const blocks = result.value.blocks as Array<Record<string, unknown>>
    const blockById = new Map(blocks.map((block) => [String(block.id), block]))
    return {
      messageCount: messages.length,
      ids: messages.map((m) => String(m.id)),
      allOwned: messages.every((m) => String(m.topicId) === topicId),
      roleCounts: {
        user: messages.filter((m) => String(m.role) === 'user').length,
        assistant: messages.filter((m) => String(m.role) === 'assistant').length
      },
      assistantIds: messages.map((m) => (m.assistantId == null ? null : String(m.assistantId))),
      askIds: messages.map((m) => (m.askId == null ? null : String(m.askId))),
      modelIds: messages.map((m) => {
        const model = m.model as Record<string, unknown> | undefined
        return model?.id == null ? (m.modelId == null ? null : String(m.modelId)) : String(model.id)
      }),
      models: messages.map((m) => {
        const model = m.model as Record<string, unknown> | undefined
        return model == null
          ? null
          : {
              id: String(model.id ?? ''),
              provider: String(model.provider ?? ''),
              name: String(model.name ?? ''),
              group: String(model.group ?? '')
            }
      }),
      statuses: messages.map((m) => String(m.status ?? '')),
      messageBlockCounts: messages.map((m) => (Array.isArray(m.blocks) ? m.blocks.length : 0)),
      messageBlockIds: messages.map((m) => (Array.isArray(m.blocks) ? m.blocks.map(String) : [])),
      blockIds: blocks.map((b) => String(b.id)),
      blockContents: messages.flatMap((message) =>
        (Array.isArray(message.blocks) ? message.blocks : []).map((blockId) => {
          const block = blockById.get(String(blockId))
          return typeof block?.content === 'string' ? block.content : ''
        })
      ),
      blockStatuses: blocks.map((b) => String(b.status ?? '')),
      blockOwnership: blocks.every(
        (b) => String(b.messageId) !== '' && messages.some((m) => String(m.id) === String(b.messageId))
      )
    }
  }, topicId)
}

async function assertSeedMainParity(page: Page, topicId: string, entries: SeedEntry[]): Promise<void> {
  const result = await page.evaluate(async (topicId) => {
    const fetched = await (window as any).api.chatDb.fetchMessages({ topicId })
    if (!fetched?.ok) throw new Error(`fetchMessages failed for ${topicId}`)
    return fetched.value
  }, topicId)
  const messages = result.messages as Array<Record<string, unknown>>
  const blocks = result.blocks as Array<Record<string, unknown>>

  expect(messages, `batch seed ${topicId}: Main message count`).toHaveLength(entries.length)
  expect(
    messages.map((message) => String(message.id)),
    `batch seed ${topicId}: Main message order`
  ).toEqual(entries.map((entry) => String(entry.message.id)))
  expect(
    messages.every(
      (message) =>
        String(message.topicId) === topicId &&
        String(message.status) === 'success' &&
        Array.isArray(message.blocks) &&
        message.blocks.length === 1
    ),
    `batch seed ${topicId}: every Main message is owned, successful, and has one block`
  ).toBe(true)
  expect(
    messages.map((message) => String(message.role)),
    `batch seed ${topicId}: Main role order`
  ).toEqual(entries.map((entry) => String(entry.message.role)))
  expect(
    messages.map((message) => String(message.createdAt)),
    `batch seed ${topicId}: Main createdAt order`
  ).toEqual(entries.map((entry) => String(entry.message.createdAt)))
  expect(blocks, `batch seed ${topicId}: Main block count`).toHaveLength(entries.length)
  expect(
    blocks.every(
      (block) =>
        String(block.status) === 'success' && messages.some((message) => String(message.id) === String(block.messageId))
    ),
    `batch seed ${topicId}: every Main block is successful and message-owned`
  ).toBe(true)
  expect(
    messages.every((message, index) => {
      const expected = entries[index]!
      const expectedBlock = expected.blocks[0]!
      const actualBlockId = Array.isArray(message.blocks) ? String(message.blocks[0]) : ''
      const actualBlock = blocks.find((block) => String(block.id) === actualBlockId)
      return (
        actualBlockId === String(expectedBlock.id) &&
        String(actualBlock?.messageId) === String(expected.message.id) &&
        String(actualBlock?.status) === 'success' &&
        String(actualBlock?.content) === String(expectedBlock.content)
      )
    }),
    `batch seed ${topicId}: Main block identity and content parity`
  ).toBe(true)
  expect(
    messages.every((message, index) => {
      const expected = entries[index]!.message
      const expectedAskId = expected.askId == null ? undefined : String(expected.askId)
      const actualAskId = message.askId == null ? undefined : String(message.askId)
      return (
        String(message.assistantId ?? '') === String(expected.assistantId ?? '') &&
        actualAskId === expectedAskId &&
        String(message.modelId ?? '') === String(expected.modelId ?? '') &&
        JSON.stringify(message.model ?? null) === JSON.stringify(expected.model ?? null)
      )
    }),
    `batch seed ${topicId}: assistant askId and model identity parity`
  ).toBe(true)
}

async function assertHydratedSeedParity(page: Page, topicId: string, entries: SeedEntry[]): Promise<void> {
  const state = await readSampleState(page, topicId)
  expect(state.ids, `hydrated ${topicId}: Redux message order`).toEqual(
    entries.map((entry) => String(entry.message.id))
  )
  expect(
    state.messages.map((message) => message.role),
    `hydrated ${topicId}: Redux role order`
  ).toEqual(entries.map((entry) => String(entry.message.role)))
  expect(
    state.messages.map((message) => message.askId),
    `hydrated ${topicId}: Redux askId relation`
  ).toEqual(entries.map((entry) => (entry.message.askId == null ? null : String(entry.message.askId))))
  expect(
    state.messages.map((message) => message.assistantId),
    `hydrated ${topicId}: Redux assistant identity`
  ).toEqual(entries.map((entry) => (entry.message.assistantId == null ? null : String(entry.message.assistantId))))
  expect(
    state.messages.map((message) => message.modelId),
    `hydrated ${topicId}: Redux model ID parity`
  ).toEqual(entries.map((entry) => (entry.message.modelId == null ? null : String(entry.message.modelId))))
  expect(
    state.messages.map((message) => message.model),
    `hydrated ${topicId}: Redux model identity parity`
  ).toEqual(
    entries.map((entry) => {
      const model = entry.message.model as Record<string, unknown> | undefined
      return model == null
        ? null
        : {
            id: String(model.id ?? ''),
            provider: String(model.provider ?? ''),
            name: String(model.name ?? ''),
            group: String(model.group ?? '')
          }
    })
  )
  expect(
    state.messages.map((message) => message.blocks),
    `hydrated ${topicId}: Redux message block ownership`
  ).toEqual(entries.map((entry) => [String(entry.blocks[0]!.id)]))
  expect(
    state.blocks.map((block) => ({
      id: block.id,
      messageId: block.messageId,
      status: block.status,
      content: block.content
    })),
    `hydrated ${topicId}: Redux block parity`
  ).toEqual(
    entries.map((entry) => ({
      id: String(entry.blocks[0]!.id),
      messageId: String(entry.message.id),
      status: 'success',
      content: String(entry.blocks[0]!.content)
    }))
  )
}

function mainParityReady(snapshot: MainParitySnapshot, expectedMessages: number, priorTurns: number): boolean {
  const expectedUser = priorTurns + 1
  const expectedAssistant = priorTurns + 1
  return (
    snapshot.messageCount === expectedMessages &&
    snapshot.allOwned &&
    snapshot.roleCounts.user === expectedUser &&
    snapshot.roleCounts.assistant === expectedAssistant &&
    snapshot.statuses.every((s) => s === 'success') &&
    snapshot.messageBlockCounts.every((c) => c === 1) &&
    snapshot.blockStatuses.every((s) => s === 'success') &&
    snapshot.blockOwnership
  )
}

async function readMainTopicSettled(
  page: Page,
  topicId: string,
  expectedMessages: number,
  priorTurns: number
): Promise<MainParitySnapshot> {
  const deadline = Date.now() + SETTLE.mainParityMs
  let snapshot = await readMainTopic(page, topicId)
  while (!mainParityReady(snapshot, expectedMessages, priorTurns) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE.pollMs))
    snapshot = await readMainTopic(page, topicId)
  }
  return snapshot
}

async function waitForCompletion(
  page: Page,
  topicId: string,
  timeoutMs: number,
  minAssistantCount: number = 0
): Promise<void> {
  await page.waitForFunction(
    ({ topicId, minAssistantCount }) => {
      const s = (window as any).store.getState()
      const ids: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
      const assistants = ids
        .map((id: string) => s.messages.entities[id])
        .filter((m: any) => m && String(m.role ?? '') === 'assistant')
      if (assistants.length <= minAssistantCount) return false
      const msg = assistants[assistants.length - 1]
      if (String(msg.status ?? '') !== 'success') return false
      const blocks: string[] = Array.isArray(msg.blocks) ? msg.blocks : []
      if (blocks.length === 0) return false
      return blocks.every((bid: string) => s?.messageBlocks?.entities?.[bid]?.status === 'success')
    },
    { topicId, minAssistantCount },
    { timeout: timeoutMs }
  )
}

// ---------------------------------------------------------------------------
// High-turn measurement sample
// ---------------------------------------------------------------------------

interface HighTurnSample {
  tSend: number
  reduxCommitMs: number
  firstRenderMs: number
  assistantFirstVisibleMs: number
  streamCompletionMs: number
  reduxToDomMs: number
  endpointSource: 'mutation' | 'poll'
  longtaskSupported: number
  intervalOverlapLongtaskCount: number
  longtaskOverlapTotalMs: number
  longtaskOverlapMaxMs: number
  frameDeltaMaxMs: number
  cleanupDone: boolean
}

function measureHighTurnEcho(
  page: Page,
  args: {
    topicId: string
    assistantId: string
    markerText: string
    expectedOutputMarker: string
    echoTimeoutMs: number
    textCommitTimeoutMs: number
  }
): Promise<HighTurnSample> {
  return page.evaluate(
    async ({ topicId, assistantId, markerText, expectedOutputMarker, echoTimeoutMs, textCommitTimeoutMs }) => {
      const store = (window as any).store
      const textarea = document.querySelector('.inputbar textarea') as HTMLTextAreaElement | null
      if (!textarea) throw new Error('measureHighTurnEcho: inputbar textarea not found')
      const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSet) throw new Error('measureHighTurnEcho: textarea native value setter unavailable')
      const messagesEl = document.getElementById('messages')
      if (!messagesEl) throw new Error('measureHighTurnEcho: #messages container not found')

      const expectedUserCount = (store.getState().messages?.messageIdsByTopic?.[topicId]?.length ?? 0) + 1

      // ---- Identity: measured user ID captured on Redux commit ----
      let measuredUserId: string | null = null

      // ---- Redux commit observer (user message) ------------------------------
      let reduxCommitAt = -1
      const checkReduxCommit = (): boolean => {
        if (reduxCommitAt >= 0) return true
        const s = store.getState()
        if (s?.messages?.currentTopicId !== topicId) return false
        const ids: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
        if (ids.length !== expectedUserCount) return false
        const msg = s?.messages?.entities?.[ids[ids.length - 1]]
        if (!msg || String(msg.role ?? '') !== 'user' || String(msg.assistantId ?? '') !== assistantId) {
          return false
        }
        reduxCommitAt = performance.now()
        measuredUserId = ids[ids.length - 1]
        return true
      }
      const unsubscribe = store.subscribe(checkReduxCommit)

      // ---- DOM commit observer (user message) -------------------------------
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
      resolveDomCommit('poll', false)
      const checkDomCommit = (): boolean => resolveDomCommit('poll', true)

      // ---- Assistant first-visible observer (identity-scoped to measured turn) -
      let assistantFirstVisibleAt = -1
      let measuredAssistantId: string | null = null
      const checkAssistantFirstVisible = (): boolean => {
        if (assistantFirstVisibleAt >= 0) return true
        if (!measuredUserId) return false
        const s = store.getState()
        const ids: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
        const assistant = ids
          .map((id: string) => s.messages.entities[id])
          .find(
            (message: any) =>
              message &&
              String(message.role ?? '') === 'assistant' &&
              String(message.assistantId ?? '') === assistantId &&
              String(message.askId ?? '') === measuredUserId
          )
        if (!assistant) return false
        measuredAssistantId = String(assistant.id)
        const el = document.querySelector(
          `#messages .message-assistant[data-message-id="${CSS.escape(measuredAssistantId)}"][data-ask-id="${CSS.escape(measuredUserId)}"]`
        )
        const output = el?.querySelector('.message-content-container .markdown')
        if (el && output && (output.textContent ?? '').includes(expectedOutputMarker)) {
          assistantFirstVisibleAt = performance.now()
          return true
        }
        return false
      }
      const assistantObserver = new MutationObserver(() => {
        checkAssistantFirstVisible()
      })
      assistantObserver.observe(messagesEl, { subtree: true, childList: true, characterData: true })

      // ---- Stream completion observer (identity-scoped to measured user) ------
      let streamCompletionAt = -1
      const checkStreamCompletion = (): boolean => {
        if (streamCompletionAt >= 0) return true
        if (!measuredUserId) return false
        const s = store.getState()
        const ids: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
        const assistant = ids
          .map((id: string) => s.messages.entities[id])
          .find(
            (m: any) =>
              m &&
              String(m.role ?? '') === 'assistant' &&
              String(m.assistantId ?? '') === assistantId &&
              String(m.askId ?? '') === measuredUserId
          )
        if (!assistant) return false
        if (String(assistant.status ?? '') !== 'success') return false
        const blocks: string[] = Array.isArray(assistant.blocks) ? assistant.blocks : []
        if (blocks.length === 0) return false
        if (!blocks.every((bid: string) => s?.messageBlocks?.entities?.[bid]?.status === 'success')) return false
        streamCompletionAt = performance.now()
        return true
      }
      const unsubscribeCompletion = store.subscribe(checkStreamCompletion)

      // ---- Long tasks (PERF-102 pattern) ------------------------------------
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

      // ---- Bounded rAF frame recorder ----------------------------------------
      const MAX_FRAME_SAMPLES = 4096
      const frameTimestamps: number[] = []
      let rafId = 0
      const frameLoop = (): void => {
        if (frameTimestamps.length < MAX_FRAME_SAMPLES) frameTimestamps.push(performance.now())
        rafId = requestAnimationFrame(frameLoop)
      }
      rafId = requestAnimationFrame(frameLoop)

      // ---- Bounded poll helper -----------------------------------------------
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
      let record: Omit<HighTurnSample, 'cleanupDone'> | null = null
      try {
        // Set message text; wait for React commit (send enabled)
        nativeSet.call(textarea, markerText)
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
        await waitFor(
          () => {
            const sendBtn = document.querySelector('.inputbar [role="button"].icon-ic_send')
            return !!sendBtn && sendBtn.getAttribute('aria-disabled') !== 'true'
          },
          textCommitTimeoutMs,
          'message text commit'
        )

        // t0 in the same page task as the synthetic Enter dispatch
        const t0 = performance.now()
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

        // Wait for all four signals
        const allReady = (): boolean =>
          checkReduxCommit() && checkDomCommit() && checkAssistantFirstVisible() && checkStreamCompletion()
        await waitFor(allReady, echoTimeoutMs, 'high-turn echo completion (all four signals)')

        // Long-task delivery checkpoint
        await new Promise((resolve) => setTimeout(resolve, 0))

        // Derive interval-clipped long-task overlap
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

        // Derive max interval-spanning rAF frame delta
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
          assistantFirstVisibleMs: assistantFirstVisibleAt - t0,
          streamCompletionMs: streamCompletionAt - t0,
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
        unsubscribeCompletion()
        observer.disconnect()
        assistantObserver.disconnect()
        if (perfObserver) perfObserver.disconnect()
        cancelAnimationFrame(rafId)
        cleanupDone = true
      }
      return { ...record!, cleanupDone }
    },
    args
  )
}

// ---------------------------------------------------------------------------
// Per-sample correctness gates
// ---------------------------------------------------------------------------

async function assertSampleCorrectness(
  page: Page,
  args: {
    sampleIndex: number
    topicId: string
    sample: HighTurnSample
    markerText: string
    expectedReply: string
    seqBefore: number
    priorTurns: number
    priorEntries: SeedEntry[]
    assistantId: string
  }
): Promise<void> {
  const { sampleIndex, topicId, sample, markerText, expectedReply, seqBefore, priorTurns, priorEntries, assistantId } =
    args
  const expectedTotal = (priorTurns + 1) * 2

  // ---- Timing finiteness + endpoint-specific ordering
  expect(
    Number.isFinite(sample.reduxCommitMs) && sample.reduxCommitMs >= 0,
    `sample ${sampleIndex}: reduxCommitMs must be finite and >= 0 (observed ${sample.reduxCommitMs})`
  ).toBe(true)
  expect(
    Number.isFinite(sample.firstRenderMs) && sample.firstRenderMs >= 0,
    `sample ${sampleIndex}: firstRenderMs must be finite and >= 0 (observed ${sample.firstRenderMs})`
  ).toBe(true)
  expect(
    Number.isFinite(sample.assistantFirstVisibleMs) && sample.assistantFirstVisibleMs >= 0,
    `sample ${sampleIndex}: assistantFirstVisibleMs must be finite and >= 0 (observed ${sample.assistantFirstVisibleMs})`
  ).toBe(true)
  expect(
    Number.isFinite(sample.streamCompletionMs) && sample.streamCompletionMs >= 0,
    `sample ${sampleIndex}: streamCompletionMs must be finite and >= 0 (observed ${sample.streamCompletionMs})`
  ).toBe(true)
  expect(sample.reduxToDomMs, `sample ${sampleIndex}: reduxToDomMs must be >= 0`).toBeGreaterThanOrEqual(0)
  expect(
    sample.streamCompletionMs,
    `sample ${sampleIndex}: streamCompletionMs must be >= reduxCommitMs`
  ).toBeGreaterThanOrEqual(sample.reduxCommitMs - 1e-9)
  expect(
    sample.assistantFirstVisibleMs,
    `sample ${sampleIndex}: assistantFirstVisibleMs must be >= firstRenderMs`
  ).toBeGreaterThanOrEqual(sample.firstRenderMs - 1e-9)
  // Redux stream completion and assistant DOM visibility are independent
  // endpoints; this spec does not impose an ordering between them.

  // ---- Instrumentation completeness
  expect(
    sample.endpointSource === 'mutation' || sample.endpointSource === 'poll',
    `sample ${sampleIndex}: endpointSource must be in {mutation, poll}`
  ).toBe(true)
  expect(
    sample.longtaskSupported === 0 || sample.longtaskSupported === 1,
    `sample ${sampleIndex}: longtaskSupported must be 0 or 1`
  ).toBe(true)
  expect(
    Number.isInteger(sample.intervalOverlapLongtaskCount) && sample.intervalOverlapLongtaskCount >= 0,
    `sample ${sampleIndex}: intervalOverlapLongtaskCount must be integer >= 0`
  ).toBe(true)
  expect(
    Number.isFinite(sample.longtaskOverlapTotalMs) && sample.longtaskOverlapTotalMs >= 0,
    `sample ${sampleIndex}: longtaskOverlapTotalMs must be finite and >= 0`
  ).toBe(true)
  expect(
    Number.isFinite(sample.longtaskOverlapMaxMs) && sample.longtaskOverlapMaxMs >= 0,
    `sample ${sampleIndex}: longtaskOverlapMaxMs must be finite and >= 0`
  ).toBe(true)
  expect(
    sample.longtaskOverlapMaxMs,
    `sample ${sampleIndex}: max clipped overlap cannot exceed total`
  ).toBeLessThanOrEqual(sample.longtaskOverlapTotalMs + 1e-9)
  expect(
    Number.isFinite(sample.frameDeltaMaxMs) && sample.frameDeltaMaxMs >= 0,
    `sample ${sampleIndex}: frameDeltaMaxMs must be finite and >= 0`
  ).toBe(true)
  const anyOverlap = sample.intervalOverlapLongtaskCount > 0
  const totalPositive = sample.longtaskOverlapTotalMs > 0
  const maxPositive = sample.longtaskOverlapMaxMs > 0
  expect(
    anyOverlap === totalPositive && anyOverlap === maxPositive,
    `sample ${sampleIndex}: overlap count/total/max agreement`
  ).toBe(true)
  if (sample.longtaskSupported === 0) {
    expect(
      sample.intervalOverlapLongtaskCount === 0 && sample.longtaskOverlapTotalMs === 0,
      `sample ${sampleIndex}: unsupported observer must record zero overlap`
    ).toBe(true)
  }
  expect(sample.cleanupDone, `sample ${sampleIndex}: cleanupDone must be true`).toBe(true)

  // ---- Redux projection: last user message is the measured one
  const state = await readSampleState(page, topicId)
  expect(state.currentTopicId, `sample ${sampleIndex}: sample topic must be active`).toBe(topicId)
  expect(state.messages.length, `sample ${sampleIndex}: topic must hold ${expectedTotal} messages`).toBe(expectedTotal)

  const userMessages = state.messages.filter((m) => m.role === 'user')
  const assistantMessages = state.messages.filter((m) => m.role === 'assistant')
  expect(userMessages.length, `sample ${sampleIndex}: ${priorTurns + 1} user messages`).toBe(priorTurns + 1)
  expect(assistantMessages.length, `sample ${sampleIndex}: ${priorTurns + 1} assistant messages`).toBe(priorTurns + 1)

  const lastUser = userMessages[userMessages.length - 1]!
  expect(lastUser.status, `sample ${sampleIndex}: last user message must be success`).toBe('success')
  expect(lastUser.blocks, `sample ${sampleIndex}: last user message must own exactly one block`).toHaveLength(1)
  const userBlock = state.blocks.find((b) => b.id === lastUser.blocks[0])
  expect(userBlock, `sample ${sampleIndex}: user block must be loaded`).toBeTruthy()
  expect(userBlock!.status, `sample ${sampleIndex}: user block must be success`).toBe('success')
  expect(userBlock!.content, `sample ${sampleIndex}: user block must carry the sample marker`).toBe(markerText)

  const lastAssistant = assistantMessages[assistantMessages.length - 1]!
  expect(lastAssistant.assistantId, `sample ${sampleIndex}: last assistant must belong to the measured assistant`).toBe(
    assistantId
  )
  expect(lastAssistant.status, `sample ${sampleIndex}: last assistant message must reach success`).toBe('success')
  expect(lastAssistant.askId, `sample ${sampleIndex}: last assistant must share user askId`).toBe(lastUser.id)
  expect(lastAssistant.modelId, `sample ${sampleIndex}: last assistant must use the fixture model`).toBe(MOCK_MODEL)
  expect(lastAssistant.model, `sample ${sampleIndex}: last assistant model identity`).toEqual(MOCK_MODEL_IDENTITY)
  expect(lastAssistant.blocks, `sample ${sampleIndex}: last assistant must own exactly one block`).toHaveLength(1)
  const assistantBlock = state.blocks.find((b) => b.id === lastAssistant.blocks[0])
  expect(assistantBlock, `sample ${sampleIndex}: assistant block must be loaded`).toBeTruthy()
  expect(assistantBlock!.status, `sample ${sampleIndex}: assistant block must be success`).toBe('success')
  expect(assistantBlock!.content, `sample ${sampleIndex}: assistant must complete with exact deterministic reply`).toBe(
    expectedReply
  )
  expect(
    state.blocks.map((block) => block.content),
    `sample ${sampleIndex}: Redux must retain every deterministic seeded and measured block content`
  ).toEqual([
    ...priorEntries.flatMap((entry) => entry.blocks.map((block) => String(block.content))),
    markerText,
    expectedReply
  ])

  // ---- Mock request log
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
    `sample ${sampleIndex}: request must use fixture default model`
  ).toBe(MOCK_MODEL)
  const requestMessages = requests[0]!.parsed?.messages as Array<{ role: string; content: unknown }> | undefined
  expect(Array.isArray(requestMessages), `sample ${sampleIndex}: request must carry messages array`).toBe(true)
  const requestConversation = (requestMessages ?? [])
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: String(message.content ?? '') }))
  const expectedConversation = [
    ...priorEntries.map((entry) => ({
      role: String(entry.message.role),
      content: String(entry.blocks[0]!.content)
    })),
    { role: 'user', content: markerText }
  ]
  expect(
    (requestMessages ?? []).every(
      (message) =>
        message.role === 'user' ||
        message.role === 'assistant' ||
        message.role === 'system' ||
        message.role === 'developer'
    ),
    `sample ${sampleIndex}: request may contain only conversation roles plus system/developer messages`
  ).toBe(true)
  expect(
    requestConversation,
    `sample ${sampleIndex}: request must carry the complete seeded alternating context and measured marker`
  ).toEqual(expectedConversation)
  const requestUserMessages = (requestMessages ?? []).filter((m) => m.role === 'user')
  expect(
    requestUserMessages.at(-1),
    `sample ${sampleIndex}: last request user message must carry the sample marker`
  ).toEqual({ role: 'user', content: markerText })

  // ---- Main SQLite parity
  const main = await readMainTopicSettled(page, topicId, expectedTotal, priorTurns)
  expect(main.messageCount, `sample ${sampleIndex}: Main must hold ${expectedTotal} messages`).toBe(expectedTotal)
  expect(main.allOwned, `sample ${sampleIndex}: all Main rows must be topic-owned`).toBe(true)
  expect(main.roleCounts.user, `sample ${sampleIndex}: Main must have ${priorTurns + 1} user messages`).toBe(
    priorTurns + 1
  )
  expect(main.roleCounts.assistant, `sample ${sampleIndex}: Main must have ${priorTurns + 1} assistant messages`).toBe(
    priorTurns + 1
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
  expect(main.ids, `sample ${sampleIndex}: Main and Redux message order must match`).toEqual(state.ids)
  expect(main.messageBlockIds, `sample ${sampleIndex}: Main and Redux message block ownership must match`).toEqual(
    state.messages.map((message) => message.blocks)
  )
  expect(main.blockIds, `sample ${sampleIndex}: Main and Redux block order must match`).toEqual(
    state.blocks.map((block) => block.id)
  )
  expect(main.blockContents, `sample ${sampleIndex}: Main and Redux block content must match`).toEqual(
    state.blocks.map((block) => block.content)
  )
  expect(main.blockContents.at(-1), `sample ${sampleIndex}: Main measured assistant block exact reply`).toBe(
    expectedReply
  )
  expect(main.assistantIds, `sample ${sampleIndex}: Main and Redux assistant identity metadata must match`).toEqual(
    state.messages.map((message) => message.assistantId)
  )
  expect(main.askIds, `sample ${sampleIndex}: Main and Redux askId metadata must match`).toEqual(
    state.messages.map((message) => message.askId)
  )
  expect(main.modelIds, `sample ${sampleIndex}: Main and Redux model IDs must match`).toEqual(
    state.messages.map((message) => message.modelId)
  )
  expect(main.models, `sample ${sampleIndex}: Main and Redux model identity must match`).toEqual(
    state.messages.map((message) => message.model)
  )
  expect(main.assistantIds.at(-1), `sample ${sampleIndex}: Main measured assistant identity`).toBe(assistantId)
  expect(main.askIds.at(-1), `sample ${sampleIndex}: Main measured assistant askId`).toBe(lastUser.id)
  expect(main.modelIds.at(-1), `sample ${sampleIndex}: Main measured assistant model ID`).toBe(MOCK_MODEL)
  expect(main.models.at(-1), `sample ${sampleIndex}: Main measured assistant model identity`).toEqual(
    MOCK_MODEL_IDENTITY
  )
}

// ---------------------------------------------------------------------------
// Run one full sample
// ---------------------------------------------------------------------------

async function runSample(
  page: Page,
  args: {
    topicId: string
    markerText: string
    sampleIndex: number
    record: boolean
    acc: SampleAccumulator
    priorTurns: number
    priorEntries: SeedEntry[]
    assistantId: string
  }
): Promise<HighTurnSample> {
  const { topicId, markerText, sampleIndex, record, acc, priorTurns, priorEntries, assistantId } = args
  const seqBefore = getRequestSequence()
  const sample = await measureHighTurnEcho(page, {
    topicId,
    assistantId,
    markerText,
    expectedOutputMarker: assistantOutputMarkerFor(markerText),
    echoTimeoutMs: WATCHDOG.echoMs,
    textCommitTimeoutMs: WATCHDOG.textCommitMs
  })
  await waitForCompletion(page, topicId, WATCHDOG.completionMs)
  await assertSampleCorrectness(page, {
    sampleIndex,
    topicId,
    sample,
    markerText,
    expectedReply: expectedReplyFor(markerText),
    seqBefore,
    priorTurns,
    priorEntries,
    assistantId
  })
  if (record) {
    acc.reduxCommit.push(sample.reduxCommitMs)
    acc.firstRender.push(sample.firstRenderMs)
    acc.reduxToDom.push(sample.reduxToDomMs)
    acc.assistantFirstVisible.push(sample.assistantFirstVisibleMs)
    acc.streamCompletion.push(sample.streamCompletionMs)
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
// Statistics + artifact construction
// ---------------------------------------------------------------------------

interface SampleAccumulator {
  reduxCommit: number[]
  firstRender: number[]
  reduxToDom: number[]
  assistantFirstVisible: number[]
  streamCompletion: number[]
  longtaskOverlapTotal: number[]
  longtaskOverlapMax: number[]
  frameDeltaMax: number[]
  longtaskSupportedSamples: number
  mutationResolvedSamples: number
  longtaskOverlapSamples: number
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

function ratioMetric(id: string, name: string, count: number): BenchmarkMetric {
  return { id, name, value: count / SCALE.measuredSamples, unit: 'ratio' }
}

function buildBenchmarkResult(acc: SampleAccumulator, environment: BenchmarkResult['environment']): BenchmarkResult {
  const totalSamples = SCALE.warmupSamples + SCALE.measuredSamples
  const correctness: BenchmarkGate[] = [
    {
      id: 'echo.renderSignal',
      name: 'every measured sample resolved on a real .message-user DOM commit carrying the sample marker',
      kind: 'correctness',
      passed: true,
      detail: `${SCALE.measuredSamples}/${SCALE.measuredSamples} measured samples resolved on a real .message-user DOM commit`
    },
    {
      id: 'echo.requestCount',
      name: 'exactly one product streaming chat-completion request per sample',
      kind: 'correctness',
      passed: true,
      detail: `1/1 product streaming chat-completion request per sample`
    },
    {
      id: 'echo.reduxToDomOrder',
      name: 'Redux user-message commit precedes or equals first .message-user DOM commit',
      kind: 'correctness',
      passed: true,
      detail: `${SCALE.measuredSamples}/${SCALE.measuredSamples} measured samples: reduxToDomMs >= 0`
    },
    {
      id: 'content.exactReply',
      name: 'every sample assistant completed with exact deterministic mock reply',
      kind: 'correctness',
      passed: true,
      detail: `${totalSamples}/${totalSamples} samples completed with exact reply`
    },
    {
      id: 'main.parity',
      name: `Main SQLite authority preserved (${SCALE.messagesPerTopic} messages from ${SCALE.priorTurns} prior turns plus measured turn, one block per message, all success, content parity)`,
      kind: 'correctness',
      passed: true,
      detail: `${totalSamples}/${totalSamples} samples: batch-seeded history plus measured send settled to ${SCALE.messagesPerTopic} topic-owned messages with role and block-content parity`
    },
    {
      id: 'samples.completed',
      name: 'all samples completed with full correctness; measured series finite',
      kind: 'correctness',
      passed: true,
      detail: `${SCALE.warmupSamples} warmup + ${SCALE.measuredSamples} measured samples completed`
    },
    {
      id: 'environment.abi145',
      name: 'measured runtime is Electron ABI 145',
      kind: 'correctness',
      passed: true,
      detail: `abiLane=electron, abi=${environment.abi}, command=${environment.command}`
    },
    {
      id: 'privacy.schemaV1',
      name: 'artifact complies with PERF-001 schema v1 closed set',
      kind: 'correctness',
      passed: true,
      detail:
        'metrics/gates/scale carry only numbers and fixed strings; no content, credentials, paths, or raw DB sizes'
    },
    {
      id: 'instrumentation.complete',
      name: 'every measured sample produced a complete finite instrumentation record',
      kind: 'correctness',
      passed: true,
      detail: `${SCALE.measuredSamples}/${SCALE.measuredSamples} measured samples: complete finite attribution records`
    },
    {
      id: 'instrumentation.cleanupEndpoint',
      name: 'every returned record documents finally cleanup completed',
      kind: 'correctness',
      passed: true,
      detail: `${SCALE.measuredSamples}/${SCALE.measuredSamples} measured samples: cleanupDone=true`
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
        priorTurns: SCALE.priorTurns,
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
        'Same-task Enter dispatch -> Redux commit of the user message in a high-turn topic',
        acc.reduxCommit
      ),
      ...statsMetrics(
        'echo.firstRender',
        'Same-task Enter dispatch -> first .message-user DOM commit in a high-turn topic',
        acc.firstRender
      ),
      ...statsMetrics(
        'echo.reduxToDom',
        'Redux user-message commit -> first .message-user DOM commit (same page clock)',
        acc.reduxToDom
      ),
      ...statsMetrics(
        'echo.assistantFirstVisible',
        'Same-task Enter dispatch -> first .message-assistant DOM commit in a high-turn topic',
        acc.assistantFirstVisible
      ),
      ...statsMetrics(
        'echo.streamCompletion',
        'Same-task Enter dispatch -> assistant message status success in Redux in a high-turn topic',
        acc.streamCompletion
      ),
      { id: 'echo.samples', name: 'Measured echo sample count', value: acc.samples, unit: 'count' },
      ...statsMetrics(
        'attribution.longtaskOverlapTotalMs',
        'Interval-clipped long-task overlap total over [reduxCommitAt, domCommitAt]',
        acc.longtaskOverlapTotal
      ),
      ...statsMetrics(
        'attribution.longtaskOverlapMaxMs',
        'Max interval-clipped long-task overlap over [reduxCommitAt, domCommitAt]',
        acc.longtaskOverlapMax
      ),
      ...statsMetrics(
        'attribution.frameDeltaMaxMs',
        'Max rAF frame delta over frame intervals spanning [reduxCommitAt, domCommitAt]',
        acc.frameDeltaMax
      ),
      countMetric(
        'attribution.longtaskSupportedCount',
        'Samples where PerformanceObserver(longtask) was supported',
        acc.longtaskSupportedSamples
      ),
      ratioMetric(
        'attribution.longtaskSupportedRatio',
        'Fraction of samples with long-task observer supported',
        acc.longtaskSupportedSamples
      ),
      countMetric(
        'attribution.mutationResolvedCount',
        'Samples resolved by MutationObserver callback',
        acc.mutationResolvedSamples
      ),
      ratioMetric(
        'attribution.mutationResolvedRatio',
        'Fraction of samples resolved by MutationObserver',
        acc.mutationResolvedSamples
      ),
      countMetric(
        'attribution.longtaskOverlapSampleCount',
        'Samples with interval-clipped long-task overlap',
        acc.longtaskOverlapSamples
      ),
      ratioMetric(
        'attribution.longtaskOverlapSampleRatio',
        'Fraction of samples with long-task overlap',
        acc.longtaskOverlapSamples
      )
    ],
    gates: correctness
  }
}

// ---------------------------------------------------------------------------
// The measurement test
// ---------------------------------------------------------------------------

test.describe('PERF-103 high-turn echo-latency measurement', () => {
  test.skip(!highTurnEnabled(), 'PERF103_HIGH_TURN=1 required (measurement-only, default-off)')

  test('measures echo in a high-turn topic with prior turn history', async ({ electronApp, mainWindow }) => {
    test.setTimeout(TEST_TIMEOUT_MS)
    const page = mainWindow
    const priorTurns = SCALE.priorTurns

    const assistantId = await configureHighTurnContext(page, priorTurns + 1)

    const acc: SampleAccumulator = {
      reduxCommit: [],
      firstRender: [],
      reduxToDom: [],
      assistantFirstVisible: [],
      streamCompletion: [],
      longtaskOverlapTotal: [],
      longtaskOverlapMax: [],
      frameDeltaMax: [],
      longtaskSupportedSamples: 0,
      mutationResolvedSamples: 0,
      longtaskOverlapSamples: 0,
      samples: 0
    }

    // ---- Phase 1: warmup samples (fresh empty topics, full correctness)
    await test.step('Phase 1: warmup echo samples', async () => {
      for (let w = 0; w < SCALE.warmupSamples; w++) {
        const topicId = `p103ht-warmup-${w}`
        const marker = markerFor(w)
        await createAndActivateTopic(page, topicId, `P103HT Warmup ${w}`, assistantId)
        const sample = await runSample(page, {
          topicId,
          markerText: marker,
          sampleIndex: w,
          record: false,
          acc,
          priorTurns: 0,
          priorEntries: [],
          assistantId
        })
        console.log(
          `[E2E][PERF-103-HT] warmup ${w}: redux=${sample.reduxCommitMs.toFixed(1)}ms ` +
            `render=${sample.firstRenderMs.toFixed(1)}ms asstFirst=${sample.assistantFirstVisibleMs.toFixed(1)}ms ` +
            `completion=${sample.streamCompletionMs.toFixed(1)}ms`
        )
      }
      console.log(`[E2E][PERF-103-HT] warmups done: ${SCALE.warmupSamples} samples`)
    })

    // ---- Phase 2: batch-seed prior history + measured echo samples
    await test.step('Phase 2: measured high-turn echo samples', async () => {
      for (let s = 0; s < SCALE.measuredSamples; s++) {
        const topicId = `p103ht-sample-${s}`
        const topicName = `P103HT Sample ${s}`
        const priorEntries = buildPriorSeeds(topicId, assistantId, priorTurns)
        console.log(`[E2E][PERF-103-HT] sample ${s}: batch-seeding ${priorTurns} prior turns...`)
        await createAndActivateTopic(page, topicId, topicName, assistantId, priorEntries)
        console.log(`[E2E][PERF-103-HT] sample ${s}: batch history hydrated, measuring echo...`)

        const marker = markerFor(s + SCALE.warmupSamples)
        const sample = await runSample(page, {
          topicId,
          markerText: marker,
          sampleIndex: s,
          record: true,
          acc,
          priorTurns,
          priorEntries,
          assistantId
        })
        console.log(
          `[E2E][PERF-103-HT] sample ${s}: redux=${sample.reduxCommitMs.toFixed(1)}ms ` +
            `render=${sample.firstRenderMs.toFixed(1)}ms asstFirst=${sample.assistantFirstVisibleMs.toFixed(1)}ms ` +
            `completion=${sample.streamCompletionMs.toFixed(1)}ms reduxToDom=${sample.reduxToDomMs.toFixed(1)}ms`
        )
      }
      console.log(`[E2E][PERF-103-HT] measured: ${acc.samples}/${SCALE.measuredSamples}`)
    })

    // ---- Phase 3: emit schema v1 artifact
    await test.step('Phase 3: emit schema v1 artifact', async () => {
      const appRuntime = await electronApp.evaluate(() => ({
        node: process.version,
        abiModules: String(process.versions.modules)
      }))
      expect(appRuntime.abiModules, 'measured runtime must be Electron ABI 145').toBe('145')
      const environment: BenchmarkResult['environment'] = {
        ...collectEnvironmentMetadata({ command: CANONICAL_COMMAND }),
        node: appRuntime.node,
        abiLane: 'electron',
        abi: appRuntime.abiModules
      }
      const result = buildBenchmarkResult(acc, environment)

      const metricIds = result.metrics.map((m) => m.id)
      expect(new Set(metricIds).size, 'all metric ids must be unique').toBe(metricIds.length)
      const gateIds = result.gates.map((g) => g.id)
      expect(new Set(gateIds).size, 'all gate ids must be unique').toBe(gateIds.length)
      expect(
        result.metrics.every((m) => Number.isFinite(m.value)),
        'every metric value must be finite'
      ).toBe(true)
      expect(result.metrics.length, `total metric count must be ${TOTAL_METRIC_COUNT}`).toBe(TOTAL_METRIC_COUNT)
      expect(result.gates.length, `total gate count must be ${TOTAL_GATE_COUNT}`).toBe(TOTAL_GATE_COUNT)

      for (const id of BASELINE_METRIC_IDS) {
        expect(metricIds, `baseline metric id must remain: ${id}`).toContain(id)
      }
      for (const id of BASELINE_GATE_IDS) {
        expect(gateIds, `baseline gate id must remain: ${id}`).toContain(id)
      }

      const artifactPath = writeBenchmarkResult(result)
      expect(fs.existsSync(artifactPath), 'artifact must exist').toBe(true)
      console.log(
        `[E2E][PERF-103-HT] schema v1 artifact: ${path.basename(artifactPath)} ` +
          `(${SCALE.warmupSamples} warmup + ${SCALE.measuredSamples} measured, priorTurns=${priorTurns})`
      )
    })
  })
})
