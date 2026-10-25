/**
 * Portable message RESULT metadata SYNC E2E — two disposable profiles over a
 * per-test loopback relay, production IPC only, no provider calls.
 *
 * User-visible outcome under test: after a sync the PEER shows the assistant
 * message's token totals and a NON-ZERO thinking duration, i.e. the sanitized
 * portable result container (`usage` / `metrics` / `mentions` / `useful` /
 * display-only `model` identity on messages, `thinking_millsec` on blocks)
 * really crosses and is rendered — while everything provider-bound stays
 * local (no api key, host, pricing or provider metadata on the peer).
 *
 * Seeded evidence is a typed stable ChatDb IPC payload (`appendMessage` with
 * success status), not a live reasoning stream: the container is a persisted
 * result, never a streaming artifact, so no provider round-trip is needed and
 * the assertion values are exact and deterministic.
 *
 * Two ingestion paths are covered:
 *  1. incremental — history written after pairing reaches the peer as ops;
 *  2. cursor-0 bootstrap — history written BEFORE pairing reaches a fresh
 *     peer through the baseline (v6) with the same container.
 *
 * Evidence classes: production ChatDb IPC reads (`fetchMessages`), rendered
 * peer UI (token row + thinking header), and real sync rounds via
 * `window.api.sync.sync()`.
 */
import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/electron.fixture'
import { activateTopic, prepareAssistant } from '../../utils/branch-route-setup'
import {
  closeSecondSyncProfile,
  launchSecondSyncProfile,
  type SecondSyncProfile
} from '../../utils/sync-second-profile'
import {
  appendMessageViaApi,
  ensureTopicViaApi,
  pairProfilesViaApi,
  provisionObserverViaRaw,
  runSyncViaApi,
  setSyncConfigViaApi
} from '../../pages/sync.page'
import { startTestRelay, type TestRelayHandle } from '../../utils/sync-relay'

// Exact, meaningful values asserted on both sides.
const PROMPT_TOKENS = 11
const COMPLETION_TOKENS = 7
const TOTAL_TOKENS = PROMPT_TOKENS + COMPLETION_TOKENS
const TIME_COMPLETION_MS = 900
const TIME_FIRST_TOKEN_MS = 120
const THINKING_MS = 2200
/** Rendered thinking label carries one decimal of seconds (2200ms → "2.2"). */
const THINKING_SECONDS_LABEL = '2.2'

const DISPLAY_LIMIT = 20

interface FetchValue {
  messages: Array<Record<string, unknown>>
  blocks: Array<Record<string, unknown>>
}

async function invokeChatDb(page: Page, method: string, request: unknown): Promise<unknown> {
  return await page.evaluate(
    ({ method: m, request: req }: { method: string; request: unknown }) => {
      const w = window as unknown as { api?: { chatDb?: Record<string, (r: unknown) => Promise<unknown>> } }
      const fn = w.api?.chatDb?.[m]
      if (typeof fn !== 'function') throw new Error(`window.api.chatDb.${m} not found`)
      return fn(req)
    },
    { method, request }
  )
}

function unwrapOk(raw: unknown, source: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') throw new Error(`${source} returned non-object`)
  const envelope = raw as Record<string, unknown>
  if (envelope.ok !== true) throw new Error(`${source} failed: ${JSON.stringify(envelope.error ?? null)}`)
  const value = envelope.value
  if (!value || typeof value !== 'object') throw new Error(`${source} returned no value`)
  return value as Record<string, unknown>
}

async function fetchTopic(page: Page, topicId: string): Promise<FetchValue> {
  const value = unwrapOk(await invokeChatDb(page, 'fetchMessages', { topicId, branchId: null }), 'fetchMessages')
  return {
    messages: (Array.isArray(value.messages) ? value.messages : []) as Array<Record<string, unknown>>,
    blocks: (Array.isArray(value.blocks) ? value.blocks : []) as Array<Record<string, unknown>>
  }
}
/**
 * Baseline (cursor-0) adoption is asynchronous on the receiving side: poll the
 * peer's authoritative read until the message is actually there instead of
 * asserting the instant a sync round returns.
 */
async function waitForPeerMessage(page: Page, topicId: string, messageId: string, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let seen = ''
  while (Date.now() < deadline) {
    const { messages } = await fetchTopic(page, topicId)
    if (messages.some((m) => m.id === messageId)) return
    seen = `peer holds ${messages.length} messages`
    await page.waitForTimeout(1000)
  }
  throw new Error(`peer never received ${messageId} (${seen})`)
}

/** The production automation publishes the relay baseline asynchronously. */
async function waitForRelayBaseline(endpoint: string, approverPage: Page, timeoutMs = 120000): Promise<void> {
  const observer = await provisionObserverViaRaw(endpoint, approverPage)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${endpoint}/sync/baseline`, {
      headers: { 'x-sync-device-code': observer.code, 'x-sync-device-secret': observer.secret }
    })
    if (res.status === 200) {
      const body = (await res.json()) as { watermark?: unknown }
      if (typeof body.watermark === 'number' && Number.isSafeInteger(body.watermark) && body.watermark > 0) return
    }
    await approverPage.waitForTimeout(1000)
  }
  throw new Error('relay never published a baseline watermark')
}

/**
 * Convergence poll for the baseline path: baseline adoption is asynchronous, so
 * run bounded sync rounds while reading the peer until the message is there.
 */
async function convergePeerMessage(
  pageA: Page,
  pageB: Page,
  topicId: string,
  messageId: string,
  timeoutMs = 120000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let rounds = 0
  let seen = ''
  while (Date.now() < deadline) {
    const { messages } = await fetchTopic(pageB, topicId)
    if (messages.some((m) => m.id === messageId)) return
    seen = `peer holds ${messages.length} messages`
    rounds += 1
    await runSyncViaApi(pageA).catch(() => undefined)
    await runSyncViaApi(pageB).catch(() => undefined)
    await pageB.waitForTimeout(2000)
  }
  throw new Error(`peer never adopted ${messageId} (${seen}, rounds=${rounds})`)
}

function isoNow(): string {
  return new Date().toISOString()
}

/**
 * One success assistant turn carrying the full portable result container plus
 * deliberately non-portable local-only keys that must never reach the peer.
 */
function metadataMessage(id: string, topicId: string, modelId: string): Record<string, unknown> {
  const now = isoNow()
  return {
    id,
    topicId,
    role: 'assistant',
    content: 'metadata-sync answer',
    status: 'success',
    model: { id: modelId, name: 'E2E Model', group: 'E2E Group' },
    modelId,
    createdAt: now,
    updatedAt: now,
    // portable container inputs (message overflow)
    usage: { prompt_tokens: PROMPT_TOKENS, completion_tokens: COMPLETION_TOKENS, total_tokens: TOTAL_TOKENS },
    metrics: {
      completion_tokens: COMPLETION_TOKENS,
      time_completion_millsec: TIME_COMPLETION_MS,
      time_first_token_millsec: TIME_FIRST_TOKEN_MS
    },
    mentions: [{ id: modelId, name: 'E2E Model' }],
    useful: true,
    // LOCAL ONLY — must be dropped by the sanitizer and never cross
    apiKey: 'sk-live-should-not-sync',
    apiHost: 'https://internal.example.invalid',
    providerMetadata: { cached: 4 },
    pricing: { input_per_million_tokens: 3, output_per_million_tokens: 9, currencySymbol: '$' }
  } as unknown as Record<string, unknown>
}

function metadataBlocks(messageId: string): Record<string, unknown>[] {
  const now = isoNow()
  return [
    {
      id: `${messageId}-thinking`,
      messageId,
      type: 'thinking',
      content: 'reasoning body',
      status: 'success',
      createdAt: now,
      updatedAt: now,
      thinking_millsec: THINKING_MS
    },
    {
      id: `${messageId}-text`,
      messageId,
      type: 'main_text',
      content: 'metadata-sync answer',
      status: 'success',
      createdAt: now,
      updatedAt: now
    }
  ]
}

/** Authoritative peer assertions on the persisted container. */
async function expectPersistedMetadata(page: Page, topicId: string, messageId: string): Promise<void> {
  const { messages, blocks } = await fetchTopic(page, topicId)
  const message = messages.find((m) => m.id === messageId)
  expect(message, `peer must hold message ${messageId}`).toBeTruthy()
  expect(message!.usage).toMatchObject({
    prompt_tokens: PROMPT_TOKENS,
    completion_tokens: COMPLETION_TOKENS,
    total_tokens: TOTAL_TOKENS
  })
  expect(message!.metrics).toMatchObject({
    completion_tokens: COMPLETION_TOKENS,
    time_completion_millsec: TIME_COMPLETION_MS,
    time_first_token_millsec: TIME_FIRST_TOKEN_MS
  })
  expect(message!.mentions).toEqual([{ id: 'openai/gpt-4o-e2e', name: 'E2E Model' }])
  expect(message!.useful).toBe(true)
  // Display-only model identity crosses; provider bindings/pricing never do.
  expect(message!.model).toMatchObject({ id: 'openai/gpt-4o-e2e', name: 'E2E Model', group: 'E2E Group' })
  expect((message!.model as Record<string, unknown>).pricing).toBeUndefined()
  expect((message!.model as Record<string, unknown>).apiKey).toBeUndefined()
  for (const forbidden of ['apiKey', 'apiHost', 'providerMetadata', 'pricing']) {
    expect(message![forbidden], `peer must not persist local-only key ${forbidden}`).toBeUndefined()
  }

  const thinking = blocks.find((b) => b.id === `${messageId}-thinking`)
  expect(thinking, 'peer must hold the thinking block').toBeTruthy()
  expect(thinking!.thinking_millsec).toBe(THINKING_MS)
}

/** Rendered peer UI evidence: token totals and a non-zero thinking duration. */
async function expectRenderedMetadata(page: Page, topicId: string): Promise<void> {
  await activateTopic(page, topicId, 1)
  const tokenRow = page.locator('#messages .message-tokens').first()
  await tokenRow.waitFor({ state: 'visible', timeout: 30000 })
  const tokenText = (await tokenRow.textContent()) ?? ''
  expect(tokenText, 'rendered token total').toContain(String(TOTAL_TOKENS))
  expect(tokenText, 'rendered prompt tokens').toContain(`↑${PROMPT_TOKENS}`)
  expect(tokenText, 'rendered completion tokens').toContain(`↓${COMPLETION_TOKENS}`)

  // Thinking header carries the completed duration (never a 0.0s placeholder).
  const thinkingMeta = page.locator('#messages .thinking-title-meta').first()
  await thinkingMeta.waitFor({ state: 'visible', timeout: 30000 })
  const thinkingText = (await thinkingMeta.textContent()) ?? ''
  expect(thinkingText, 'rendered thinking duration').toContain(THINKING_SECONDS_LABEL)
}

test.describe('portable message result metadata sync', () => {
  test.setTimeout(300000)

  let relay: TestRelayHandle | null = null
  let second: SecondSyncProfile | null = null

  test.beforeEach(async () => {
    relay = await startTestRelay()
  })

  test.afterEach(async () => {
    if (second) {
      await closeSecondSyncProfile(second).catch(() => {})
      second = null
    }
    if (relay) {
      await relay.close().catch(() => {})
      relay = null
    }
  })

  async function connectPaired(mainWindow: Page, ownedTmpRoot: string, mockPort: number) {
    relay = relay ?? (await startTestRelay())
    second = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
    const pageA = mainWindow
    const pageB = second.page
    await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
    await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
    await pairProfilesViaApi(pageA, pageB)
    return { pageA, pageB }
  }

  async function seedMetadataTurn(pageA: Page, displayCount: number) {
    const assistantId = await prepareAssistant(pageA, displayCount)
    const topicId = `e2e-meta-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const messageId = `${topicId}-answer`
    await ensureTopicViaApi(pageA, topicId, 'Metadata Sync', assistantId)
    await appendMessageViaApi(
      pageA,
      topicId,
      metadataMessage(messageId, topicId, 'openai/gpt-4o-e2e'),
      metadataBlocks(messageId)
    )
    return { topicId, messageId }
  }

  test('incremental: the peer receives and renders token totals plus a non-zero thinking duration', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const { pageA, pageB } = await connectPaired(mainWindow, ownedTmpRoot, mockPort)
    // Settle the initial pairing/bootstrap round on both sides first.
    await runSyncViaApi(pageA)
    await runSyncViaApi(pageB)

    const { topicId, messageId } = await seedMetadataTurn(pageA, DISPLAY_LIMIT)
    await runSyncViaApi(pageA)
    await runSyncViaApi(pageB)

    await waitForPeerMessage(pageB, topicId, messageId)
    await expectPersistedMetadata(pageB, topicId, messageId)
    await expectRenderedMetadata(pageB, topicId)
  })

  test('cursor-0 bootstrap: pre-pair history reaches a fresh peer through the baseline', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    // History exists BEFORE the channel does: the peer can only learn it from
    // the baseline, which is exactly the adoption/bootstrap path.
    const { topicId, messageId } = await seedMetadataTurn(mainWindow, DISPLAY_LIMIT)
    const { pageA, pageB } = await connectPaired(mainWindow, ownedTmpRoot, mockPort)
    expect(pageA).toBe(mainWindow)

    // The baseline is published by the production automation; wait for the
    // relay to hold one, then converge (adoption is asynchronous on the peer).
    await waitForRelayBaseline(relay!.endpoint, pageA)
    await convergePeerMessage(pageA, pageB, topicId, messageId)

    await expectPersistedMetadata(pageB, topicId, messageId)
    await expectRenderedMetadata(pageB, topicId)
    // The authoring profile keeps its own rendering too (no local regression).
    await expectRenderedMetadata(pageA, topicId)
  })
})
