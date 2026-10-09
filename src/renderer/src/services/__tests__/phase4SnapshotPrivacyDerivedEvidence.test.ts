/**
 * Phase 4 regression: coherent snapshot privacy.
 *
 * Renderer-local, diagnostics-only, no IPC/preload/shared-channel/schema/persistence/
 * StoreSync, no B-01..B-05, no calibration harness, no production behavior change.
 *
 * Proves:
 * - getPhase4Snapshot / getPhase4BoundScalars composition stays bounded for
 *   B-06/B-07/B-08/B-09/resident/residentRead and serializes without topic IDs,
 *   message content, paths, or credentials (privacy-safe scalar-only).
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
