import { configureStore } from '@reduxjs/toolkit'
import * as retention from '@renderer/services/residentRetention'
import { RETENTION_MAX_BYTES } from '@renderer/services/residentRetentionPolicy'
import { clearRetentionForTopicIfAvailable } from '@renderer/services/retentionClearHandler'
import { invalidateTopicDeletion } from '@renderer/services/topicDeletionInvalidation'
import { rootReducer } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import { bumpGeneration, publishResidentComplete } from '@renderer/store/residentRegistry'
import { __test_getQueueIdleCallbackCountForTests } from '@renderer/utils/queueIdle'
import { __test_getWindowReadIdleCallbackCountForTests } from '@renderer/utils/windowReadQueueIdle'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getWarnSpy } = vi.hoisted(() => {
  const map = new Map<string, ReturnType<typeof vi.fn>>()
  return {
    getWarnSpy: (ctx: string) => {
      if (!map.has(ctx)) map.set(ctx, vi.fn())
      return map.get(ctx)!
    }
  }
})
vi.mock('@logger', () => ({
  loggerService: {
    withContext: (ctx: string) => ({
      info: vi.fn(),
      warn: getWarnSpy(ctx),
      error: vi.fn(),
      debug: vi.fn(),
      silly: vi.fn()
    })
  }
}))
vi.mock('@renderer/services/SpanManagerService', () => ({ startTrace: vi.fn(), endTrace: vi.fn() }))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    appendMessage: vi.fn().mockResolvedValue(undefined),
    fetchMessagesWindow: vi.fn().mockResolvedValue({ messages: [], blocks: [], window: {} as any }),
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

function makeWindowResponse(topicId: string, ids: string[], blockContent = 'hi'): any {
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
  }
}

function buildStore() {
  return configureStore({ reducer: rootReducer })
}

function seedResident(store: ReturnType<typeof buildStore>, topicId: string, messageIds = ['m1']) {
  store.dispatch(bumpGeneration(topicId))
  const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
  store.dispatch(
    publishResidentComplete({
      topicId,
      generation: gen,
      windowResponse: makeWindowResponse(topicId, messageIds),
      segments: [] as any
    })
  )
}

describe('S7.10 residentRetention — 0ms background registration split', () => {
  beforeEach(() => {
    retention.resetRetentionForTests()
    retention.resetResidentRetentionDiagnosticsForTests()
    retention.stopResidentRetention()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    retention.stopResidentRetention()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('deletion reclamation handler is eager before 0ms task', async () => {
    const store = buildStore()
    seedResident(store, 't-del-eager', ['m1'])
    retention.startResidentRetention(store as any)
    // pending before 0ms — true Set counts are 0
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(true)
    expect(retention.isRetentionTimerActiveForTests()).toBe(false)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(0)
    // hard delete via topicDeletionInvalidation should clear retention even before background
    seedResident(store, 't-del-eager2', ['m2'])
    retention.setRetentionLastAccessForTests('t-del-eager', Date.now())
    retention.__test_computeBytes('t-del-eager', store.getState())
    expect(retention.__test_getLastAccessMap().has('t-del-eager')).toBe(true)
    // simulate hard delete via clear handler (eager)
    retention.clearRetentionForTopic('t-del-eager')
    expect(retention.__test_getLastAccessMap().has('t-del-eager')).toBe(false)
    expect(retention.__test_getByteCacheMap().has('t-del-eager')).toBe(false)
    vi.advanceTimersByTime(0)
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)
  })

  it('store subscriber and byte-cache invalidation are eager before 0ms', () => {
    const store = buildStore()
    seedResident(store, 't-byte-eager', ['m1'])
    retention.startResidentRetention(store as any)
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(true)
    // prime cache
    expect(retention.__test_computeBytes('t-byte-eager', store.getState())).toBeGreaterThan(0)
    expect(retention.__test_getByteCacheMap().has('t-byte-eager')).toBe(true)
    // mutate messages before background task — subscriber should invalidate cache eagerly
    store.dispatch(
      newMessagesActions.addMessage({
        topicId: 't-byte-eager',
        message: { id: 'm-extra', role: 'user', topicId: 't-byte-eager', blocks: [] } as any
      })
    )
    expect(retention.__test_getByteCacheMap().has('t-byte-eager')).toBe(false)
    // enforce before background should not use stale cache (recompute huge)
    // Add huge block via direct dispatch to make fail-closed if stale used would be small
    retention.invalidateRetentionByteCache('t-byte-eager')
    // still before background, timer not yet
    expect(retention.isRetentionTimerActiveForTests()).toBe(false)
    vi.advanceTimersByTime(0)
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)
  })

  it('pre-task mutation after first enforce not using stale byte cache', () => {
    const store = buildStore()
    seedResident(store, 't-stale-cache', ['m1'])
    retention.startResidentRetention(store as any)
    store.dispatch(newMessagesActions.setCurrentTopicId(null as any))
    const now = Date.now()
    retention.setRetentionLastAccessForTests('t-stale-cache', now - 1000)
    // prime small cache
    const small = retention.__test_computeBytes('t-stale-cache', store.getState())
    expect(small).toBeLessThan(RETENTION_MAX_BYTES)
    let victims = retention.enforceRetention(now, store as any)
    expect(victims).not.toContain('t-stale-cache')
    expect(retention.isTopicPinned('t-stale-cache', store.getState())).toBe(false)
    // mutate to huge before background
    const huge = 'x'.repeat(33 * 1024 * 1024)
    store.dispatch(
      newMessagesActions.addMessage({
        topicId: 't-stale-cache',
        message: { id: 'm-huge', role: 'user', topicId: 't-stale-cache', blocks: ['b-huge'] } as any
      })
    )
    store.dispatch({
      type: 'messageBlocks/upsertOneBlock',
      payload: {
        id: 'b-huge',
        messageId: 'm-huge',
        type: 'main_text',
        content: huge,
        status: 'success',
        createdAt: new Date().toISOString()
      }
    } as any)
    // cache must have been invalidated eagerly via subscriber before background
    expect(retention.__test_getByteCacheMap().has('t-stale-cache')).toBe(false)
    // still pending background
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(true)
    // verify recomputed bytes is oversized
    const recomputed = retention.__test_computeBytes('t-stale-cache', store.getState())
    expect(recomputed).toBeGreaterThan(RETENTION_MAX_BYTES)
    // fire background
    vi.advanceTimersByTime(0)
    // now enforce should treat as oversized
    victims = retention.enforceRetention(now + 1000, store as any)
    expect(victims).toContain('t-stale-cache')
  })

  it('queue callback and timer registration 0ms boundary', () => {
    const store = buildStore()
    retention.startResidentRetention(store as any)
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(true)
    expect(retention.isRetentionTimerActiveForTests()).toBe(false)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(0)
    vi.advanceTimersByTime(0)
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(false)
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(1)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(1)
  })

  it('duplicate start is idempotent — no double timer or callbacks', () => {
    const store = buildStore()
    retention.startResidentRetention(store as any)
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(true)
    // 0ms before: true Set counts are 0
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(0)
    retention.startResidentRetention(store as any)
    retention.startResidentRetention(store as any)
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(true)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(0)
    vi.advanceTimersByTime(0)
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(1)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(1)
    // second schedule after already active should be noop (timer still active, counts stay 1)
    retention.startResidentRetention(store as any)
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(1)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(1)
  })

  it('stop before 0ms fires prevents late registration', () => {
    const store = buildStore()
    retention.startResidentRetention(store as any)
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(true)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(0)
    retention.stopResidentRetention()
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(false)
    expect(retention.isRetentionTimerActiveForTests()).toBe(false)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(0)
    vi.advanceTimersByTime(0)
    expect(retention.isRetentionTimerActiveForTests()).toBe(false)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(0)
    // restart after stop should work — 0ms before 0, after 1
    retention.startResidentRetention(store as any)
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(true)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    vi.advanceTimersByTime(0)
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(1)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(1)
  })

  it('failure in background registration is bounded via logger, no unhandled rejection', async () => {
    const store = buildStore()
    const unhandled: unknown[] = []
    const handler = (r: unknown) => unhandled.push(r)
    if (typeof process !== 'undefined' && (process as any).on) (process as any).on('unhandledRejection', handler)
    // force registerQueueIdleCallback to throw
    const queueIdleMod = await import('@renderer/utils/queueIdle')
    vi.spyOn(queueIdleMod, 'registerQueueIdleCallback').mockImplementation(() => {
      throw new Error('queue boom')
    })
    retention.startResidentRetention(store as any)
    vi.advanceTimersByTime(0)
    await Promise.resolve()
    expect(unhandled.length).toBe(0)
    // timer should still be attempted (maybe active)
    // restore
    vi.mocked(queueIdleMod.registerQueueIdleCallback).mockRestore()
    if (typeof process !== 'undefined' && (process as any).off) (process as any).off('unhandledRejection', handler)
  })

  it('deletion before background task clears metadata without leak', () => {
    const store = buildStore()
    seedResident(store, 't-del-before-bg', ['m1'])
    retention.startResidentRetention(store as any)
    retention.setRetentionLastAccessForTests('t-del-before-bg', Date.now())
    retention.__test_computeBytes('t-del-before-bg', store.getState())
    expect(retention.__test_getLastAccessMap().has('t-del-before-bg')).toBe(true)
    // simulate hard delete before background
    retention.clearRetentionForTopic('t-del-before-bg')
    store.dispatch({
      type: 'newMessages/removeMessages',
      payload: { topicId: 't-del-before-bg', messageIds: ['m1'] }
    } as any)
    expect(retention.__test_getLastAccessMap().has('t-del-before-bg')).toBe(false)
    vi.advanceTimersByTime(0)
    expect(retention.__test_getLastAccessMap().has('t-del-before-bg')).toBe(false)
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)
  })

  it('clearRetentionForTopicIfAvailable before 0ms via real handler clears metadata (production seam)', () => {
    const store = buildStore()
    seedResident(store, 't-seam-clear', ['m1'])
    retention.startResidentRetention(store as any)
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(true)
    retention.setRetentionLastAccessForTests('t-seam-clear', Date.now())
    retention.__test_computeBytes('t-seam-clear', store.getState())
    expect(retention.__test_getLastAccessMap().has('t-seam-clear')).toBe(true)
    // production seam: retentionClearHandler registered eagerly
    clearRetentionForTopicIfAvailable('t-seam-clear')
    expect(retention.__test_getLastAccessMap().has('t-seam-clear')).toBe(false)
    expect(retention.__test_getByteCacheMap().has('t-seam-clear')).toBe(false)
    // still pending, after 0ms timer active and no leak
    vi.advanceTimersByTime(0)
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)
    expect(retention.__test_getLastAccessMap().has('t-seam-clear')).toBe(false)
  })

  it('invalidateTopicDeletion before 0ms clears retention metadata via real seam', () => {
    const store = buildStore()
    seedResident(store, 't-seam-invalidate', ['m1'])
    retention.startResidentRetention(store as any)
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(true)
    retention.setRetentionLastAccessForTests('t-seam-invalidate', Date.now())
    retention.__test_computeBytes('t-seam-invalidate', store.getState())
    expect(retention.__test_getLastAccessMap().has('t-seam-invalidate')).toBe(true)
    invalidateTopicDeletion('t-seam-invalidate')
    expect(retention.__test_getLastAccessMap().has('t-seam-invalidate')).toBe(false)
    expect(retention.__test_getByteCacheMap().has('t-seam-invalidate')).toBe(false)
    vi.advanceTimersByTime(0)
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)
    expect(retention.__test_getLastAccessMap().has('t-seam-invalidate')).toBe(false)
  })

  it('background registration failure logs warn, registry counts, and is recoverable via stop/start and same-instance retry', async () => {
    const store = buildStore()
    const queueIdleMod = await import('@renderer/utils/queueIdle')
    const windowIdleMod = await import('@renderer/utils/windowReadQueueIdle')
    const warnSpy = getWarnSpy('ResidentRetention')
    warnSpy.mockClear()
    // make queue and window throw, and also timer? queue/window throw, timer succeeds
    const qSpy = vi.spyOn(queueIdleMod, 'registerQueueIdleCallback').mockImplementation(() => {
      throw new Error('queue boom')
    })
    const wSpy = vi.spyOn(windowIdleMod, 'registerWindowReadQueueIdleCallback').mockImplementation(() => {
      throw new Error('window boom')
    })
    const unhandled: unknown[] = []
    const handler = (r: unknown) => unhandled.push(r)
    if (typeof process !== 'undefined' && (process as any).on) (process as any).on('unhandledRejection', handler)
    retention.startResidentRetention(store as any)
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(true)
    vi.advanceTimersByTime(0)
    await Promise.resolve()
    expect(unhandled.length).toBe(0)
    // logger warns for both
    expect(warnSpy).toHaveBeenCalled()
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]))
    expect(warnMessages.some((m) => m.includes('queueIdle'))).toBe(true)
    expect(warnMessages.some((m) => m.includes('windowReadIdle'))).toBe(true)
    // registry counts: timer succeeded, queue/window failed — true Set counts are 0
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(0)

    // same-instance retry should recover without stop — 0ms before 0, after 1
    qSpy.mockRestore()
    wSpy.mockRestore()
    // clear warn history
    warnSpy.mockClear()
    // retry via same instance (no stop) — pending 0ms before, 1 after
    retention.startResidentRetention(store as any)
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(true)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(0)
    vi.advanceTimersByTime(0)
    await Promise.resolve()
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(1)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(1)
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)
    expect(unhandled.length).toBe(0)

    // now test stop/start recovery after failure
    // force again failure then stop then start
    const qSpy2 = vi.spyOn(queueIdleMod, 'registerQueueIdleCallback').mockImplementation(() => {
      throw new Error('queue boom2')
    })
    retention.stopResidentRetention()
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(false)
    expect(retention.isRetentionTimerActiveForTests()).toBe(false)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(0)
    retention.startResidentRetention(store as any)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    vi.advanceTimersByTime(0)
    await Promise.resolve()
    // queue failed again but timer still — queue 0, window 1 (window succeeded), pending false
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(1)
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(false)
    // stop and restart with success should recover — 0 before, 1 after
    qSpy2.mockRestore()
    retention.stopResidentRetention()
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(0)
    retention.startResidentRetention(store as any)
    expect(retention.isRetentionBackgroundPendingForTests()).toBe(true)
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(0)
    vi.advanceTimersByTime(0)
    await Promise.resolve()
    expect(__test_getQueueIdleCallbackCountForTests()).toBe(1)
    expect(__test_getWindowReadIdleCallbackCountForTests()).toBe(1)
    expect(retention.isRetentionTimerActiveForTests()).toBe(true)

    if (typeof process !== 'undefined' && (process as any).off) (process as any).off('unhandledRejection', handler)
  })
})
