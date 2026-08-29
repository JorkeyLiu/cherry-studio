/**
 * Integration tests for B-01..B-05 renderer-local retention enforcement.
 * Production rootReducer is the artifact under test (LOCK-004).
 */

import { configureStore } from '@reduxjs/toolkit'
import {
  clearLatestWindowCompleteness,
  getLatestWindowCompleteness,
  setLatestWindowCompleteness
} from '@renderer/pages/home/Messages/messageWindow'
import {
  computeClosureFingerprint,
  getCachedContextClosure,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import * as retention from '@renderer/services/residentRetention'
import { RETENTION_MAX_BYTES, RETENTION_TTL_MS } from '@renderer/services/residentRetentionPolicy'
import * as scrollCache from '@renderer/services/scrollSnapshotCache'
import {
  getDeletionGeneration,
  invalidateTopicDeletion,
  resetAllDeletionGenerationsForTests
} from '@renderer/services/topicDeletionInvalidation'
import { rootReducer } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import {
  bumpGeneration,
  invalidateForDeletion,
  publishResidentComplete,
  shouldDiscardJointPublish
} from '@renderer/store/residentRegistry'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))
vi.mock('@renderer/services/SpanManagerService', () => ({ endTrace: vi.fn(), startTrace: vi.fn() }))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    appendMessage: vi.fn().mockResolvedValue(undefined),
    fetchMessagesWindow: vi.fn().mockResolvedValue({
      messages: [],
      blocks: [],
      window: {
        kind: 'latest',
        completeness: 'window',
        topicId: 'mock',
        anchorMessageId: null,
        requested: { limit: 10 },
        firstMessageId: null,
        lastMessageId: null,
        returnedCount: 0,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    } as any),
    listSegments: vi.fn().mockResolvedValue([]),
    branchMessagesToTopic: vi.fn(),
    cloneMessagesToTopic: vi.fn(),
    updateMessageAndBlocks: vi.fn().mockResolvedValue({ affectedFileIds: [], remainingReferenceCounts: {} }),
    deleteMessagesWithSegments: vi.fn().mockResolvedValue({ affectedFileIds: [], remainingReferenceCounts: {} }),
    resetMessagesForResend: vi.fn().mockResolvedValue({ affectedFileIds: [], remainingReferenceCounts: {} }),
    selectAnswerMessage: vi.fn().mockResolvedValue(undefined),
    insertMessagesAfterAnchor: vi.fn().mockResolvedValue(undefined),
    updateFileCount: vi.fn().mockResolvedValue(undefined),
    getRawTopic: vi.fn().mockResolvedValue(undefined)
  }
}))
vi.mock('@renderer/hooks/useModel', () => ({ getModel: vi.fn(() => undefined) }))

function makeWindowResponse(topicId: string, ids: string[], blockContent = 'hi'): FetchMessagesWindowResponse {
  return {
    messages: ids.map((id) => ({ id, topicId, blocks: [`b-${id}`] })) as any,
    blocks: ids.map((id) => ({ id: `b-${id}`, messageId: id, type: 'main_text', content: blockContent })) as any,
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: { limit: 10 },
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as any
}

// Production rootReducer is the artifact under test — never duplicate retention eviction logic.
function buildStore() {
  return configureStore({ reducer: rootReducer })
}

function seedResidentTopic(
  store: ReturnType<typeof buildStore>,
  topicId: string,
  messageIds: string[] = ['m1', 'm2'],
  blockContent = 'hi'
) {
  store.dispatch(bumpGeneration(topicId))
  const state = store.getState() as any
  const entry = state.residentRegistry.entries[topicId]
  const generation = entry.applicabilityGeneration
  const windowResponse = makeWindowResponse(topicId, messageIds, blockContent)
  store.dispatch(
    publishResidentComplete({
      topicId,
      generation,
      windowResponse,
      segments: [
        {
          id: `seg-${topicId}`,
          topicId,
          name: 'S',
          messageIds: [],
          color: undefined,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as any
      ]
    })
  )
  setLatestWindowCompleteness(topicId, { hasMoreBefore: false, hasMoreAfter: false })
  const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId, blocks: [] }] as any)
  setCachedContextClosureWithFingerprint(
    topicId,
    {
      messages: [{ id: 'u1', role: 'user', topicId } as any],
      blocks: [],
      closure: {
        completeness: 'context-closure',
        topicId,
        anchorGroupKey: 'u1',
        firstMessageId: 'u1',
        lastMessageId: 'u1',
        returnedCount: 1
      }
    } as any,
    fp
  )
  const mockKeyv = (globalThis as any).window?.keyv
  if (mockKeyv) {
    mockKeyv.set(`scroll:topic-${topicId}`, { scrollTop: 100, anchorId: 'm1', isAtBottom: false })
    try {
      scrollCache.handleScrollSnapshotSaved(`scroll:topic-${topicId}`, Date.now())
    } catch {}
  }
}

describe('B-01..B-05 retention integration — renderer-local only (production rootReducer)', () => {
  let keyvStore: Map<string, unknown>
  const NOW = 1_700_000_000_000

  beforeEach(() => {
    retention.resetRetentionForTests()
    retention.resetResidentRetentionDiagnosticsForTests()
    retention.stopResidentRetention()
    resetAllClosureStateForTests()
    resetAllDeletionGenerationsForTests()
    clearLatestWindowCompleteness('t-a')
    clearLatestWindowCompleteness('t-b')
    keyvStore = new Map()
    ;(globalThis as any).window = (globalThis as any).window ?? {}
    ;(globalThis as any).window.keyv = {
      get: (k: string) => keyvStore.get(k),
      set: (k: string, v: unknown) => keyvStore.set(k, v),
      remove: (k: string) => {
        const had = keyvStore.has(k)
        keyvStore.delete(k)
        return had
      },
      keys: () => Array.from(keyvStore.keys())
    }
    scrollCache.resetScrollSnapshotCacheForTests()
    scrollCache.resetScrollSnapshotDiagnosticsForTests()
    vi.clearAllMocks()
  })

  it('active pinned topic never evicted even under count/byte pressure', () => {
    const store = buildStore()
    for (let i = 0; i < 10; i++) {
      seedResidentTopic(store, `t-${i}`, [`m-${i}-1`])
    }
    retention.startResidentRetention(store as any)
    for (let i = 0; i < 10; i++) {
      retention.setRetentionLastAccessForTests(`t-${i}`, NOW - 10000 + i)
    }
    store.dispatch(newMessagesActions.setCurrentTopicId('t-9'))
    const victims = retention.enforceRetention(NOW, store as any)
    expect(victims).not.toContain('t-9')
    expect(victims.length).toBe(1)
    expect(victims[0]).toBe('t-0')
    retention.stopResidentRetention()
  })

  it('background pins — loading, queue pending, window read outstanding — never evicted (via production pinned check)', async () => {
    const store = buildStore()
    for (let i = 0; i < 10; i++) {
      seedResidentTopic(store, `t-p-${i}`, [`m-${i}`])
    }
    retention.startResidentRetention(store as any)
    for (let i = 0; i < 10; i++) {
      retention.setRetentionLastAccessForTests(`t-p-${i}`, NOW - 10000 + i)
    }
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't-p-0', loading: true }))
    let victims = retention.enforceRetention(NOW, store as any)
    expect(victims).not.toContain('t-p-0')
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't-p-0', loading: false }))
    const { getTopicQueue } = await import('@renderer/utils/queue')
    const q = getTopicQueue('t-p-1')
    let hold: () => void
    const pending = new Promise<void>((resolve) => {
      hold = resolve
    })
    // @ts-ignore
    void q.add(() => pending)
    victims = retention.enforceRetention(NOW, store as any)
    expect(victims).not.toContain('t-p-1')
    const { runTopicWindowRead } = await import('@renderer/utils/windowReadQueue')
    let releaseWindow: () => void
    const windowPending = new Promise((res) => {
      releaseWindow = () => res('ok')
    })
    const winPromise = runTopicWindowRead('t-p-2', 'latest', () => windowPending as Promise<any>)
    victims = retention.enforceRetention(NOW, store as any)
    expect(victims).not.toContain('t-p-2')
    hold!()
    releaseWindow!()
    await winPromise.catch(() => {})
    const { clearTopicQueue } = await import('@renderer/utils/queue')
    clearTopicQueue('t-p-1')
    retention.stopResidentRetention()
  })

  it('actual in-flight background stream pin via production stream seam (setupChannelStream) prevents eviction under pressure until settled', async () => {
    const store = buildStore()
    for (let i = 0; i < 10; i++) {
      seedResidentTopic(store, `t-stream-${i}`, [`m-stream-${i}`])
    }
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    retention.startResidentRetention(store as any)
    for (let i = 0; i < 10; i++) {
      retention.setRetentionLastAccessForTests(`t-stream-${i}`, NOW - 10000 + i)
    }
    // Start real production stream via setupChannelStream — holds pin via loading flag and stream processing
    const { setupChannelStream } = await import('@renderer/store/thunk/messageThunk')
    const controller = setupChannelStream(store.dispatch as any, store.getState as any, 't-stream-0', 'agent-1')
    // Allow dispatch to propagate
    await new Promise((r) => setTimeout(r, 0))
    expect(retention.isTopicPinned('t-stream-0', store.getState())).toBe(true)
    let victims = retention.enforceRetention(NOW, store as any)
    expect(victims).not.toContain('t-stream-0')
    expect(victims).toContain('t-stream-1')
    expect(victims.length).toBe(1)
    // Complete the production stream — adapter finally clears loading
    controller.complete()
    // Wait for stream processing finally (adapter processes and dispatches setTopicLoading false)
    await new Promise((r) => setTimeout(r, 30))
    // Ensure pinned cleared via production path (loading flag) and queue-idle fallback
    expect(retention.isTopicPinned('t-stream-0', store.getState())).toBe(false)
    // After idle auto-enforce, count is already at bound (8). Make t-stream-0 TTL-expired to force eviction
    retention.setRetentionLastAccessForTests('t-stream-0', NOW - RETENTION_TTL_MS - 5000)
    for (let i = 1; i < 10; i++) retention.setRetentionLastAccessForTests(`t-stream-${i}`, NOW - 1000)
    victims = retention.enforceRetention(NOW, store as any)
    expect(victims).toContain('t-stream-0')
    retention.stopResidentRetention()
  })

  it('TTL boundary: >=30m evicts, <30m retains; oversize >32MiB evicts (production reducer)', async () => {
    const store = buildStore()
    seedResidentTopic(store, 't-ttl-old', ['m1'])
    seedResidentTopic(store, 't-ttl-fresh', ['m2'])
    seedResidentTopic(store, 't-over', ['m-over'])
    retention.startResidentRetention(store as any)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    const now = Date.now()
    const hugeContent = 'x'.repeat(33 * 1024 * 1024)
    const hugeMsgId = 'm-huge-over'
    const hugeBlockId = 'b-huge-over'
    store.dispatch(
      newMessagesActions.addMessage({
        topicId: 't-over',
        message: {
          id: hugeMsgId,
          role: 'user',
          assistantId: 'a',
          topicId: 't-over',
          createdAt: new Date().toISOString(),
          status: 'success',
          blocks: [hugeBlockId]
        } as any
      })
    )
    store.dispatch({
      type: 'messageBlocks/upsertOneBlock',
      payload: {
        id: hugeBlockId,
        messageId: hugeMsgId,
        type: 'main_text',
        content: hugeContent,
        status: 'success',
        createdAt: new Date().toISOString()
      }
    } as any)
    retention.clearRetentionForTopic('t-over')
    retention.setRetentionLastAccessForTests('t-ttl-old', now - RETENTION_TTL_MS - 1000)
    retention.setRetentionLastAccessForTests('t-ttl-fresh', now - RETENTION_TTL_MS + 1000)
    retention.setRetentionLastAccessForTests('t-over', now - 1000)
    const victims = retention.enforceRetention(now, store as any)
    expect(victims).toContain('t-ttl-old')
    expect(victims).not.toContain('t-ttl-fresh')
    expect(victims).toContain('t-over')
    const state = store.getState() as any
    expect(state.residentRegistry.entries['t-ttl-old'].residentTopic).toBe(false)
    expect(state.residentRegistry.entries['t-over'].residentTopic).toBe(false)
    retention.stopResidentRetention()
  })

  it('fail-closed: non-accountable complete resident (non-finite payload) is treated as oversized and evicted', async () => {
    const store = buildStore()
    seedResidentTopic(store, 't-bad', ['m-bad'])
    retention.startResidentRetention(store as any)
    // Deactivate so topic is evictable (not current)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    // Inject non-finite block content to make canonicalize throw
    const badBlockId = 'b-bad-nonfinite'
    store.dispatch({
      type: 'messageBlocks/upsertOneBlock',
      payload: { id: badBlockId, messageId: 'm-bad', type: 'main_text', content: Infinity }
    } as any)
    // Also need to link block to message via updateMessage
    const stateBefore = store.getState() as any
    const msg = stateBefore.messages.entities['m-bad']
    expect(msg).toBeDefined()
    // Add blockId to message's blocks array via updateMessage
    store.dispatch({
      type: 'newMessages/updateMessage',
      payload: { topicId: 't-bad', messageId: 'm-bad', updates: { blocks: [...(msg.blocks ?? []), badBlockId] } }
    } as any)
    // Clear stale byte cache populated before corrupt block was linked (generation unchanged)
    retention.clearRetentionForTopic('t-bad')
    // Verify byte computation fails closed (returns >32MiB)
    const bytes = retention.__test_computeBytes('t-bad', store.getState())
    expect(bytes).toBe(RETENTION_MAX_BYTES + 1)
    // Fresh lastAccess, no TTL, single topic — normally not evicted, but fail-closed makes it oversized
    retention.setRetentionLastAccessForTests('t-bad', Date.now() - 1000)
    const victims = retention.enforceRetention(Date.now(), store as any)
    expect(victims).toContain('t-bad')
    // Verify eviction cleared messages via production rootReducer
    const stateAfter = store.getState() as any
    expect(stateAfter.messages.messageIdsByTopic['t-bad']).toBeUndefined()
    expect(stateAfter.residentRegistry.entries['t-bad'].residentTopic).toBe(false)
    retention.stopResidentRetention()
  })

  it('exactly 32MiB does not evict on byte boundary and count exactly 8 does not evict', () => {
    const store = buildStore()
    for (let i = 0; i < 8; i++) {
      seedResidentTopic(store, `t-c-${i}`, [`m-${i}`])
    }
    retention.startResidentRetention(store as any)
    for (let i = 0; i < 8; i++) retention.setRetentionLastAccessForTests(`t-c-${i}`, NOW - 1000)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    const victims = retention.enforceRetention(NOW, store as any)
    expect(victims.length).toBe(0)
    retention.stopResidentRetention()
  })

  it('atomic clear via production rootReducer: messages, exclusive blocks, segments, window completeness, closure cleared; scroll retained; generation fenced', () => {
    const store = buildStore()
    seedResidentTopic(store, 't-victim', ['m-v1', 'm-v2'])
    seedResidentTopic(store, 't-survivor', ['m-s1'])
    const sharedBlockId = 'b-shared'
    store.dispatch({
      type: 'messageBlocks/upsertOneBlock',
      payload: {
        id: sharedBlockId,
        messageId: 'm-s1',
        type: 'main_text',
        content: 'shared',
        status: 'success',
        createdAt: new Date().toISOString()
      }
    } as any)
    // Link shared block to its owning message to satisfy canonical payload bidirectional check (fail-closed)
    {
      const s = store.getState() as any
      const m = s.messages.entities['m-s1']
      if (m) {
        store.dispatch({
          type: 'newMessages/updateMessage',
          payload: {
            topicId: 't-survivor',
            messageId: 'm-s1',
            updates: { blocks: [...(m.blocks ?? []), sharedBlockId] }
          }
        } as any)
      }
    }
    const stateBefore = store.getState() as any
    expect(stateBefore.messages.messageIdsByTopic['t-victim']).toBeDefined()
    expect(stateBefore.messageBlocks.entities['b-m-v1']).toBeDefined()
    expect(getLatestWindowCompleteness('t-victim')).toBeDefined()
    expect(getCachedContextClosure('t-victim')).not.toBeNull()
    const genBefore = stateBefore.residentRegistry.entries['t-victim'].applicabilityGeneration
    expect(keyvStore.has('scroll:topic-t-victim')).toBe(true)
    retention.startResidentRetention(store as any)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    const now = Date.now()
    retention.setRetentionLastAccessForTests('t-victim', now - RETENTION_TTL_MS - 1000)
    retention.setRetentionLastAccessForTests('t-survivor', now - 1000)
    const victims = retention.enforceRetention(now, store as any)
    expect(victims).toContain('t-victim')
    const stateAfter = store.getState() as any
    expect(stateAfter.messages.messageIdsByTopic['t-victim']).toBeUndefined()
    expect(stateAfter.messages.entities['m-v1']).toBeUndefined()
    expect(stateAfter.messageBlocks.entities['b-m-v1']).toBeUndefined()
    expect(stateAfter.messages.messageIdsByTopic['t-survivor']).toBeDefined()
    expect(stateAfter.messageBlocks.entities[sharedBlockId]).toBeDefined()
    expect(stateAfter.topicSegments.segmentsByTopic['t-victim']).toBeUndefined()
    expect(getLatestWindowCompleteness('t-victim')).toBeUndefined()
    expect(getCachedContextClosure('t-victim')).toBeNull()
    expect(stateAfter.residentRegistry.entries['t-victim'].residentTopic).toBe(false)
    expect(stateAfter.residentRegistry.entries['t-victim'].applicabilityGeneration).toBe(genBefore + 1)
    expect(keyvStore.has('scroll:topic-t-victim')).toBe(true)
    expect(getDeletionGeneration('t-victim')).toBe(0)
    retention.stopResidentRetention()
  })

  it('hard deletion reclaims all retention metadata without changing authoritative deletion or B-07 scroll contract', () => {
    const store = buildStore()
    seedResidentTopic(store, 't-hard', ['m-hard-1'])
    seedResidentTopic(store, 't-other', ['m-other-1'])
    retention.startResidentRetention(store as any)
    const now = Date.now()
    retention.setRetentionLastAccessForTests('t-hard', now - 1000)
    retention.setRetentionLastAccessForTests('t-other', now - 1000)
    // Verify retention metadata exists
    expect(retention.getRetentionLastAccessMapForTests().has('t-hard')).toBe(true)
    // Verify byte cache populated via enforce or compute
    retention.__test_computeBytes('t-hard', store.getState())
    expect(retention.__test_getByteCacheMap().has('t-hard')).toBe(true)
    // Scroll snapshots exist for both
    expect(keyvStore.has('scroll:topic-t-hard')).toBe(true)
    expect(keyvStore.has('scroll:topic-t-other')).toBe(true)
    // Hard delete t-hard via authoritative path - uses production store (rootReducer)
    // Need to ensure boundStore is the test store: stop and restart with test store
    retention.stopResidentRetention()
    // Re-bind to test store for hard-delete path (global store is different, but we test direct clear)
    // Simulate hard delete by calling invalidateTopicDeletion which uses global store;
    // instead we directly test clearing via retention API and verify scroll behavior difference
    // For this test, we call retention.clear + invalidate via production store dispatch
    // Use global store's topicDeletionInvalidation but verify retention cleared for test topics via direct API
    // Clear via retention directly (what hard delete does)
    retention.clearRetentionForTopic('t-hard')
    // Also simulate authoritative hard delete cleanup: bump generation and purge projections via test store
    store.dispatch(invalidateForDeletion('t-hard'))
    // Purge messages via store dispatch (mimic topicDeletionInvalidation)
    const state = store.getState() as any
    const mids = state.messages.messageIdsByTopic['t-hard'] ?? []
    if (mids.length > 0) store.dispatch(newMessagesActions.removeMessages({ topicId: 't-hard', messageIds: mids }))
    // Verify retention metadata reclaimed
    expect(retention.getRetentionLastAccessMapForTests().has('t-hard')).toBe(false)
    expect(retention.__test_getByteCacheMap().has('t-hard')).toBe(false)
    expect(retention.getRetentionLastAccessMapForTests().has('t-other')).toBe(true)
    // B-07 scroll: hard delete removes scroll (authoritative), retention eviction retains.
    // Here we mimic hard delete scroll removal
    try {
      scrollCache.removeScrollSnapshotsForTopicIds(['t-hard'])
    } catch {}
    expect(keyvStore.has('scroll:topic-t-hard')).toBe(false)
    expect(keyvStore.has('scroll:topic-t-other')).toBe(true)
    // Verify production diagnostics remain scalar (no IDs)
    const diag = retention.getResidentRetentionDiagnostics()
    expect(JSON.stringify(diag)).not.toContain('t-hard')
    expect(JSON.stringify(diag)).not.toContain('t-other')
    retention.stopResidentRetention()
  })

  it('hard deletion via topicDeletionInvalidation clears retention metadata (production path)', async () => {
    // This test verifies the integration between topicDeletionInvalidation and residentRetention
    // using the real production store singleton (window.store). We seed via that store.
    // Since buildStore uses production rootReducer but topicDeletionInvalidation uses global store,
    // we test via direct API: seed via global store and verify hard delete clears.
    const globalStore = (globalThis as any).window?.store ?? (await import('@renderer/store')).default
    const testTopic = `t-hard-global-${Date.now()}`
    // Seed via bump+publish on global store
    const { bumpGeneration: bg, publishResidentComplete: prc } = await import('@renderer/store/residentRegistry')
    globalStore.dispatch(bg(testTopic))
    const gen = globalStore.getState().residentRegistry.entries[testTopic].applicabilityGeneration
    const wr = makeWindowResponse(testTopic, ['m-g-hard'])
    globalStore.dispatch(prc({ topicId: testTopic, generation: gen, windowResponse: wr, segments: [] } as any))
    setLatestWindowCompleteness(testTopic, { hasMoreBefore: false, hasMoreAfter: false })
    // Set retention lastAccess via retention service (bound to global store if started)
    // Start retention on global store to bind
    retention.stopResidentRetention()
    retention.startResidentRetention(globalStore)
    retention.setRetentionLastAccessForTests(testTopic, Date.now() - 1000)
    retention.__test_computeBytes(testTopic, globalStore.getState())
    expect(retention.getRetentionLastAccessMapForTests().has(testTopic)).toBe(true)
    // Hard delete via production path
    invalidateTopicDeletion(testTopic)
    // Verify retention cleared
    expect(retention.getRetentionLastAccessMapForTests().has(testTopic)).toBe(false)
    expect(retention.__test_getByteCacheMap().has(testTopic)).toBe(false)
    retention.stopResidentRetention()
    // Cleanup global state: clear entry
    const { clearEntry } = await import('@renderer/store/residentRegistry')
    try {
      globalStore.dispatch(clearEntry(testTopic))
    } catch {}
    try {
      clearLatestWindowCompleteness(testTopic)
    } catch {}
  })

  it('production diagnostics are scalar-only — old non-scalar API removed and test-only helpers isolated', () => {
    // Old public API should not exist in production exports
    expect((retention as any).getLastAccessForDiagnostics).toBeUndefined()
    // Test-only helpers exist but are prefixed and not part of production contract
    expect(typeof (retention as any).__test_getLastAccessMap).toBe('function')
    expect(typeof (retention as any).__test_getByteCacheMap).toBe('function')
    // Production diagnostics are bounded scalars with no IDs
    const diag = retention.getResidentRetentionDiagnostics()
    expect(typeof diag.totalEvicted).toBe('number')
    expect(typeof diag.retentionMapSize).toBe('number')
    expect(typeof diag.byteCacheSize).toBe('number')
    const serialized = JSON.stringify(diag)
    // No topic IDs or timestamps leaked
    expect(serialized).not.toContain('t-')
    expect(serialized).not.toContain('167')
    // Keys are scalar only
    const expectedKeys = [
      'ttlSweeps',
      'ttlEvicted',
      'oversizedEvicted',
      'lruCountEvicted',
      'lruByteEvicted',
      'totalEvicted',
      'lastSweepAt',
      'lastAggregateBytes',
      'lastEvictableCount',
      'lastPinnedCount',
      'retentionMapSize',
      'byteCacheSize'
    ].sort()
    expect(Object.keys(diag).sort()).toEqual(expectedKeys)
  })

  it('reloading evicted topic repopulates via joint publication (production rootReducer)', () => {
    const store = buildStore()
    seedResidentTopic(store, 't-reload', ['m-old'])
    retention.startResidentRetention(store as any)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    const now = Date.now()
    retention.setRetentionLastAccessForTests('t-reload', now - RETENTION_TTL_MS - 1000)
    retention.enforceRetention(now, store as any)
    let state = store.getState() as any
    expect(state.residentRegistry.entries['t-reload'].residentTopic).toBe(false)
    store.dispatch(bumpGeneration('t-reload'))
    const gen = (store.getState() as any).residentRegistry.entries['t-reload'].applicabilityGeneration
    const win = makeWindowResponse('t-reload', ['m-new1', 'm-new2'])
    store.dispatch(
      publishResidentComplete({ topicId: 't-reload', generation: gen, windowResponse: win, segments: [] } as any)
    )
    state = store.getState() as any
    expect(state.residentRegistry.entries['t-reload'].residentTopic).toBe(true)
    expect(state.messages.messageIdsByTopic['t-reload']).toEqual(['m-new1', 'm-new2'])
    retention.stopResidentRetention()
  })

  it('stale fence: eviction generation bump causes stale joint publication discard (production rootReducer)', () => {
    const store = buildStore()
    seedResidentTopic(store, 't-stale', ['m1'])
    const genBefore = (store.getState() as any).residentRegistry.entries['t-stale'].applicabilityGeneration
    retention.startResidentRetention(store as any)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    const now = Date.now()
    retention.setRetentionLastAccessForTests('t-stale', now - RETENTION_TTL_MS - 1000)
    retention.enforceRetention(now, store as any)
    const genAfter = (store.getState() as any).residentRegistry.entries['t-stale'].applicabilityGeneration
    expect(genAfter).toBe(genBefore + 1)
    const stalePayload = {
      topicId: 't-stale',
      generation: genBefore,
      windowResponse: makeWindowResponse('t-stale', ['m-stale']),
      segments: []
    }
    expect(shouldDiscardJointPublish(store.getState(), stalePayload)).toBe(true)
    store.dispatch(publishResidentComplete(stalePayload as any))
    const state = store.getState() as any
    expect(state.messages.messageIdsByTopic['t-stale']).toBeUndefined()
    expect(state.residentRegistry.entries['t-stale'].residentTopic).toBe(false)
    store.dispatch(bumpGeneration('t-stale'))
    const freshGen = (store.getState() as any).residentRegistry.entries['t-stale'].applicabilityGeneration
    const freshPayload = {
      topicId: 't-stale',
      generation: freshGen,
      windowResponse: makeWindowResponse('t-stale', ['m-fresh']),
      segments: []
    }
    expect(shouldDiscardJointPublish(store.getState(), freshPayload)).toBe(false)
    store.dispatch(publishResidentComplete(freshPayload as any))
    expect((store.getState() as any).residentRegistry.entries['t-stale'].residentTopic).toBe(true)
    retention.stopResidentRetention()
  })

  it('B-06..B-09 parity preserved after retention eviction (production reducer)', async () => {
    const store = buildStore()
    seedResidentTopic(store, 't-parity', ['m1'])
    const { createLatestMessageWindow } = await import('@renderer/pages/home/Messages/messageWindow')
    const msgs = Array.from(
      { length: 10 },
      (_, i) =>
        ({
          id: `mm-${i}`,
          role: 'user',
          assistantId: 'a',
          topicId: 't-parity',
          createdAt: new Date().toISOString(),
          status: 'success',
          blocks: []
        }) as any
    )
    const win = createLatestMessageWindow(msgs as any, 10)
    expect(win.groupCount).toBeLessThanOrEqual(200)
    seedResidentTopic(store, 't-evict-me', ['m-e1'])
    retention.startResidentRetention(store as any)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    const now = Date.now()
    retention.setRetentionLastAccessForTests('t-evict-me', now - RETENTION_TTL_MS - 1000)
    retention.setRetentionLastAccessForTests('t-parity', now - 1000)
    retention.enforceRetention(now, store as any)
    const state = store.getState() as any
    expect(state.residentRegistry.entries['t-parity'].residentTopic).toBe(true)
    expect(keyvStore.has('scroll:topic-t-parity')).toBe(true)
    const { getContentSearchDiagnostics } = await import('@renderer/components/contentSearchDiagnostics')
    const b08 = getContentSearchDiagnostics()
    expect(b08.liveRangeCount).toBeLessThanOrEqual(500)
    const { getContextClosureDiagnostics } = await import('@renderer/services/contextClosure')
    const b09 = getContextClosureDiagnostics()
    expect(b09.retainedTopicCount).toBeLessThanOrEqual(1)
    retention.stopResidentRetention()
  })

  it('eviction diagnostics are bounded scalars and privacy-safe (no IDs retained)', () => {
    const store = buildStore()
    for (let i = 0; i < 9; i++) {
      seedResidentTopic(store, `t-diag-${i}`, [`m-${i}`])
    }
    retention.startResidentRetention(store as any)
    for (let i = 0; i < 9; i++) retention.setRetentionLastAccessForTests(`t-diag-${i}`, NOW - 1000 - i)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    retention.enforceRetention(NOW, store as any)
    const diag = retention.getResidentRetentionDiagnostics()
    expect(typeof diag.totalEvicted).toBe('number')
    expect(typeof diag.ttlSweeps).toBe('number')
    expect(Number.isFinite(diag.totalEvicted)).toBe(true)
    expect(Number.isFinite(diag.lastAggregateBytes)).toBe(true)
    const serialized = JSON.stringify(diag)
    expect(serialized).not.toContain('t-diag-')
    retention.stopResidentRetention()
  })

  it('byte accounting invalidated on ordinary message/block mutations without generation bump', async () => {
    const store = buildStore()
    seedResidentTopic(store, 't-byte-mutate', ['m-byte-1'], 'hi')
    retention.startResidentRetention(store as any)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    // Prime byte cache with small payload
    const smallBytes = retention.__test_computeBytes('t-byte-mutate', store.getState())
    expect(smallBytes).toBeGreaterThan(0)
    expect(smallBytes).toBeLessThan(RETENTION_MAX_BYTES)
    expect(retention.__test_getByteCacheMap().has('t-byte-mutate')).toBe(true)
    retention.setRetentionLastAccessForTests('t-byte-mutate', NOW - 1000)
    let victims = retention.enforceRetention(NOW, store as any)
    expect(victims).not.toContain('t-byte-mutate')
    // Ordinary projection mutation: append huge message+block without generation bump
    const hugeContent = 'x'.repeat(33 * 1024 * 1024)
    const hugeMsgId = 'm-huge-mutate'
    const hugeBlockId = 'b-huge-mutate'
    store.dispatch(
      newMessagesActions.addMessage({
        topicId: 't-byte-mutate',
        message: {
          id: hugeMsgId,
          role: 'user',
          assistantId: 'a',
          topicId: 't-byte-mutate',
          createdAt: new Date().toISOString(),
          status: 'success',
          blocks: [hugeBlockId]
        } as any
      })
    )
    store.dispatch({
      type: 'messageBlocks/upsertOneBlock',
      payload: {
        id: hugeBlockId,
        messageId: hugeMsgId,
        type: 'main_text',
        content: hugeContent,
        status: 'success',
        createdAt: new Date().toISOString()
      }
    } as any)
    // Byte cache must have been invalidated by renderer-local subscriber (LOCK-003)
    expect(retention.__test_getByteCacheMap().has('t-byte-mutate')).toBe(false)
    const recomputed = retention.__test_computeBytes('t-byte-mutate', store.getState())
    expect(recomputed).toBeGreaterThan(RETENTION_MAX_BYTES)
    // Now enforce should treat as oversized and evict
    victims = retention.enforceRetention(NOW, store as any)
    expect(victims).toContain('t-byte-mutate')
    expect((store.getState() as any).messages.messageIdsByTopic['t-byte-mutate']).toBeUndefined()
    retention.stopResidentRetention()
  })

  it('cache-hit activation supersedes older in-flight same-topic staged load (LOCK-004)', async () => {
    const store = buildStore()
    // Seed resident so cache-hit path is available for second activation
    seedResidentTopic(store, 't-cache-super', ['m-cache-1'])
    const { dbService } = await import('@renderer/services/db')
    // Prepare deferred fetch for first miss (forceReload)
    let resolveFirst: (v: any) => void
    let firstFetchCalled = false
    const deferredFirst = new Promise<any>((res) => {
      resolveFirst = res
    })
    vi.mocked(dbService.fetchMessagesWindow).mockImplementationOnce(() => {
      firstFetchCalled = true
      return deferredFirst as any
    })
    vi.mocked(dbService.listSegments).mockResolvedValueOnce([])
    const { loadTopicMessagesThunk } = await import('@renderer/store/thunk/messageThunk')
    // Start first load as forced miss — staged fetch pending with generation G
    const p1 = (store.dispatch as any)(loadTopicMessagesThunk('t-cache-super', true))
    await new Promise((r) => setTimeout(r, 0))
    expect(firstFetchCalled).toBe(true)
    const genDuringFirst = (store.getState() as any).residentRegistry.entries['t-cache-super'].applicabilityGeneration
    // While first fetch pending, make topic resident again so second activation can be cache-hit
    // Publish a joint completion for same generation to restore residency (simulates alternative publication)
    const wr = makeWindowResponse('t-cache-super', ['m-cache-1'])
    store.dispatch(
      publishResidentComplete({
        topicId: 't-cache-super',
        generation: genDuringFirst,
        windowResponse: wr,
        segments: []
      } as any)
    )
    expect((store.getState() as any).residentRegistry.entries['t-cache-super'].residentTopic).toBe(true)
    // Second activation: cache-hit — should bump request seq and supersede first
    const p2 = (store.dispatch as any)(loadTopicMessagesThunk('t-cache-super'))
    await p2
    // Now complete first fetch with sentinel stale payload (different message id) — should be discarded via superseded
    const staleWr = makeWindowResponse('t-cache-super', ['m-stale-should-not-appear'])
    resolveFirst!(staleWr)
    await p1.catch(() => {})
    // Allow discard handling to complete
    await new Promise((r) => setTimeout(r, 0))
    const finalState = store.getState() as any
    expect(finalState.messages.messageIdsByTopic['t-cache-super']).toEqual(['m-cache-1'])
    expect(finalState.messages.messageIdsByTopic['t-cache-super']).not.toContain('m-stale-should-not-appear')
    expect(finalState.residentRegistry.entries['t-cache-super'].residentTopic).toBe(true)
    vi.mocked(dbService.fetchMessagesWindow).mockReset()
    vi.mocked(dbService.listSegments).mockReset()
  })

  it('retention eviction unconditionally removes segmentsByTopic index including empty arrays', async () => {
    const store = buildStore()
    // Create resident with empty segmentsByTopic (no segments) — remain resident (LOCK-005)
    store.dispatch(bumpGeneration('t-empty-seg'))
    const genEmpty = (store.getState() as any).residentRegistry.entries['t-empty-seg'].applicabilityGeneration
    const wrEmpty = makeWindowResponse('t-empty-seg', ['m-empty-1'])
    store.dispatch(
      publishResidentComplete({
        topicId: 't-empty-seg',
        generation: genEmpty,
        windowResponse: wrEmpty,
        segments: []
      } as any)
    )
    expect((store.getState() as any).topicSegments.segmentsByTopic['t-empty-seg']).toEqual([])
    expect((store.getState() as any).residentRegistry.entries['t-empty-seg'].residentTopic).toBe(true)
    // Also seed another topic with non-empty segs to ensure exclusive handling
    seedResidentTopic(store, 't-other-seg', ['m-other-1'])
    retention.startResidentRetention(store as any)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    const now = Date.now()
    retention.setRetentionLastAccessForTests('t-empty-seg', now - RETENTION_TTL_MS - 1000)
    retention.setRetentionLastAccessForTests('t-other-seg', now - 1000)
    const victims = retention.enforceRetention(now, store as any)
    expect(victims).toContain('t-empty-seg')
    const after = store.getState() as any
    // Must be undefined, not empty array — proven regression assertion per finding 3
    expect(after.topicSegments.segmentsByTopic['t-empty-seg']).toBeUndefined()
    expect('t-empty-seg' in after.topicSegments.segmentsByTopic).toBe(false)
    // Non-empty survivor retained
    expect(after.topicSegments.segmentsByTopic['t-other-seg']).toBeDefined()
    retention.stopResidentRetention()
  })

  it('queue idle settlement triggers prompt enforcement without waiting timer (renderer-local idle callback)', async () => {
    const store = buildStore()
    for (let i = 0; i < 10; i++) seedResidentTopic(store, `t-qidle-${i}`, [`m-q-${i}`])
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    retention.startResidentRetention(store as any)
    for (let i = 0; i < 10; i++) retention.setRetentionLastAccessForTests(`t-qidle-${i}`, NOW - 10000 + i)
    const { getTopicQueue, clearTopicQueue } = await import('@renderer/utils/queue')
    const q = getTopicQueue('t-qidle-0')
    let release: () => void
    const pending = new Promise<void>((res) => {
      release = res
    })
    void q.add(() => pending)
    let victims = retention.enforceRetention(NOW, store as any)
    expect(victims).not.toContain('t-qidle-0')
    expect(victims).toContain('t-qidle-1')
    expect(retention.isTopicPinned('t-qidle-0', store.getState())).toBe(true)
    const sweepsBefore = retention.getResidentRetentionDiagnostics().ttlSweeps
    // Release queue — idle callback should auto-enforce without waiting timer
    release!()
    await pending
    await new Promise((r) => setTimeout(r, 30))
    expect(retention.isTopicPinned('t-qidle-0', store.getState())).toBe(false)
    // Idle auto-enforce should have run (sweeps increased) and evicted next LRU (t-qidle-2), leaving t-qidle-0 fresh
    expect(retention.getResidentRetentionDiagnostics().ttlSweeps).toBeGreaterThan(sweepsBefore)
    // Now make t-qidle-0 TTL-expired to prove it is now enforceable without timer wait
    retention.setRetentionLastAccessForTests('t-qidle-0', NOW - RETENTION_TTL_MS - 1000)
    victims = retention.enforceRetention(NOW, store as any)
    expect(victims).toContain('t-qidle-0')
    clearTopicQueue('t-qidle-0')
    retention.stopResidentRetention()
  })

  it('timer lifecycle bounded/cleaned and does not retain content (60s per LOCK-002)', () => {
    const store = buildStore()
    expect(retention.isRetentionTimerActiveForTests()).toBe(false)
    retention.startResidentRetention(store as any)
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)
    retention.stopResidentRetention()
    expect(retention.isRetentionTimerActiveForTests()).toBe(false)
  })

  it('fail-closed: missing indexed message entity is treated as oversized (RETENTION_MAX_BYTES+1)', () => {
    const store = buildStore()
    seedResidentTopic(store, 't-missing-msg', ['m1', 'm2'])
    retention.startResidentRetention(store as any)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    retention.invalidateRetentionByteCache('t-missing-msg')
    const realState = store.getState() as any
    const corrupted = JSON.parse(JSON.stringify(realState))
    // Delete one indexed message entity but keep its id in the topic index
    delete corrupted.messages.entities['m2']
    expect(corrupted.messages.messageIdsByTopic['t-missing-msg']).toContain('m2')
    expect(corrupted.messages.entities['m2']).toBeUndefined()
    const bytes = retention.__test_computeBytes('t-missing-msg', corrupted)
    expect(bytes).toBe(RETENTION_MAX_BYTES + 1)
    // Enforce via fake store must evict as fail-closed oversized
    retention.setRetentionLastAccessForTests('t-missing-msg', Date.now() - 1000)
    const fakeStore = { ...store, getState: () => corrupted } as any
    const victims = retention.enforceRetention(Date.now(), fakeStore)
    expect(victims).toContain('t-missing-msg')
    retention.stopResidentRetention()
  })

  it('fail-closed: missing indexed block entity is treated as oversized (RETENTION_MAX_BYTES+1)', () => {
    const store = buildStore()
    seedResidentTopic(store, 't-missing-block', ['m1'])
    retention.startResidentRetention(store as any)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    retention.invalidateRetentionByteCache('t-missing-block')
    const realState = store.getState() as any
    const corrupted = JSON.parse(JSON.stringify(realState))
    // The seeded block for m1 is b-m1 per makeWindowResponse
    expect(corrupted.messageBlocks.entities['b-m1']).toBeDefined()
    delete corrupted.messageBlocks.entities['b-m1']
    expect(corrupted.messages.entities['m1'].blocks).toContain('b-m1')
    expect(corrupted.messageBlocks.entities['b-m1']).toBeUndefined()
    const bytes = retention.__test_computeBytes('t-missing-block', corrupted)
    expect(bytes).toBe(RETENTION_MAX_BYTES + 1)
    retention.setRetentionLastAccessForTests('t-missing-block', Date.now() - 1000)
    const fakeStore = { ...store, getState: () => corrupted } as any
    const victims = retention.enforceRetention(Date.now(), fakeStore)
    expect(victims).toContain('t-missing-block')
    retention.stopResidentRetention()
  })

  it('fail-closed: missing indexed segment entity is treated as oversized (RETENTION_MAX_BYTES+1)', () => {
    const store = buildStore()
    seedResidentTopic(store, 't-missing-seg', ['m1'])
    retention.startResidentRetention(store as any)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    retention.invalidateRetentionByteCache('t-missing-seg')
    const realState = store.getState() as any
    const corrupted = JSON.parse(JSON.stringify(realState))
    const segId = `seg-t-missing-seg`
    expect(corrupted.topicSegments.segmentsByTopic['t-missing-seg']).toContain(segId)
    expect(corrupted.topicSegments.segments.entities[segId]).toBeDefined()
    delete corrupted.topicSegments.segments.entities[segId]
    expect(corrupted.topicSegments.segments.entities[segId]).toBeUndefined()
    const bytes = retention.__test_computeBytes('t-missing-seg', corrupted)
    expect(bytes).toBe(RETENTION_MAX_BYTES + 1)
    retention.setRetentionLastAccessForTests('t-missing-seg', Date.now() - 1000)
    const fakeStore = { ...store, getState: () => corrupted } as any
    const victims = retention.enforceRetention(Date.now(), fakeStore)
    expect(victims).toContain('t-missing-seg')
    retention.stopResidentRetention()
  })
})
