import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import useScrollPosition from '../../hooks/useScrollPosition'
import {
  cancelScheduledScrollSnapshotStartupSweep,
  enforceScrollSnapshotBounds,
  handleScrollSnapshotCleared,
  handleScrollSnapshotRead,
  handleScrollSnapshotSaved,
  isScrollSnapshotStartupSweepPendingForTests,
  removeScrollSnapshotsForTopicIds,
  resetScrollSnapshotCacheForTests,
  scheduleScrollSnapshotStartupSweep,
  SCROLL_SNAPSHOT_INDEX_KEY,
  SCROLL_SNAPSHOT_MAX_COUNT,
  SCROLL_SNAPSHOT_TTL_MS
} from '../scrollSnapshotCache'

let store: Map<string, unknown>

function createKeyvMock() {
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    remove: (key: string) => {
      const had = store.has(key)
      store.delete(key)
      return had
    },
    keys: () => Array.from(store.keys())
  }
}

describe('S7.10 scrollSnapshotCache — 0ms sweep + check-before-refresh', () => {
  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('window', {
      ...window,
      keyv: createKeyvMock()
    })
    resetScrollSnapshotCacheForTests()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    cancelScheduledScrollSnapshotStartupSweep()
    vi.restoreAllMocks()
  })

  it('91d expired item first read before global sweep deletes and does not resurrect', () => {
    const now = Date.now()
    const key = 'scroll:topic-91d-read'
    store.set(key, { scrollTop: -100, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [{ key, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 1000 }])
    // schedule sweep but do not fire
    scheduleScrollSnapshotStartupSweep()
    expect(isScrollSnapshotStartupSweepPendingForTests()).toBe(true)
    // read before sweep — must check-before-refresh and delete
    handleScrollSnapshotRead(key, now)
    expect(store.get(key)).toBeUndefined()
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.find((e) => e.key === key)).toBeUndefined()
    // advance 0ms — sweep fires but item already gone
    vi.advanceTimersByTime(0)
    expect(isScrollSnapshotStartupSweepPendingForTests()).toBe(false)
    expect(store.get(key)).toBeUndefined()
  })

  it('91d expired index save replaces stale entry with fresh lastAccess without deleting fresh snapshot', () => {
    const base = Date.now()
    const key = 'scroll:topic-91d-save'
    // simulate snapshot just saved (caller set before handle)
    store.set(key, { scrollTop: -200, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [{ key, lastAccess: base - SCROLL_SNAPSHOT_TTL_MS - 5000 }])
    handleScrollSnapshotSaved(key, base)
    // snapshot should still exist (fresh save not deleted)
    expect(store.get(key)).toBeDefined()
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    const entry = idx.find((e) => e.key === key)
    expect(entry).toBeDefined()
    expect(entry.lastAccess).toBe(base)
  })

  it('read after 91d expiry and before sweep does not keep lastAccess and not enforces stale resurrection', () => {
    const now = Date.now()
    const fresh = 'scroll:topic-fresh'
    const expired = 'scroll:topic-expired-91d'
    store.set(fresh, { scrollTop: -10, anchorId: null, isAtBottom: false })
    store.set(expired, { scrollTop: -20, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [
      { key: fresh, lastAccess: now },
      { key: expired, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 100 }
    ])
    scheduleScrollSnapshotStartupSweep()
    expect(isScrollSnapshotStartupSweepPendingForTests()).toBe(true)
    // read expired before sweep — deletes expired, keeps fresh
    handleScrollSnapshotRead(expired, now)
    expect(store.get(expired)).toBeUndefined()
    expect(store.get(fresh)).toBeDefined()
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e) => e.key === expired)).toBeUndefined()
    // fire sweep — fresh still retained
    vi.advanceTimersByTime(0)
    expect(store.get(fresh)).toBeDefined()
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).length).toBe(1)
  })

  it('global sweep 0ms before fires leaves expired present, after fires purges', () => {
    const now = Date.now()
    const expired = 'scroll:topic-sweep-pending'
    store.set(expired, { scrollTop: -30, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [{ key: expired, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 2000 }])
    scheduleScrollSnapshotStartupSweep()
    // before timer, expired still present in storage (sweep deferred)
    expect(store.get(expired)).toBeDefined()
    expect(isScrollSnapshotStartupSweepPendingForTests()).toBe(true)
    // do not call read/save — global sweep alone should purge
    vi.advanceTimersByTime(0)
    expect(isScrollSnapshotStartupSweepPendingForTests()).toBe(false)
    expect(store.get(expired)).toBeUndefined()
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e) => e.key === expired)).toBeUndefined()
  })

  it('save with old index that is expired purges old lastAccess and enforces fresh (max256/LRU preserved)', () => {
    const now = Date.now()
    const key = 'scroll:topic-save-old-index'
    store.set(key, { scrollTop: -40, anchorId: null, isAtBottom: false })
    // index has expired entry for same key plus other fresh entries filling near capacity
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [{ key, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 10000 }])
    handleScrollSnapshotSaved(key, now)
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.length).toBe(1)
    expect(idx[0].lastAccess).toBe(now)
    expect(store.get(key)).toBeDefined()
  })

  it('duplicate schedule is idempotent — one timer only', () => {
    scheduleScrollSnapshotStartupSweep()
    expect(isScrollSnapshotStartupSweepPendingForTests()).toBe(true)
    scheduleScrollSnapshotStartupSweep()
    scheduleScrollSnapshotStartupSweep()
    expect(isScrollSnapshotStartupSweepPendingForTests()).toBe(true)
    vi.advanceTimersByTime(0)
    expect(isScrollSnapshotStartupSweepPendingForTests()).toBe(false)
    // second schedule after fire should allow new pending
    scheduleScrollSnapshotStartupSweep()
    expect(isScrollSnapshotStartupSweepPendingForTests()).toBe(true)
    cancelScheduledScrollSnapshotStartupSweep()
    expect(isScrollSnapshotStartupSweepPendingForTests()).toBe(false)
  })

  it('cancel before fire prevents late sweep', () => {
    const now = Date.now()
    const key = 'scroll:topic-cancel-test'
    store.set(key, { scrollTop: -50, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [{ key, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 1000 }])
    scheduleScrollSnapshotStartupSweep()
    expect(isScrollSnapshotStartupSweepPendingForTests()).toBe(true)
    cancelScheduledScrollSnapshotStartupSweep()
    expect(isScrollSnapshotStartupSweepPendingForTests()).toBe(false)
    vi.advanceTimersByTime(0)
    // sweep was cancelled, so expired still present until next lifecycle enforcement
    expect(store.get(key)).toBeDefined()
    // lifecycle read should still purge correctly before refresh
    handleScrollSnapshotRead(key, now)
    expect(store.get(key)).toBeUndefined()
  })

  it('clear and hard-delete correctness remain immediate before 0ms sweep', () => {
    const now = Date.now()
    const key = 'scroll:topic-immediate-clear'
    store.set(key, { scrollTop: -60, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved(key, now)
    expect(store.get(key)).toBeDefined()
    scheduleScrollSnapshotStartupSweep()
    // clear immediately before sweep
    store.delete(key)
    handleScrollSnapshotCleared(key)
    expect(store.get(key)).toBeUndefined()
    // hard delete another
    const key2 = 'scroll:topic-hard'
    store.set(key2, { scrollTop: -70, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved(key2, now)
    removeScrollSnapshotsForTopicIds(['hard'])
    expect(store.get(key2)).toBeUndefined()
    vi.advanceTimersByTime(0)
    expect(store.get(key2)).toBeUndefined()
  })

  it('failure in startup sweep is bounded via logger and no unhandled rejection', async () => {
    // Force keyv.remove to throw inside enforce to trigger logger path
    store.set('scroll:topic-fail', { scrollTop: -80, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [
      { key: 'scroll:topic-fail', lastAccess: Date.now() - SCROLL_SNAPSHOT_TTL_MS - 1000 }
    ])
    // stub keyv.remove to throw
    const origRemove = (window as any).keyv.remove
    ;(window as any).keyv.remove = () => {
      throw new Error('remove boom')
    }
    const unhandled: unknown[] = []
    const handler = (r: unknown) => unhandled.push(r)
    if (typeof process !== 'undefined' && (process as any).on) (process as any).on('unhandledRejection', handler)
    scheduleScrollSnapshotStartupSweep()
    vi.advanceTimersByTime(0)
    await Promise.resolve()
    expect(unhandled.length).toBe(0)
    ;(window as any).keyv.remove = origRemove
    if (typeof process !== 'undefined' && (process as any).off) (process as any).off('unhandledRejection', handler)
  })

  it('TTL deletion failure (remove false) retains expired index and not fresh, next sweep still suppressed until recovery', () => {
    const now = Date.now()
    const key = 'scroll:topic-ttl-fail-false'
    store.set(key, { scrollTop: -1, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [{ key, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 1000 }])
    const trueRemove = (window as any).keyv.remove
    ;(window as any).keyv.remove = () => false
    enforceScrollSnapshotBounds(now)
    // physical still present, index retained as expired (not refreshed to now)
    expect(store.get(key)).toBeDefined()
    const idx1 = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    const entry1 = idx1.find((e) => e.key === key)
    expect(entry1).toBeDefined()
    expect(entry1.lastAccess).toBe(now - SCROLL_SNAPSHOT_TTL_MS - 1000)
    // second sweep with same failure still suppressed (not resurrected)
    enforceScrollSnapshotBounds(now + 1000)
    const idx2 = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    const entry2 = idx2.find((e) => e.key === key)
    expect(entry2).toBeDefined()
    expect(entry2.lastAccess).toBe(now - SCROLL_SNAPSHOT_TTL_MS - 1000)
    // recovery: restore success
    ;(window as any).keyv.remove = trueRemove
    enforceScrollSnapshotBounds(now + 2000)
    expect(store.get(key)).toBeUndefined()
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e) => e.key === key)).toBeUndefined()
  })

  it('TTL deletion failure (throw) retains and not fresh, recovery succeeds', () => {
    const now = Date.now()
    const key = 'scroll:topic-ttl-fail-throw'
    store.set(key, { scrollTop: -1, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [{ key, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 1000 }])
    const trueRemove = (window as any).keyv.remove
    ;(window as any).keyv.remove = () => {
      throw new Error('remove throw')
    }
    enforceScrollSnapshotBounds(now)
    expect(store.get(key)).toBeDefined()
    const entry = (store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e) => e.key === key)
    expect(entry).toBeDefined()
    expect(entry.lastAccess).toBe(now - SCROLL_SNAPSHOT_TTL_MS - 1000)
    // recovery
    ;(window as any).keyv.remove = trueRemove
    enforceScrollSnapshotBounds(now + 1000)
    expect(store.get(key)).toBeUndefined()
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e) => e.key === key)).toBeUndefined()
  })

  it('LRU deletion failure retains entry and not fresh, recovery evicts', () => {
    const now = Date.now()
    // fill to max +1 to trigger LRU
    for (let i = 0; i < SCROLL_SNAPSHOT_MAX_COUNT + 1; i++) {
      const k = `scroll:topic-lru-fail-${String(i).padStart(3, '0')}`
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
    }
    const keys = Array.from(
      { length: SCROLL_SNAPSHOT_MAX_COUNT + 1 },
      (_, i) => `scroll:topic-lru-fail-${String(i).padStart(3, '0')}`
    )
    store.set(
      SCROLL_SNAPSHOT_INDEX_KEY,
      keys.map((k, idx) => ({ key: k, lastAccess: now - (SCROLL_SNAPSHOT_MAX_COUNT - idx) * 1000 }))
    )
    // oldest is lru-fail-000
    const oldest = 'scroll:topic-lru-fail-000'
    expect(store.get(oldest)).toBeDefined()
    const trueRemove = (window as any).keyv.remove
    ;(window as any).keyv.remove = (k: string) => {
      if (k === oldest) return false
      return trueRemove(k)
    }
    enforceScrollSnapshotBounds(now)
    // oldest still present due to failure, index retains it
    expect(store.get(oldest)).toBeDefined()
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e) => e.key === oldest)).toBeDefined()
    // working still over capacity, but failed entry stays; next sweep still not fresh
    enforceScrollSnapshotBounds(now + 1000)
    expect(store.get(oldest)).toBeDefined()
    // recovery
    ;(window as any).keyv.remove = trueRemove
    enforceScrollSnapshotBounds(now + 2000)
    expect(store.get(oldest)).toBeUndefined()
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).length).toBe(SCROLL_SNAPSHOT_MAX_COUNT)
  })

  it('LRU deletion failure via throw retains and not fresh, recovery succeeds', () => {
    const now = Date.now()
    for (let i = 0; i < SCROLL_SNAPSHOT_MAX_COUNT + 1; i++) {
      const k = `scroll:topic-lru-throw-${String(i).padStart(3, '0')}`
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
    }
    const keys = Array.from(
      { length: SCROLL_SNAPSHOT_MAX_COUNT + 1 },
      (_, i) => `scroll:topic-lru-throw-${String(i).padStart(3, '0')}`
    )
    store.set(
      SCROLL_SNAPSHOT_INDEX_KEY,
      keys.map((k, idx) => ({ key: k, lastAccess: now - (SCROLL_SNAPSHOT_MAX_COUNT - idx) * 1000 }))
    )
    const oldest = 'scroll:topic-lru-throw-000'
    const trueRemove = (window as any).keyv.remove
    ;(window as any).keyv.remove = (k: string) => {
      if (k === oldest) throw new Error('lru throw')
      return trueRemove(k)
    }
    enforceScrollSnapshotBounds(now)
    expect(store.get(oldest)).toBeDefined()
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e) => e.key === oldest)).toBeDefined()
    ;(window as any).keyv.remove = trueRemove
    enforceScrollSnapshotBounds(now + 1000)
    expect(store.get(oldest)).toBeUndefined()
  })

  it('read path expired with remove false retains index, returns false, next read still suppressed', () => {
    const now = Date.now()
    const key = 'scroll:topic-read-fail-false'
    store.set(key, { scrollTop: -1, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [{ key, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 1000 }])
    const trueRemove = (window as any).keyv.remove
    ;(window as any).keyv.remove = () => false
    const available1 = handleScrollSnapshotRead(key, now)
    expect(available1).toBe(false)
    expect(store.get(key)).toBeDefined()
    const entry1 = (store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e) => e.key === key)
    expect(entry1).toBeDefined()
    expect(entry1.lastAccess).toBe(now - SCROLL_SNAPSHOT_TTL_MS - 1000)
    // second read still suppressed, not refreshed
    const available2 = handleScrollSnapshotRead(key, now + 500)
    expect(available2).toBe(false)
    const entry2 = (store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e) => e.key === key)
    expect(entry2.lastAccess).toBe(now - SCROLL_SNAPSHOT_TTL_MS - 1000)
    // recovery via enforce
    ;(window as any).keyv.remove = trueRemove
    const available3 = handleScrollSnapshotRead(key, now + 1000)
    expect(available3).toBe(false)
    // after successful delete, storage cleared
    expect(store.get(key)).toBeUndefined()
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e) => e.key === key)).toBeUndefined()
  })

  it('read path expired with throw retains and returns false', () => {
    const now = Date.now()
    const key = 'scroll:topic-read-fail-throw'
    store.set(key, { scrollTop: -1, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [{ key, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 1000 }])
    const trueRemove = (window as any).keyv.remove
    ;(window as any).keyv.remove = () => {
      throw new Error('read throw')
    }
    const available = handleScrollSnapshotRead(key, now)
    expect(available).toBe(false)
    expect(store.get(key)).toBeDefined()
    ;(window as any).keyv.remove = trueRemove
    const available2 = handleScrollSnapshotRead(key, now + 100)
    expect(available2).toBe(false)
    expect(store.get(key)).toBeUndefined()
  })

  it('handleScrollSnapshotRead returns true for fresh and updates recency (backward-compatible)', () => {
    const now = Date.now()
    const key = 'scroll:topic-read-fresh-bool'
    store.set(key, { scrollTop: -1, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [{ key, lastAccess: now - 1000 }])
    const ret = handleScrollSnapshotRead(key, now)
    expect(ret).toBe(true)
    const entry = (store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e) => e.key === key)
    expect(entry.lastAccess).toBe(now)
  })

  it('getSavedPosition first read returns null for 91d expired (hook integration)', () => {
    const now = Date.now()
    const topicKey = 'topic-hook-expired-91d'
    const scrollKey = `scroll:${topicKey}`
    store.set(scrollKey, { scrollTop: -100, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [{ key: scrollKey, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 1000 }])
    // hook reads via getSavedPosition
    const { result } = renderHook(() => useScrollPosition(topicKey))
    let pos: unknown
    act(() => {
      pos = result.current.getSavedPosition()
    })
    expect(pos).toBeNull()
    expect(store.get(scrollKey)).toBeUndefined()
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[])?.find((e) => e.key === scrollKey)).toBeUndefined()
  })
})
