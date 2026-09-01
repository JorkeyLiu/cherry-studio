/**
 * Phase 4 regression: coherent snapshot privacy + C-02 derived-evidence fail-closed.
 *
 * Renderer-local, diagnostics-only, no IPC/preload/shared-channel/schema/persistence/
 * StoreSync, no B-01..B-05, no calibration harness, no production behavior change.
 *
 * Proves:
 * - getPhase4Snapshot / getPhase4BoundScalars composition stays bounded for
 *   B-06/B-07/B-08/B-09/resident/residentRead and serializes without topic IDs,
 *   message content, paths, or credentials (privacy-safe scalar-only).
 * - C-02 hardened predicates remain fail-closed:
 *   whole-topic 1..25 valid only with no divider anywhere + null anchor;
 *   partial >25 valid only with inside-messages divider + exact final-topic-owned anchor;
 *   outside/global divider invalid;
 *   non-finite/non-integer/zero/>100 counts fail closed;
 *   heap/DOM/group derivation remains based on measured evidence (caller booleans ignored).
 */

import { configureStore } from '@reduxjs/toolkit'
import {
  createContentSearchSessionOwnerId,
  recordContentSearchCommit,
  releaseContentSearchSessionIfOwned,
  resetContentSearchDiagnosticsForTests
} from '@renderer/components/contentSearchDiagnostics'
import { createLatestMessageWindow } from '@renderer/pages/home/Messages/messageWindow'
import {
  computeClosureFingerprint,
  enforceContextClosureRetention,
  resetAllClosureStateForTests,
  resetContextClosureDiagnosticsForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import { getPhase4BoundScalars, getPhase4Snapshot } from '@renderer/services/phase4Observability'
import { getResidentDiagnostics } from '@renderer/services/residentDiagnostics'
import {
  recordResidentReadDiscard,
  recordResidentReadHit,
  recordResidentReadMiss,
  recordStagedLatency,
  resetResidentReadDiagnosticsForTests
} from '@renderer/services/residentReadDiagnostics'
import {
  getScrollSnapshotDiagnostics,
  handleScrollSnapshotSaved,
  resetScrollSnapshotCacheForTests,
  resetScrollSnapshotDiagnosticsForTests
} from '@renderer/services/scrollSnapshotCache'
import residentRegistryReducer, { bumpGeneration, publishResidentComplete } from '@renderer/store/residentRegistry'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it } from 'vitest'

import type { RendererHeapSample } from '../../../../../tests/e2e/utils/perfHeapCalibration'
// Reuse C-02 pure helpers — renderer-local import of the e2e measurement helper
// (pure, deterministic, no production behavior change).
import {
  buildC02BenchmarkResult,
  buildC02MixedBenchmarkResult,
  buildC02MixedSyntheticTopics,
  buildC02SyntheticTopics,
  C02_DEFAULT_CONTEXTCOUNT,
  C02_HEAP_PROFILE_IDS,
  C02_HEAP_PROFILES,
  C02_MIXED_HEAP_PROFILE_IDS,
  C02_MIXED_HEAP_PROFILES,
  C02_PRODUCTION_WINDOW_MAX,
  C02_PRODUCTION_WINDOW_MIN,
  c02ExpectedVisibleCount,
  c02MixedExpectedVisibleCountForSpec,
  canonicalBytesForTopics,
  classifyEffectiveHeapDeltaInformative,
  createC02VerifiedEvidenceForTest,
  deriveEffectiveHeapInformative,
  deriveFinalTopicDomProof,
  deriveGroupCountExact,
  isC02ContextEvidenceValid,
  isC02ExactTopicOwned,
  isC02PersistedTopicOwned,
  isC02ProductionPathComplete,
  isC02WholeTopicWindow,
  RENDERER_HEAP_METHOD
} from '../../../../../tests/e2e/utils/perfHeapCalibration'

function c02DomEncodeForTest(plain: string | null): string | null {
  if (plain === null) return null
  return `${plain.length}:${plain}`
}

// ---------------------------------------------------------------------------
// Sentinels — must never appear in any scalar snapshot/serialized output
// ---------------------------------------------------------------------------
const SENTINEL_TOPIC = 'SENTINEL_TOPIC_priv_9c284b7f-7f3a9b'
const SENTINEL_CONTENT = 'SENTINEL_CONTENT_abc123xyz_UNIQUE'
const SENTINEL_PATH = '/tmp/SENTINEL_PATH_cred_secret_456'
const SENTINEL_CREDENTIAL = 'SENTINEL_CREDENTIAL_sk_sentinel_secret_789'
const SENTINEL_HISTORY = 'SENTINEL_HISTORY_entry_999'
const SENTINELS = [SENTINEL_TOPIC, SENTINEL_CONTENT, SENTINEL_PATH, SENTINEL_CREDENTIAL, SENTINEL_HISTORY]

// Minimal helpers to build MessageWindow and resident entries
const message = (id: string, role: Message['role'] = 'user'): Message => ({
  id,
  role,
  askId: role === 'assistant' ? 'u0' : undefined,
  assistantId: 'assistant',
  topicId: 'topic',
  createdAt: '2026-07-19T00:00:00.000Z',
  status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
  blocks: []
})
const users = (count: number): Message[] => Array.from({ length: count }, (_, i) => message(`m${i}`))

function makeWindowResponse(topicId: string, ids: string[]): FetchMessagesWindowResponse {
  const returnedCount = ids.length
  return {
    messages: ids.map((id) => ({ id, topicId })) as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: { limit: 10 },
      firstMessageId: returnedCount > 0 ? ids[0] : null,
      lastMessageId: returnedCount > 0 ? ids[returnedCount - 1] : null,
      returnedCount,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as unknown as FetchMessagesWindowResponse
}

let keyvStore: Map<string, unknown>
function createKeyvMock() {
  return {
    get: (k: string) => keyvStore.get(k),
    set: (k: string, v: unknown) => keyvStore.set(k, v),
    remove: (k: string) => {
      const had = keyvStore.has(k)
      keyvStore.delete(k)
      return had
    },
    keys: () => Array.from(keyvStore.keys()),
    clear: () => keyvStore.clear()
  }
}

// ---------------------------------------------------------------------------
// Snapshot composition suite
// ---------------------------------------------------------------------------
describe('Phase 4 snapshot privacy & bounded composition (renderer-local)', () => {
  beforeEach(() => {
    keyvStore = new Map()
    ;(window as any).keyv = createKeyvMock()
    resetScrollSnapshotCacheForTests()
    resetScrollSnapshotDiagnosticsForTests()
    resetAllClosureStateForTests()
    resetContextClosureDiagnosticsForTests()
    resetContentSearchDiagnosticsForTests()
    resetResidentReadDiagnosticsForTests()
  })

  it('getPhase4Snapshot + getPhase4BoundScalars stay bounded and privacy-safe', () => {
    // B-06: bounded viewport window (200) via public API — inject all sentinel categories into realistic message fields
    const baseMsgs = users(340)
    const sentinelMessages: Message[] = [
      {
        id: SENTINEL_CONTENT,
        role: 'user',
        assistantId: 'assistant',
        topicId: SENTINEL_TOPIC,
        createdAt: '2026-07-19T00:00:00.000Z',
        status: UserMessageStatus.SUCCESS,
        blocks: [SENTINEL_CREDENTIAL, SENTINEL_HISTORY] as unknown as Message['blocks']
      } as unknown as Message,
      {
        id: SENTINEL_CREDENTIAL,
        role: 'assistant',
        askId: SENTINEL_HISTORY,
        assistantId: 'assistant',
        topicId: SENTINEL_TOPIC,
        createdAt: '2026-07-19T00:00:00.000Z',
        status: AssistantMessageStatus.SUCCESS,
        blocks: [SENTINEL_PATH, SENTINEL_CONTENT] as unknown as Message['blocks']
      } as unknown as Message,
      {
        id: SENTINEL_HISTORY,
        role: 'user',
        assistantId: 'assistant',
        topicId: SENTINEL_TOPIC,
        createdAt: '2026-07-19T00:00:00.000Z',
        status: UserMessageStatus.SUCCESS,
        blocks: [SENTINEL_HISTORY] as unknown as Message['blocks']
      } as unknown as Message,
      {
        id: SENTINEL_PATH,
        role: 'user',
        assistantId: 'assistant',
        topicId: SENTINEL_TOPIC,
        createdAt: '2026-07-19T00:00:00.000Z',
        status: UserMessageStatus.SUCCESS,
        blocks: [SENTINEL_CREDENTIAL] as unknown as Message['blocks']
      } as unknown as Message
    ]
    const winMsgs = [...baseMsgs, ...sentinelMessages]
    const win = createLatestMessageWindow(winMsgs, 350)
    expect(win.groupCount).toBeLessThanOrEqual(200)

    // B-07: exceed 256 via scroll saves, but index stays bounded — cycle all sentinel categories via realistic anchorId field
    const sentinelCycle = [SENTINEL_CONTENT, SENTINEL_CREDENTIAL, SENTINEL_HISTORY, SENTINEL_PATH]
    for (let i = 0; i < 260; i++) {
      const k = `scroll:topic-bounded-${String(i).padStart(3, '0')}`
      const anchor = sentinelCycle[i % sentinelCycle.length]
      keyvStore.set(k, { scrollTop: i, anchorId: anchor, isAtBottom: false })
      handleScrollSnapshotSaved(k, Date.now() + i)
    }
    const b07 = getScrollSnapshotDiagnostics()
    expect(b07.indexCount).toBeLessThanOrEqual(256)
    expect(b07.maxCount).toBe(256)

    // B-08: disposable ContentSearch session scalar (at most 500 live)
    const owner = createContentSearchSessionOwnerId()
    recordContentSearchCommit(owner, 500, 0, 1200, 1)
    // B-09: context-closure retention max 1 with all sentinel categories in retained entry via realistic existing fixture fields (messages/blocks/closure)
    const normalTopic = 't-normal'
    const fpNormal = computeClosureFingerprint([
      { id: 'u1', role: 'user', topicId: normalTopic, blocks: [SENTINEL_CREDENTIAL, SENTINEL_HISTORY] },
      { id: SENTINEL_CREDENTIAL, role: 'user', topicId: normalTopic, blocks: [SENTINEL_CONTENT] },
      {
        id: SENTINEL_HISTORY,
        role: 'assistant',
        askId: SENTINEL_CREDENTIAL,
        topicId: normalTopic,
        blocks: [SENTINEL_PATH]
      }
    ] as any)
    setCachedContextClosureWithFingerprint(
      normalTopic,
      {
        messages: [
          { id: 'u1', role: 'user', topicId: normalTopic },
          { id: SENTINEL_CREDENTIAL, role: 'user', topicId: normalTopic },
          { id: SENTINEL_HISTORY, role: 'assistant', askId: SENTINEL_CREDENTIAL, topicId: normalTopic }
        ] as any,
        blocks: [
          { id: 'b-cred', messageId: 'u1', content: SENTINEL_CREDENTIAL },
          { id: 'b-hist', messageId: SENTINEL_CREDENTIAL, content: SENTINEL_HISTORY },
          { id: 'b-content', messageId: SENTINEL_HISTORY, content: SENTINEL_CONTENT },
          { id: 'b-path', messageId: 'u1', filePath: SENTINEL_PATH }
        ] as any,
        closure: {
          completeness: 'context-closure' as const,
          topicId: normalTopic,
          anchorGroupKey: 'u1',
          firstMessageId: 'u1',
          lastMessageId: SENTINEL_HISTORY,
          returnedCount: 3
        }
      } as any,
      fpNormal
    )

    // Also add a closure entry that includes sentinel path as anchor to test redaction (but diagnostics are counts only) — will be evicted by retention
    const sentinelPathTopic = 't-path'
    const fpPath = computeClosureFingerprint([
      { id: SENTINEL_PATH, role: 'user', topicId: sentinelPathTopic, blocks: [] }
    ] as any)
    setCachedContextClosureWithFingerprint(
      sentinelPathTopic,
      {
        messages: [{ id: SENTINEL_PATH, role: 'user', topicId: sentinelPathTopic }] as any,
        blocks: [] as any,
        closure: {
          completeness: 'context-closure' as const,
          topicId: sentinelPathTopic,
          anchorGroupKey: SENTINEL_PATH,
          firstMessageId: SENTINEL_PATH,
          lastMessageId: SENTINEL_PATH,
          returnedCount: 1
        }
      } as any,
      fpPath
    )
    // Enforce active-topic-only retention (max 1) to keep B-09 bounded — mimics production retention enforcement
    enforceContextClosureRetention(normalTopic)

    // Resident: three topics complete, with sentinel content/history/credential/path in windowResponse message ids
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    store.dispatch(bumpGeneration('t-r1'))
    const g1 = (store.getState() as any).residentRegistry.entries['t-r1'].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId: 't-r1',
        generation: g1,
        windowResponse: makeWindowResponse('t-r1', ['m1', SENTINEL_CREDENTIAL, SENTINEL_HISTORY]),
        segments: []
      })
    )
    store.dispatch(bumpGeneration(SENTINEL_TOPIC))
    const gSentinel = (store.getState() as any).residentRegistry.entries[SENTINEL_TOPIC].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId: SENTINEL_TOPIC,
        generation: gSentinel,
        windowResponse: makeWindowResponse(SENTINEL_TOPIC, ['mX', SENTINEL_CONTENT, SENTINEL_PATH]),
        segments: []
      })
    )
    store.dispatch(bumpGeneration(SENTINEL_CREDENTIAL))
    const gCred = (store.getState() as any).residentRegistry.entries[SENTINEL_CREDENTIAL].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId: SENTINEL_CREDENTIAL,
        generation: gCred,
        windowResponse: makeWindowResponse(SENTINEL_CREDENTIAL, [
          SENTINEL_CREDENTIAL,
          SENTINEL_HISTORY,
          SENTINEL_CONTENT
        ]),
        segments: []
      })
    )
    const entries = (store.getState() as any).residentRegistry.entries as Record<string, any>

    // ResidentRead: exercised counters
    recordResidentReadHit()
    recordResidentReadMiss('forced')
    recordResidentReadMiss('incomplete')
    recordStagedLatency(10, true)
    recordStagedLatency(5, false)
    recordResidentReadDiscard('superseded')

    // Coherent snapshot composition
    const snap = getPhase4Snapshot(win, entries)
    const scalars = getPhase4BoundScalars(win, entries)

    // Bounded scalar assertions
    expect(snap.b06).not.toBeNull()
    expect(snap.b06!.groupCount).toBeLessThanOrEqual(200)
    expect(snap.b06!.calibrationDefault).toBe(200)
    expect(snap.b06!.boundedCapacity).toBeLessThanOrEqual(200)
    expect(snap.b07.indexCount).toBeLessThanOrEqual(256)
    expect(snap.b07.maxCount).toBe(256)
    expect(snap.b07.ttlMs).toBeGreaterThan(0)
    expect(snap.b08.liveRangeCount).toBeLessThanOrEqual(500)
    expect(snap.b08.maxLiveRanges).toBe(500)
    expect(snap.b09.retainedTopicCount).toBeLessThanOrEqual(1)
    expect(snap.b09.maxRetainedTopics).toBe(1)
    expect(snap.resident.entryCount).toBeGreaterThanOrEqual(2)
    expect(Number.isFinite(snap.resident.maxGeneration)).toBe(true)
    expect(snap.residentRead.hitCount).toBe(1)
    expect(snap.residentRead.missCount).toBe(2)
    expect(snap.residentRead.stagedCount).toBe(2)
    expect(snap.residentRead.discardedCount).toBe(1)

    // Bound scalars mirrors
    expect(scalars.b06GroupCount).toBeLessThanOrEqual(200)
    expect(scalars.b07IndexCount).toBeLessThanOrEqual(256)
    expect(scalars.b08LiveRangeCount).toBeLessThanOrEqual(500)
    expect(scalars.b09Retained).toBeLessThanOrEqual(1)
    expect(scalars.residentEntryCount).toBe(snap.resident.entryCount)
    expect(scalars.readHitCount).toBe(snap.residentRead.hitCount)

    // Privacy: serialized snapshot + scalars must not expose any sentinel (topic/content/path/credential/history)
    const serialized = JSON.stringify(snap)
    const serializedScalars = JSON.stringify(scalars)
    for (const s of SENTINELS) {
      expect(serialized).not.toContain(s)
      expect(serializedScalars).not.toContain(s)
    }

    // Scalar-only shape: full current nested scalar-only shape with explicit allowlisted keys and scalar/null checks
    expect(Object.keys(snap).sort()).toEqual(['b06', 'b07', 'b08', 'b09', 'resident', 'residentRead'].sort())

    // b06 full shape — 9 scalar keys, trimmedEdge is the only nullable string
    if (snap.b06) {
      const b06Keys = [
        'boundedCapacity',
        'calibrationDefault',
        'didTrim',
        'groupCapacity',
        'groupCount',
        'hasMoreNewer',
        'hasMoreOlder',
        'trimmedEdge',
        'trimmedGroups'
      ]
      expect(Object.keys(snap.b06).sort()).toEqual(b06Keys.sort())
      expect(typeof snap.b06.calibrationDefault).toBe('number')
      expect(Number.isFinite(snap.b06.calibrationDefault)).toBe(true)
      expect(typeof snap.b06.boundedCapacity).toBe('number')
      expect(Number.isFinite(snap.b06.boundedCapacity)).toBe(true)
      expect(typeof snap.b06.groupCount).toBe('number')
      expect(Number.isFinite(snap.b06.groupCount)).toBe(true)
      expect(typeof snap.b06.groupCapacity).toBe('number')
      expect(Number.isFinite(snap.b06.groupCapacity)).toBe(true)
      expect(typeof snap.b06.didTrim).toBe('boolean')
      expect(typeof snap.b06.trimmedGroups).toBe('number')
      expect(Number.isFinite(snap.b06.trimmedGroups)).toBe(true)
      expect(
        snap.b06.trimmedEdge === null || snap.b06.trimmedEdge === 'older' || snap.b06.trimmedEdge === 'newer'
      ).toBe(true)
      expect(typeof snap.b06.hasMoreOlder).toBe('boolean')
      expect(typeof snap.b06.hasMoreNewer).toBe('boolean')
      // No sentinel substring in b06 serialization
      expect(JSON.stringify(snap.b06)).not.toContain(SENTINEL_CONTENT)
      expect(JSON.stringify(snap.b06)).not.toContain(SENTINEL_CREDENTIAL)
    }

    // b07 full shape — indexCount, maxCount, ttlMs, lastEnforcement
    {
      const b07Keys = ['indexCount', 'lastEnforcement', 'maxCount', 'ttlMs']
      expect(Object.keys(snap.b07).sort()).toEqual(b07Keys.sort())
      expect(typeof snap.b07.indexCount).toBe('number')
      expect(Number.isFinite(snap.b07.indexCount)).toBe(true)
      expect(typeof snap.b07.maxCount).toBe('number')
      expect(typeof snap.b07.ttlMs).toBe('number')
      expect(snap.b07.lastEnforcement === null || typeof snap.b07.lastEnforcement === 'object').toBe(true)
      if (snap.b07.lastEnforcement) {
        const leKeys = ['didRebuild', 'expiredRemoved', 'indexCountAfter', 'indexCountBefore', 'lruEvicted']
        expect(Object.keys(snap.b07.lastEnforcement).sort()).toEqual(leKeys.sort())
        expect(typeof snap.b07.lastEnforcement.indexCountBefore).toBe('number')
        expect(typeof snap.b07.lastEnforcement.indexCountAfter).toBe('number')
        expect(typeof snap.b07.lastEnforcement.expiredRemoved).toBe('number')
        expect(typeof snap.b07.lastEnforcement.lruEvicted).toBe('number')
        expect(typeof snap.b07.lastEnforcement.didRebuild).toBe('boolean')
      }
      expect(JSON.stringify(snap.b07)).not.toContain(SENTINEL_TOPIC)
      expect(JSON.stringify(snap.b07)).not.toContain(SENTINEL_HISTORY)
    }

    // b08 full shape — 8 scalar keys
    {
      const b08Keys = [
        'chunkIndex',
        'chunkSize',
        'domGeneration',
        'invalidationCount',
        'liveRangeCount',
        'maxLiveRanges',
        'rescanCount',
        'totalCount'
      ]
      expect(Object.keys(snap.b08).sort()).toEqual(b08Keys.sort())
      for (const k of b08Keys) expect(typeof (snap.b08 as any)[k]).toBe('number')
      expect(Number.isFinite(snap.b08.liveRangeCount)).toBe(true)
      expect(Number.isFinite(snap.b08.maxLiveRanges)).toBe(true)
      expect(JSON.stringify(snap.b08)).not.toContain(SENTINEL_CREDENTIAL)
      expect(JSON.stringify(snap.b08)).not.toContain(SENTINEL_PATH)
    }

    // b09 full shape — 5 scalar keys
    {
      const b09Keys = ['hitCount', 'maxRetainedTopics', 'missCount', 'retainedTopicCount', 'totalAccessCount']
      expect(Object.keys(snap.b09).sort()).toEqual(b09Keys.sort())
      for (const k of b09Keys) expect(typeof (snap.b09 as any)[k]).toBe('number')
      expect(JSON.stringify(snap.b09)).not.toContain(SENTINEL_CONTENT)
      expect(JSON.stringify(snap.b09)).not.toContain(SENTINEL_HISTORY)
    }

    // resident full shape — 6 scalar keys
    {
      const residentKeys = [
        'chatDataCount',
        'entryCount',
        'incompleteCount',
        'maxGeneration',
        'residentCount',
        'segmentsCount'
      ]
      expect(Object.keys(snap.resident).sort()).toEqual(residentKeys.sort())
      for (const k of residentKeys) expect(typeof (snap.resident as any)[k]).toBe('number')
      expect(Number.isFinite(snap.resident.entryCount)).toBe(true)
      expect(JSON.stringify(snap.resident)).not.toContain(SENTINEL_TOPIC)
      expect(JSON.stringify(snap.resident)).not.toContain(SENTINEL_CREDENTIAL)
    }

    // residentRead full shape — 22 scalar keys
    {
      const rrKeys = [
        'discardedCount',
        'discardedCurrentMoved',
        'discardedDeletedDuringFetch',
        'discardedGenerationMismatch',
        'discardedMalformed',
        'discardedSuperseded',
        'hitCount',
        'missCount',
        'missDeletion',
        'missForced',
        'missIncomplete',
        'missLegacyEmpty',
        'missNoEntry',
        'missNoIndex',
        'stagedAvgMs',
        'stagedCount',
        'stagedFailedCount',
        'stagedLastMs',
        'stagedMaxMs',
        'stagedSuccessCount',
        'stagedTotalMs',
        'totalRequests'
      ]
      expect(Object.keys(snap.residentRead).sort()).toEqual(rrKeys.sort())
      for (const k of rrKeys) {
        const v = (snap.residentRead as any)[k]
        expect(v === null || typeof v === 'number').toBe(true)
        if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true)
      }
      expect(JSON.stringify(snap.residentRead)).not.toContain(SENTINEL_HISTORY)
      expect(JSON.stringify(snap.residentRead)).not.toContain(SENTINEL_CONTENT)
    }

    // Bound scalars full shape — explicit allowlisted keys and scalar/null checks
    {
      const scalarKeys = [
        'b06DidTrim',
        'b06GroupCount',
        'b06TrimmedEdge',
        'b07IndexCount',
        'b07MaxCount',
        'b08Invalidations',
        'b08LiveRangeCount',
        'b08MaxLive',
        'b08Rescans',
        'b09Hits',
        'b09MaxRetained',
        'b09Misses',
        'b09Retained',
        'readDiscardedCount',
        'readDiscardedCurrentMoved',
        'readDiscardedDeletedDuringFetch',
        'readDiscardedGenerationMismatch',
        'readDiscardedMalformed',
        'readDiscardedSuperseded',
        'readHitCount',
        'readMissCount',
        'readMissDeletion',
        'readMissForced',
        'readMissIncomplete',
        'readMissLegacyEmpty',
        'readMissNoEntry',
        'readMissNoIndex',
        'readStagedAvgMs',
        'readStagedCount',
        'readStagedFailedCount',
        'readStagedLastMs',
        'readStagedMaxMs',
        'readStagedSuccessCount',
        'readStagedTotalMs',
        'readTotalRequests',
        'residentChatDataCount',
        'residentEntryCount',
        'residentIncompleteCount',
        'residentMaxGeneration',
        'residentResidentCount',
        'residentSegmentsCount'
      ]
      expect(Object.keys(scalars).sort()).toEqual(scalarKeys.sort())
      for (const k of scalarKeys) {
        const v = (scalars as any)[k]
        expect(v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string').toBe(true)
        if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true)
        if (k === 'b06TrimmedEdge') expect(v === null || v === 'older' || v === 'newer').toBe(true)
      }
      // Ensure scalars JSON contains no sentinel either
      for (const s of SENTINELS) expect(JSON.stringify(scalars)).not.toContain(s)
      expect(typeof scalars.b06GroupCount === 'number' || scalars.b06GroupCount === null).toBe(true)
      expect(typeof scalars.residentEntryCount).toBe('number')
      expect(typeof scalars.readHitCount).toBe('number')
    }

    // Also when no window, B-06 is null but other bounds still privacy-safe and scalar-shaped
    const snapNull = getPhase4Snapshot(null, entries)
    expect(snapNull.b06).toBeNull()
    const serNull = JSON.stringify(snapNull)
    for (const s of SENTINELS) expect(serNull).not.toContain(s)
    // Full shape still holds when b06 is null
    expect(Object.keys(snapNull).sort()).toEqual(['b06', 'b07', 'b08', 'b09', 'resident', 'residentRead'].sort())
    const scalarsNull = getPhase4BoundScalars(null, entries)
    for (const s of SENTINELS) expect(JSON.stringify(scalarsNull)).not.toContain(s)

    releaseContentSearchSessionIfOwned(owner)
  })

  it('resident & read-path scalars are bounded and privacy-safe even under sentinel topic pressure', () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    // Create entries that include all sentinel categories — diagnostics must remain scalar counts only
    store.dispatch(bumpGeneration(SENTINEL_TOPIC))
    const gen = (store.getState() as any).residentRegistry.entries[SENTINEL_TOPIC].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId: SENTINEL_TOPIC,
        generation: gen,
        windowResponse: makeWindowResponse(SENTINEL_TOPIC, [SENTINEL_CONTENT, SENTINEL_CREDENTIAL]),
        segments: []
      })
    )
    // Add entry with path sentinel as topic and credential/history as message ids
    store.dispatch(bumpGeneration(SENTINEL_PATH))
    const genPath = (store.getState() as any).residentRegistry.entries[SENTINEL_PATH].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId: SENTINEL_PATH,
        generation: genPath,
        windowResponse: makeWindowResponse(SENTINEL_PATH, [SENTINEL_HISTORY, SENTINEL_CREDENTIAL]),
        segments: []
      })
    )
    // Add entry with history as topic and content/path as message ids
    store.dispatch(bumpGeneration(SENTINEL_HISTORY))
    const genHist = (store.getState() as any).residentRegistry.entries[SENTINEL_HISTORY].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId: SENTINEL_HISTORY,
        generation: genHist,
        windowResponse: makeWindowResponse(SENTINEL_HISTORY, [SENTINEL_CONTENT, SENTINEL_PATH]),
        segments: []
      })
    )
    // Add entry with credential as topic
    store.dispatch(bumpGeneration(SENTINEL_CREDENTIAL))
    const genCred = (store.getState() as any).residentRegistry.entries[SENTINEL_CREDENTIAL].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId: SENTINEL_CREDENTIAL,
        generation: genCred,
        windowResponse: makeWindowResponse(SENTINEL_CREDENTIAL, ['m2', SENTINEL_HISTORY]),
        segments: []
      })
    )
    const entries = (store.getState() as any).residentRegistry.entries
    const diag = getResidentDiagnostics(entries)
    expect(diag.entryCount).toBe(4)
    // Full resident diagnostics shape and privacy — all sentinel categories must not leak
    {
      const residentKeys = [
        'chatDataCount',
        'entryCount',
        'incompleteCount',
        'maxGeneration',
        'residentCount',
        'segmentsCount'
      ]
      expect(Object.keys(diag).sort()).toEqual(residentKeys.sort())
      for (const k of residentKeys) expect(typeof (diag as any)[k]).toBe('number')
      for (const s of SENTINELS) expect(JSON.stringify(diag)).not.toContain(s)
    }

    // Also inject sentinels into closure/scroll fixture state before snapshot to prove privacy (even though snapshot entryCount is 4)
    const fpHist = computeClosureFingerprint([
      { id: SENTINEL_HISTORY, role: 'user', topicId: SENTINEL_HISTORY, blocks: [SENTINEL_CREDENTIAL] }
    ] as any)
    setCachedContextClosureWithFingerprint(
      SENTINEL_HISTORY,
      {
        messages: [{ id: SENTINEL_HISTORY, role: 'user', topicId: SENTINEL_HISTORY }] as any,
        blocks: [{ id: 'b-h', messageId: SENTINEL_HISTORY, content: SENTINEL_CONTENT } as any] as any,
        closure: {
          completeness: 'context-closure' as const,
          topicId: SENTINEL_HISTORY,
          anchorGroupKey: SENTINEL_HISTORY,
          firstMessageId: SENTINEL_HISTORY,
          lastMessageId: SENTINEL_HISTORY,
          returnedCount: 1
        }
      } as any,
      fpHist
    )
    // Scroll snapshot with history sentinel
    keyvStore.set(`scroll:topic-${SENTINEL_HISTORY}`, { scrollTop: 999, anchorId: SENTINEL_HISTORY, isAtBottom: false })
    handleScrollSnapshotSaved(`scroll:topic-${SENTINEL_HISTORY}`, Date.now() + 999)

    const snap = getPhase4Snapshot(null, entries)
    // Full shape checks for this snapshot as well
    expect(Object.keys(snap).sort()).toEqual(['b06', 'b07', 'b08', 'b09', 'resident', 'residentRead'].sort())
    // Each sentinel category absent from both snapshot and scalars
    for (const s of SENTINELS) {
      expect(JSON.stringify(snap.resident)).not.toContain(s)
      expect(JSON.stringify(snap)).not.toContain(s)
    }
    const scalars = getPhase4BoundScalars(null, entries)
    for (const s of SENTINELS) expect(JSON.stringify(scalars)).not.toContain(s)
    // Strong scalar shape for scalars as well
    const expectedScalarKeys = [
      'b06DidTrim',
      'b06GroupCount',
      'b06TrimmedEdge',
      'b07IndexCount',
      'b07MaxCount',
      'b08Invalidations',
      'b08LiveRangeCount',
      'b08MaxLive',
      'b08Rescans',
      'b09Hits',
      'b09MaxRetained',
      'b09Misses',
      'b09Retained',
      'readDiscardedCount',
      'readDiscardedCurrentMoved',
      'readDiscardedDeletedDuringFetch',
      'readDiscardedGenerationMismatch',
      'readDiscardedMalformed',
      'readDiscardedSuperseded',
      'readHitCount',
      'readMissCount',
      'readMissDeletion',
      'readMissForced',
      'readMissIncomplete',
      'readMissLegacyEmpty',
      'readMissNoEntry',
      'readMissNoIndex',
      'readStagedAvgMs',
      'readStagedCount',
      'readStagedFailedCount',
      'readStagedLastMs',
      'readStagedMaxMs',
      'readStagedSuccessCount',
      'readStagedTotalMs',
      'readTotalRequests',
      'residentChatDataCount',
      'residentEntryCount',
      'residentIncompleteCount',
      'residentMaxGeneration',
      'residentResidentCount',
      'residentSegmentsCount'
    ]
    expect(Object.keys(scalars).sort()).toEqual(expectedScalarKeys.sort())
    expect(JSON.stringify(scalars)).not.toContain(SENTINEL_CONTENT)
    expect(JSON.stringify(scalars)).not.toContain(SENTINEL_CREDENTIAL)
    expect(JSON.stringify(scalars)).not.toContain(SENTINEL_HISTORY)
  })
})

// ---------------------------------------------------------------------------
// C-02 hardened predicates — fail-closed
// ---------------------------------------------------------------------------
describe('C-02 hardened predicates — whole-topic/partial/outside-divider/invalid-count fail-closed (renderer-local)', () => {
  it('C02_DEFAULT_CONTEXTCOUNT mirrors production 25 and window helpers clamp correctly', () => {
    expect(C02_DEFAULT_CONTEXTCOUNT).toBe(25)
    expect(C02_PRODUCTION_WINDOW_MIN).toBe(1)
    expect(C02_PRODUCTION_WINDOW_MAX).toBe(100)
  })

  it('isC02WholeTopicWindow: 1..25 true, 26..100 false; invalid counts false', () => {
    for (let n = 1; n <= 25; n++) expect(isC02WholeTopicWindow(n)).toBe(true)
    for (let n = 26; n <= 100; n++) expect(isC02WholeTopicWindow(n)).toBe(false)
    const invalid: number[] = [0, -1, -5, NaN, Infinity, -Infinity, 0.5, 20.5, 25.1, 101, 150]
    for (const c of invalid) expect(isC02WholeTopicWindow(c)).toBe(false)
  })

  it('whole-topic valid only with no divider anywhere and null anchor (1..25), any divider invalid', () => {
    const lastTopicId = 'c02-heap-topic-00'
    const wholeCounts = [1, 20, 25]
    for (const expectedVisibleFinal of wholeCounts) {
      expect(isC02WholeTopicWindow(expectedVisibleFinal)).toBe(true)
      const verified = createC02VerifiedEvidenceForTest(lastTopicId, expectedVisibleFinal, 25)
      // valid: no divider anywhere, null anchor, with canonical persisted proof (LOCK-001 whole-topic requires valid persisted anchor)
      expect(
        isC02ContextEvidenceValid({
          contextBoundaryPresent: false,
          contextBoundaryInsideMessages: false,
          anchorGroupKey: null,
          persistedAnchorGroupKey: verified.persistedAnchorGroupKey,
          expectedAnchorGroupKey: verified.expectedAnchorGroupKey,
          expectedContext: verified.expectedContext,
          lastTopicId,
          expectedVisibleFinal
        })
      ).toBe(true)
      // any divider invalid for whole-topic
      expect(
        isC02ContextEvidenceValid({
          contextBoundaryPresent: true,
          contextBoundaryInsideMessages: true,
          anchorGroupKey: `${lastTopicId}-group`,
          lastTopicId,
          expectedVisibleFinal
        })
      ).toBe(false)
      expect(
        isC02ContextEvidenceValid({
          contextBoundaryPresent: true,
          contextBoundaryInsideMessages: false,
          anchorGroupKey: null,
          lastTopicId,
          expectedVisibleFinal
        })
      ).toBe(false)
      expect(
        isC02ContextEvidenceValid({
          contextBoundaryPresent: false,
          contextBoundaryInsideMessages: false,
          anchorGroupKey: `${lastTopicId}-group`,
          lastTopicId,
          expectedVisibleFinal
        })
      ).toBe(false)
    }
  })

  it('partial valid only with inside-messages divider and exact final-topic-owned anchor (>25)', () => {
    const lastTopicId = 'c02-mixed-topic-03'
    const partialCounts = [26, 50, 100]
    for (const expectedVisibleFinal of partialCounts) {
      expect(isC02WholeTopicWindow(expectedVisibleFinal)).toBe(false)
      const verified = createC02VerifiedEvidenceForTest(lastTopicId, expectedVisibleFinal, 10)
      // missing divider => invalid
      expect(
        isC02ContextEvidenceValid({
          contextBoundaryPresent: false,
          contextBoundaryInsideMessages: false,
          anchorGroupKey: null,
          persistedAnchorGroupKey: verified.persistedAnchorGroupKey,
          expectedAnchorGroupKey: verified.expectedAnchorGroupKey,
          expectedContext: verified.expectedContext,
          lastTopicId,
          expectedVisibleFinal
        })
      ).toBe(false)
      // present but not insideMessages => invalid
      expect(
        isC02ContextEvidenceValid({
          contextBoundaryPresent: true,
          contextBoundaryInsideMessages: false,
          anchorGroupKey: c02DomEncodeForTest(verified.expectedAnchorGroupKey),
          persistedAnchorGroupKey: verified.persistedAnchorGroupKey,
          expectedAnchorGroupKey: verified.expectedAnchorGroupKey,
          expectedContext: verified.expectedContext,
          lastTopicId,
          expectedVisibleFinal
        })
      ).toBe(false)
      // present inside but anchor not owned => invalid
      expect(
        isC02ContextEvidenceValid({
          contextBoundaryPresent: true,
          contextBoundaryInsideMessages: true,
          anchorGroupKey: 'other-topic-group',
          persistedAnchorGroupKey: verified.persistedAnchorGroupKey,
          expectedAnchorGroupKey: verified.expectedAnchorGroupKey,
          expectedContext: verified.expectedContext,
          lastTopicId,
          expectedVisibleFinal
        })
      ).toBe(false)
      // present inside but anchor null => invalid
      expect(
        isC02ContextEvidenceValid({
          contextBoundaryPresent: true,
          contextBoundaryInsideMessages: true,
          anchorGroupKey: null,
          persistedAnchorGroupKey: verified.persistedAnchorGroupKey,
          expectedAnchorGroupKey: verified.expectedAnchorGroupKey,
          expectedContext: verified.expectedContext,
          lastTopicId,
          expectedVisibleFinal
        })
      ).toBe(false)
      // valid: present inside with exact owned anchor (collision-safe, exact identity LOCK-002) — DOM requires encoded singleton
      const validAnchor = verified.expectedAnchorGroupKey
      expect(
        isC02ContextEvidenceValid({
          contextBoundaryPresent: true,
          contextBoundaryInsideMessages: true,
          anchorGroupKey: c02DomEncodeForTest(validAnchor),
          persistedAnchorGroupKey: verified.persistedAnchorGroupKey,
          expectedAnchorGroupKey: verified.expectedAnchorGroupKey,
          expectedContext: verified.expectedContext,
          lastTopicId,
          expectedVisibleFinal
        })
      ).toBe(true)
      // non-exact anchor (extra char) should fail even if owned
      expect(
        isC02ContextEvidenceValid({
          contextBoundaryPresent: true,
          contextBoundaryInsideMessages: true,
          anchorGroupKey: `${validAnchor}X`,
          persistedAnchorGroupKey: verified.persistedAnchorGroupKey,
          expectedAnchorGroupKey: verified.expectedAnchorGroupKey,
          expectedContext: verified.expectedContext,
          lastTopicId,
          expectedVisibleFinal
        })
      ).toBe(false)
      // collision case: anchor contains substring of topic but not exact token -> invalid
      // Our exact matcher allows before/after boundary; prefix with '-' after is valid, so 'c02-mixed-topic-03-extra-group' is still owned
      // For true collision, use topic-03 substring inside topic-031
      expect(
        isC02ContextEvidenceValid({
          contextBoundaryPresent: true,
          contextBoundaryInsideMessages: true,
          anchorGroupKey: 'c02-mixed-topic-031-group',
          lastTopicId: 'c02-mixed-topic-03',
          expectedVisibleFinal
        })
      ).toBe(false)
    }
  })

  it('outside/global divider invalid in both branches', () => {
    const lastTopicId = 'c02-heap-topic-01'
    // whole-topic with outside divider (present true, inside false) => invalid
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: `${lastTopicId}-group`,
        lastTopicId,
        expectedVisibleFinal: 20
      })
    ).toBe(false)
    // partial with global divider => invalid
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: `${lastTopicId}-group`,
        lastTopicId,
        expectedVisibleFinal: 50
      })
    ).toBe(false)
    // even with null anchor outside is invalid
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: null,
        lastTopicId,
        expectedVisibleFinal: 20
      })
    ).toBe(false)
  })

  it('non-finite/non-integer/zero/>100 counts fail closed for both branches', () => {
    const lastTopicId = 'c02-heap-topic-00'
    const validStrict = {
      contextBoundaryPresent: true,
      contextBoundaryInsideMessages: true,
      anchorGroupKey: `${lastTopicId}-group`,
      lastTopicId
    }
    const validWhole = {
      contextBoundaryPresent: false,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: null,
      lastTopicId
    }
    const invalidCounts: number[] = [0, -1, NaN, Infinity, -Infinity, 0.5, 20.5, 101, 150]
    for (const c of invalidCounts) {
      expect(isC02ContextEvidenceValid({ ...validStrict, expectedVisibleFinal: c })).toBe(false)
      expect(isC02ContextEvidenceValid({ ...validWhole, expectedVisibleFinal: c })).toBe(false)
      expect(
        isC02ProductionPathComplete({
          reduxVerified: true,
          finalTopicDomProof: true,
          groupCountExact: true,
          groupOwnershipProof: true,
          contextBoundaryPresent: false,
          contextBoundaryInsideMessages: false,
          anchorGroupKey: null,
          lastTopicId,
          expectedVisibleFinal: c
        })
      ).toBe(false)
    }
  })

  it('isC02ExactTopicOwned collision-safe: exact boundary required', () => {
    expect(isC02ExactTopicOwned('c02-heap-topic-01-group', 'c02-heap-topic-01')).toBe(false)
    expect(isC02PersistedTopicOwned('c02-heap-topic-01-group', 'c02-heap-topic-01')).toBe(true)
    expect(isC02ExactTopicOwned('17:c02-heap-topic-01|17:c02-heap-topic-01', 'c02-heap-topic-01')).toBe(false)
    expect(isC02PersistedTopicOwned('c02-heap-topic-011-group', 'c02-heap-topic-01')).toBe(false)
    expect(isC02ExactTopicOwned('c02-heap-topic-011-group', 'c02-heap-topic-01')).toBe(false)
    expect(isC02PersistedTopicOwned('prefix-c02-heap-topic-01', 'c02-heap-topic-01')).toBe(false)
    expect(isC02ExactTopicOwned('prefix-c02-heap-topic-01', 'c02-heap-topic-01')).toBe(false)
    expect(isC02PersistedTopicOwned('c02-heap-topic-01extra', 'c02-heap-topic-01')).toBe(false)
    expect(isC02ExactTopicOwned('c02-heap-topic-01extra', 'c02-heap-topic-01')).toBe(false)
    expect(isC02ExactTopicOwned(null, 'c02-heap-topic-01')).toBe(false)
    expect(isC02ExactTopicOwned('', 'c02-heap-topic-01')).toBe(false)
  })

  it('isC02ProductionPathComplete combines all proofs fail-closed', () => {
    const lastTopicId = 'c02-heap-topic-00'
    const verifiedGood = createC02VerifiedEvidenceForTest(lastTopicId, 20, 25)
    const goodWhole = {
      reduxVerified: true,
      finalTopicDomProof: true,
      groupCountExact: true,
      groupOwnershipProof: true,
      contextBoundaryPresent: false,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: null,
      persistedAnchorGroupKey: verifiedGood.persistedAnchorGroupKey,
      expectedAnchorGroupKey: verifiedGood.expectedAnchorGroupKey,
      expectedContext: verifiedGood.expectedContext,
      lastTopicId,
      expectedVisibleFinal: 20
    }
    expect(isC02ProductionPathComplete(goodWhole as any)).toBe(true)
    // any single proof missing => false
    expect(isC02ProductionPathComplete({ ...goodWhole, reduxVerified: false } as any)).toBe(false)
    expect(isC02ProductionPathComplete({ ...goodWhole, finalTopicDomProof: false } as any)).toBe(false)
    expect(isC02ProductionPathComplete({ ...goodWhole, groupCountExact: false } as any)).toBe(false)
    expect(isC02ProductionPathComplete({ ...goodWhole, groupOwnershipProof: false } as any)).toBe(false)
    expect(
      isC02ProductionPathComplete({
        ...goodWhole,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        anchorGroupKey: `${lastTopicId}-x`
      } as any)
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// C-02 derived-evidence fail-closed: heap/DOM/group based on measured evidence
// ---------------------------------------------------------------------------
describe('C-02 derived-evidence fail-closed — heap/DOM/group based on measured evidence (renderer-local)', () => {
  function makeEnvironment(): any {
    return {
      timestamp: new Date().toISOString(),
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'electron',
      abi: '145',
      command: 'pnpm test:e2e',
      git: { commit: 'abc123def456abc123def456abc123def456abcd', dirty: false }
    }
  }
  function makeHeapPair(delta: number): { before: RendererHeapSample; after: RendererHeapSample } {
    const before: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const after: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000 + delta,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    return { before, after }
  }

  it('deriveEffectiveHeapInformative fail-closed: only precise && finite positive is informative', () => {
    expect(deriveEffectiveHeapInformative(1000, 'precise')).toBe(true)
    expect(deriveEffectiveHeapInformative(0, 'precise')).toBe(false)
    expect(deriveEffectiveHeapInformative(-1, 'precise')).toBe(false)
    expect(deriveEffectiveHeapInformative(NaN, 'precise')).toBe(false)
    expect(deriveEffectiveHeapInformative(5000, 'bucketed')).toBe(false)
    expect(deriveEffectiveHeapInformative(5000, 'unsupported')).toBe(false)
    // Also via classify
    expect(classifyEffectiveHeapDeltaInformative(5000, 'bucketed').informative).toBe(false)
    expect(classifyEffectiveHeapDeltaInformative(5000, 'precise').informative).toBe(true)
  })

  it('deriveGroupCountExact fail-closed: exact equality only', () => {
    expect(deriveGroupCountExact(50, 50)).toBe(true)
    expect(deriveGroupCountExact(49, 50)).toBe(false)
    expect(deriveGroupCountExact(51, 50)).toBe(false)
    expect(deriveGroupCountExact(0, 0)).toBe(true)
  })

  it('deriveFinalTopicDomProof fail-closed: scoped===global===expected required, non-finite => false', () => {
    expect(deriveFinalTopicDomProof(50, 50, 50)).toBe(true)
    expect(deriveFinalTopicDomProof(50, 49, 50)).toBe(false)
    expect(deriveFinalTopicDomProof(49, 50, 50)).toBe(false)
    expect(deriveFinalTopicDomProof(50, 50, 51)).toBe(false)
    expect(deriveFinalTopicDomProof(NaN, 50, 50)).toBe(false)
    expect(deriveFinalTopicDomProof(50, NaN, 50)).toBe(false)
    expect(deriveFinalTopicDomProof(50, Infinity, 50)).toBe(false)
  })

  it('buildC02BenchmarkResult derivation ignores caller booleans (heap/DOM/group) — fail-closed', () => {
    const profile = {
      syntheticTopics: 1,
      syntheticMessagesPerTopic: 20,
      blockContentBytes: 512,
      segmentCountPerTopic: 0,
      applicabilityGeneration: 0
    }
    const topics = buildC02SyntheticTopics(profile as any)
    const logical = canonicalBytesForTopics(topics)
    const { before, after } = makeHeapPair(2_000_000)
    const env = makeEnvironment()
    const expectedVisible = c02ExpectedVisibleCount(profile as any)
    expect(expectedVisible).toBe(20)
    // Caller lies: informativeness true but precision bucketed => should be non-informative derived
    // and finalTopicDomProof/groupExact true but counts mismatch => derived false
    const allocationLyingCallerTrue = {
      topicsCreated: 1,
      messagesCreated: 20,
      blocksCreated: 20,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: 999, // lying counts irrelevant
        reduxBlocks: 999,
        groupCount: 999, // mismatch vs 20 => derived false, caller says true should be ignored
        displayMessages: 20,
        anchorGroupKey: null,
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: true, // caller says true but displayMessages vs global mismatch will make derived false if we mismatch
        groupExactMatched: true,
        groupsWithFinalTopic: 999,
        globalDisplayMessages: 999
      },
      productionPath: 'lying caller',
      productionPathComplete: true // caller says true, but evidence invalid due to group mismatch => derived false
    }
    const res = buildC02BenchmarkResult(
      env,
      profile as any,
      logical,
      logical,
      before,
      after,
      allocationLyingCallerTrue as any,
      { informative: true, reason: 'lying' },
      'bucketed'
    )
    // Effective heap informative derived false (bucketed), so calibration incomplete
    const cal = res.metrics.find((m) => m.id === 'calibration.complete')!
    expect(cal.value).toBe(0)
    const heapGate = res.gates.find((g) => g.id === 'heap.deltaInformative')!
    expect(heapGate.passed).toBe(false)
    // DOM proof derived false due to global mismatch
    const domGate = res.gates.find((g) => g.id === 'projection.finalTopicOwnership')!
    expect(domGate.passed).toBe(false)
    const prodGate = res.gates.find((g) => g.id === 'productionPath.complete')!
    expect(prodGate.passed).toBe(false)
    // Now caller lies opposite: says false but measured evidence is valid => derived should still be true when precise and counts match
    const { before: b2, after: a2 } = makeHeapPair(1_000)
    const verifiedFor20 = createC02VerifiedEvidenceForTest('c02-heap-topic-00', 20, 25)
    const allocationValidCountsButCallerFalse = {
      topicsCreated: 1,
      messagesCreated: 20,
      blocksCreated: 20,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: 20,
        reduxBlocks: 20,
        groupCount: 20,
        displayMessages: 20,
        anchorGroupKey: null,
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: false, // caller false, derived true
        groupExactMatched: false,
        groupsWithFinalTopic: 20,
        globalDisplayMessages: 20,
        persistedAnchorGroupKey: verifiedFor20.persistedAnchorGroupKey,
        expectedAnchorGroupKey: verifiedFor20.expectedAnchorGroupKey,
        expectedContext: verifiedFor20.expectedContext,
        contextCount: verifiedFor20.contextCount
      },
      productionPath: 'valid but caller false',
      productionPathComplete: false
    }
    const res2 = buildC02BenchmarkResult(
      env,
      profile as any,
      logical,
      logical,
      b2,
      a2,
      allocationValidCountsButCallerFalse as any,
      { informative: false, reason: 'lying false' },
      'precise'
    )
    expect(res2.metrics.find((m) => m.id === 'projection.finalTopicDomProof')!.value).toBe(1)
    expect(res2.gates.find((g) => g.id === 'projection.finalTopicOwnership')!.passed).toBe(true)
    expect(res2.gates.find((g) => g.id === 'productionPath.complete')!.passed).toBe(true)
    expect(res2.gates.find((g) => g.id === 'allocation.resident')!.passed).toBe(true)
    expect(res2.gates.find((g) => g.id === 'calibration.complete')!.passed).toBe(true)
    expect(res2.metrics.find((m) => m.id === 'calibration.complete')!.value).toBe(1)
  })

  it('buildC02BenchmarkResult whole-topic vs partial vs invalid counts emit correct derived completeness', () => {
    const profileWhole = {
      syntheticTopics: 1,
      syntheticMessagesPerTopic: 20,
      blockContentBytes: 512,
      segmentCountPerTopic: 0,
      applicabilityGeneration: 0
    }
    const topicsWhole = buildC02SyntheticTopics(profileWhole as any)
    const logicalWhole = canonicalBytesForTopics(topicsWhole)
    const { before, after } = makeHeapPair(1000)
    const env = makeEnvironment()
    // whole-topic valid — requires persisted proof
    const verifiedWholeAlloc = createC02VerifiedEvidenceForTest('c02-heap-topic-00', 20, 25)
    const allocWholeValid = {
      topicsCreated: 1,
      messagesCreated: 20,
      blocksCreated: 20,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: 20,
        reduxBlocks: 20,
        groupCount: 20,
        displayMessages: 20,
        anchorGroupKey: null,
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: true,
        persistedAnchorGroupKey: verifiedWholeAlloc.persistedAnchorGroupKey,
        expectedAnchorGroupKey: verifiedWholeAlloc.expectedAnchorGroupKey,
        expectedContext: verifiedWholeAlloc.expectedContext,
        contextCount: verifiedWholeAlloc.contextCount,
        groupExactMatched: true,
        groupsWithFinalTopic: 20,
        globalDisplayMessages: 20
      },
      productionPath: 'whole valid',
      productionPathComplete: true
    }
    const resWhole = buildC02BenchmarkResult(
      env,
      profileWhole as any,
      logicalWhole,
      logicalWhole,
      before,
      after,
      allocWholeValid as any,
      { informative: true, reason: 'x' },
      'precise'
    )
    expect(resWhole.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')!.passed).toBe(true)
    expect(resWhole.gates.find((g) => g.id === 'calibration.complete')!.passed).toBe(true)
    // whole-topic with spurious divider should fail
    const allocWholeInvalid = {
      topicsCreated: 1,
      messagesCreated: 20,
      blocksCreated: 20,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: 20,
        reduxBlocks: 20,
        groupCount: 20,
        displayMessages: 20,
        anchorGroupKey: 'c02-heap-topic-00-group',
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: 20,
        globalDisplayMessages: 20
      },
      productionPath: 'whole invalid divider',
      productionPathComplete: true
    }
    const resWholeInvalid = buildC02BenchmarkResult(
      env,
      profileWhole as any,
      logicalWhole,
      logicalWhole,
      before,
      after,
      allocWholeInvalid as any,
      { informative: true, reason: 'x' },
      'precise'
    )
    expect(resWholeInvalid.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')!.passed).toBe(false)
    expect(resWholeInvalid.gates.find((g) => g.id === 'calibration.complete')!.passed).toBe(false)

    // partial valid
    const profilePartial = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.default]
    const topicsPartial = buildC02SyntheticTopics(profilePartial)
    const logicalPartial = canonicalBytesForTopics(topicsPartial)
    const expectedPartial = c02ExpectedVisibleCount(profilePartial)
    expect(expectedPartial).toBe(100)
    const lastTopicId = `c02-heap-topic-${String(profilePartial.syntheticTopics - 1).padStart(2, '0')}`
    const verifiedPartialAlloc = createC02VerifiedEvidenceForTest(lastTopicId, 100, 10)
    const allocPartialValid = {
      topicsCreated: profilePartial.syntheticTopics,
      messagesCreated: profilePartial.syntheticTopics * profilePartial.syntheticMessagesPerTopic,
      blocksCreated: profilePartial.syntheticTopics * profilePartial.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedPartial,
        reduxBlocks: expectedPartial,
        groupCount: expectedPartial,
        displayMessages: expectedPartial,
        anchorGroupKey: c02DomEncodeForTest(verifiedPartialAlloc.expectedAnchorGroupKey),
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedPartial,
        globalDisplayMessages: expectedPartial,
        persistedAnchorGroupKey: verifiedPartialAlloc.persistedAnchorGroupKey,
        expectedAnchorGroupKey: verifiedPartialAlloc.expectedAnchorGroupKey,
        expectedContext: verifiedPartialAlloc.expectedContext,
        contextCount: verifiedPartialAlloc.contextCount
      },
      productionPath: 'partial valid',
      productionPathComplete: true
    }
    const resPartial = buildC02BenchmarkResult(
      env,
      profilePartial,
      logicalPartial,
      logicalPartial,
      before,
      after,
      allocPartialValid as any,
      { informative: true, reason: 'x' },
      'precise'
    )
    expect(resPartial.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')!.passed).toBe(true)
    expect(resPartial.gates.find((g) => g.id === 'calibration.complete')!.passed).toBe(true)
    // partial with outside divider => fail
    const allocPartialOutside = {
      ...allocPartialValid,
      projectionStats: { ...allocPartialValid.projectionStats, contextBoundaryInsideMessages: false as boolean }
    }
    const resOutside = buildC02BenchmarkResult(
      env,
      profilePartial,
      logicalPartial,
      logicalPartial,
      before,
      after,
      allocPartialOutside as any,
      { informative: true, reason: 'x' },
      'precise'
    )
    expect(resOutside.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')!.passed).toBe(false)
  })

  it('buildC02MixedBenchmarkResult also derived fail-closed for whole-topic final (20) vs partial', () => {
    const profile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.oversizedContrast]
    const topics = buildC02MixedSyntheticTopics(profile)
    const logical = canonicalBytesForTopics(topics)
    const { before, after } = makeHeapPair(1000)
    const env = makeEnvironment()
    const expectedFinal = c02MixedExpectedVisibleCountForSpec(profile.topicSpecs[profile.topicSpecs.length - 1])
    expect(expectedFinal).toBe(20)
    const lastTopicIdWhole = `c02-mixed-topic-${String(profile.topicSpecs.length - 1).padStart(2, '0')}`
    const verifiedWhole = createC02VerifiedEvidenceForTest(lastTopicIdWhole, 20, 25)
    const allocWhole = {
      topicsCreated: profile.topicSpecs.length,
      messagesCreated: 260,
      blocksCreated: 260,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedFinal,
        reduxBlocks: expectedFinal,
        groupCount: expectedFinal,
        displayMessages: expectedFinal,
        anchorGroupKey: null,
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedFinal,
        globalDisplayMessages: expectedFinal,
        persistedAnchorGroupKey: verifiedWhole.persistedAnchorGroupKey,
        expectedAnchorGroupKey: verifiedWhole.expectedAnchorGroupKey,
        expectedContext: verifiedWhole.expectedContext,
        contextCount: verifiedWhole.contextCount
      },
      productionPath: 'mixed whole-topic final valid',
      productionPathComplete: true
    }
    const res = buildC02MixedBenchmarkResult(
      env,
      profile,
      logical,
      logical,
      before,
      after,
      allocWhole as any,
      { informative: true, reason: 'x' },
      'precise'
    )
    expect(res.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')!.passed).toBe(true)
  })

  it('buildC02MixedBenchmarkResult partial valid and invalid/outside-divider fail-closed (mixed)', () => {
    const profile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]
    const topics = buildC02MixedSyntheticTopics(profile)
    const logical = canonicalBytesForTopics(topics)
    const { before, after } = makeHeapPair(1000)
    const env = makeEnvironment()
    const expectedFinal = c02MixedExpectedVisibleCountForSpec(profile.topicSpecs[profile.topicSpecs.length - 1])
    expect(expectedFinal).toBe(100)
    // partial valid requires inside-messages divider + exact final-topic-owned anchor (LOCK-002 exact identity)
    expect(isC02WholeTopicWindow(expectedFinal)).toBe(false)
    const lastTopicId = `c02-mixed-topic-${String(profile.topicSpecs.length - 1).padStart(2, '0')}`
    const verifiedPartial = createC02VerifiedEvidenceForTest(lastTopicId, 150, 10)
    const allocValid = {
      topicsCreated: profile.topicSpecs.length,
      messagesCreated: 320,
      blocksCreated: 320,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedFinal,
        reduxBlocks: expectedFinal,
        groupCount: expectedFinal,
        displayMessages: expectedFinal,
        anchorGroupKey: c02DomEncodeForTest(verifiedPartial.expectedAnchorGroupKey),
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedFinal,
        globalDisplayMessages: expectedFinal,
        persistedAnchorGroupKey: verifiedPartial.persistedAnchorGroupKey,
        expectedAnchorGroupKey: verifiedPartial.expectedAnchorGroupKey,
        expectedContext: verifiedPartial.expectedContext,
        contextCount: verifiedPartial.contextCount
      },
      productionPath: 'mixed partial valid',
      productionPathComplete: true
    }
    const resValid = buildC02MixedBenchmarkResult(
      env,
      profile,
      logical,
      logical,
      before,
      after,
      allocValid as any,
      { informative: true, reason: 'x' },
      'precise'
    )
    expect(resValid.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')!.passed).toBe(true)
    expect(resValid.gates.find((g) => g.id === 'calibration.complete')!.passed).toBe(true)
    expect(resValid.gates.find((g) => g.id === 'productionPath.complete')!.passed).toBe(true)

    // partial invalid: outside divider (present true, inside false) => fail
    const allocOutside = {
      ...allocValid,
      projectionStats: { ...allocValid.projectionStats, contextBoundaryInsideMessages: false as boolean }
    }
    const resOutside = buildC02MixedBenchmarkResult(
      env,
      profile,
      logical,
      logical,
      before,
      after,
      allocOutside as any,
      { informative: true, reason: 'x' },
      'precise'
    )
    expect(resOutside.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')!.passed).toBe(false)
    expect(resOutside.gates.find((g) => g.id === 'calibration.complete')!.passed).toBe(false)

    // partial invalid: missing divider
    const allocMissing = {
      ...allocValid,
      projectionStats: {
        ...allocValid.projectionStats,
        contextBoundaryPresent: false as boolean,
        contextBoundaryInsideMessages: false as boolean,
        anchorGroupKey: null
      }
    }
    const resMissing = buildC02MixedBenchmarkResult(
      env,
      profile,
      logical,
      logical,
      before,
      after,
      allocMissing as any,
      { informative: true, reason: 'x' },
      'precise'
    )
    expect(resMissing.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')!.passed).toBe(false)

    // partial invalid: inside but anchor not owned (collision-safe)
    const allocCollision = {
      ...allocValid,
      projectionStats: { ...allocValid.projectionStats, anchorGroupKey: 'c02-mixed-topic-031-group' }
    }
    const resCollision = buildC02MixedBenchmarkResult(
      env,
      profile,
      logical,
      logical,
      before,
      after,
      allocCollision as any,
      { informative: true, reason: 'x' },
      'precise'
    )
    expect(resCollision.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')!.passed).toBe(false)

    // partial invalid: inside but null anchor
    const allocNullAnchor = {
      ...allocValid,
      projectionStats: { ...allocValid.projectionStats, anchorGroupKey: null }
    }
    const resNullAnchor = buildC02MixedBenchmarkResult(
      env,
      profile,
      logical,
      logical,
      before,
      after,
      allocNullAnchor as any,
      { informative: true, reason: 'x' },
      'precise'
    )
    expect(resNullAnchor.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')!.passed).toBe(false)

    // whole-topic mixed with spurious divider should fail (oversizedContrast final 20)
    const profileWhole = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.oversizedContrast]
    const topicsWhole = buildC02MixedSyntheticTopics(profileWhole)
    const logicalWhole = canonicalBytesForTopics(topicsWhole)
    const expectedWhole = c02MixedExpectedVisibleCountForSpec(
      profileWhole.topicSpecs[profileWhole.topicSpecs.length - 1]
    )
    expect(expectedWhole).toBe(20)
    const allocWholeInvalid = {
      topicsCreated: profileWhole.topicSpecs.length,
      messagesCreated: 260,
      blocksCreated: 260,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedWhole,
        reduxBlocks: expectedWhole,
        groupCount: expectedWhole,
        displayMessages: expectedWhole,
        anchorGroupKey: `c02-mixed-topic-03-group`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedWhole,
        globalDisplayMessages: expectedWhole
      },
      productionPath: 'mixed whole invalid divider',
      productionPathComplete: true
    }
    const resWholeInvalid = buildC02MixedBenchmarkResult(
      env,
      profileWhole,
      logicalWhole,
      logicalWhole,
      before,
      after,
      allocWholeInvalid as any,
      { informative: true, reason: 'x' },
      'precise'
    )
    expect(resWholeInvalid.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')!.passed).toBe(false)
    expect(resWholeInvalid.gates.find((g) => g.id === 'calibration.complete')!.passed).toBe(false)

    // Direct predicate checks for mixed partial branch via isC02ContextEvidenceValid — now requires exact canonical proof (LOCK-001/002)
    const verifiedFor30 = createC02VerifiedEvidenceForTest(lastTopicId, 60, 10)
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        anchorGroupKey: c02DomEncodeForTest(verifiedFor30.expectedAnchorGroupKey),
        persistedAnchorGroupKey: verifiedFor30.persistedAnchorGroupKey,
        expectedAnchorGroupKey: verifiedFor30.expectedAnchorGroupKey,
        expectedContext: verifiedFor30.expectedContext,
        lastTopicId,
        expectedVisibleFinal: 30
      })
    ).toBe(true)
    // Non-exact anchor should fail even if owned
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        anchorGroupKey: `${verifiedFor30.expectedAnchorGroupKey}X`,
        persistedAnchorGroupKey: verifiedFor30.persistedAnchorGroupKey,
        expectedAnchorGroupKey: verifiedFor30.expectedAnchorGroupKey,
        expectedContext: verifiedFor30.expectedContext,
        lastTopicId,
        expectedVisibleFinal: 30
      })
    ).toBe(false)
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: c02DomEncodeForTest(verifiedFor30.expectedAnchorGroupKey),
        persistedAnchorGroupKey: verifiedFor30.persistedAnchorGroupKey,
        expectedAnchorGroupKey: verifiedFor30.expectedAnchorGroupKey,
        expectedContext: verifiedFor30.expectedContext,
        lastTopicId,
        expectedVisibleFinal: 30
      })
    ).toBe(false)
  })
})
