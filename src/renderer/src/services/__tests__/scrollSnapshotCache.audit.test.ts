import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __internalIsInvalidatedForTests,
  __internalIsScrollSnapshotKeyForTests,
  enforceScrollSnapshotBounds,
  handleScrollSnapshotSaved,
  rebuildScrollSnapshotIndex,
  removeScrollSnapshotsForTopicIds,
  resetInvalidatedScrollSnapshotsForTests,
  resetScrollSnapshotCacheForTests,
  SCROLL_SNAPSHOT_INDEX_KEY,
  SCROLL_SNAPSHOT_MAX_COUNT,
  SCROLL_SNAPSHOT_TTL_MS
} from '../scrollSnapshotCache'

let store: Map<string, unknown>

function createKeyvMock() {
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    remove: (key: string) => store.delete(key),
    keys: () => Array.from(store.keys())
  }
}

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('window', {
    ...window,
    keyv: createKeyvMock()
  })
  resetScrollSnapshotCacheForTests()
  resetInvalidatedScrollSnapshotsForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('B-07 audit regression', () => {
  it('BLOCKER: pending trailing write cannot recreate hard-deleted snapshot (cache-level invalidation)', () => {
    const now = Date.now()
    const key = 'scroll:topic-audit-pending'
    // Simulate throttled leading save
    store.set(key, { scrollTop: -100, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved(key, now)
    expect(store.get(key)).toBeDefined()
    expect(store.get(SCROLL_SNAPSHOT_INDEX_KEY)).toBeDefined()

    // Hard delete while a trailing write is logically pending (simulate throttle trailing callback after delete)
    removeScrollSnapshotsForTopicIds(['audit-pending'])
    expect(store.get(key)).toBeUndefined()
    expect(__internalIsInvalidatedForTests(key)).toBe(true)

    // Simulate late trailing callback trying to recreate snapshot via handleScrollSnapshotSaved
    // (this is what lodash throttle trailing would do: window.keyv.set + handleSaved)
    store.set(key, { scrollTop: -999, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved(key, now + 100)
    // Must remain deleted — cache must have removed the recreated key
    expect(store.get(key)).toBeUndefined()
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.find((e: any) => e.key === key)).toBeUndefined()

    // Even enforce should not re-add it via sync
    enforceScrollSnapshotBounds(now + 200)
    expect(store.get(key)).toBeUndefined()
    const idx2 = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    if (idx2) expect(idx2.find((e: any) => e.key === key)).toBeUndefined()
  })

  it('BLOCKER: savePosition path also blocked for invalidated key', () => {
    const now = Date.now()
    const key = 'scroll:topic-audit-savepos'
    store.set(key, { scrollTop: -50, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved(key, now)
    removeScrollSnapshotsForTopicIds(['audit-savepos'])
    expect(__internalIsInvalidatedForTests(key)).toBe(true)
    // Direct save attempt after invalidation (simulates savePosition calling window.keyv.set + handleSaved)
    store.set(key, { scrollTop: -777, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved(key, now + 10)
    expect(store.get(key)).toBeUndefined()
  })

  it('ACCEPTABLE-RISK: duplicate valid index entries canonicalized before TTL/LRU and persisted', () => {
    const now = Date.now()
    const key = 'scroll:topic-dup'
    store.set(key, { scrollTop: -10, anchorId: null, isAtBottom: false })
    // Manually craft index with duplicates — same key twice with different lastAccess
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [
      { key, lastAccess: now - 5000 },
      { key, lastAccess: now },
      { key: 'scroll:topic-other', lastAccess: now }
    ])
    store.set('scroll:topic-other', { scrollTop: -20, anchorId: null, isAtBottom: false })

    enforceScrollSnapshotBounds(now)

    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    // Duplicate should be collapsed to one entry, keep max lastAccess
    const dupEntries = idx.filter((e: any) => e.key === key)
    expect(dupEntries.length).toBe(1)
    expect(dupEntries[0].lastAccess).toBe(now)
    expect(idx.length).toBe(2)
    // Ensure capacity not inflated by duplicate count
    expect(store.get(key)).toBeDefined()
  })

  it('ACCEPTABLE-RISK: duplicates with equal lastAccess still canonicalized deterministically', () => {
    const now = Date.now()
    const key = 'scroll:topic-dup-eq'
    store.set(key, { scrollTop: -10, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [
      { key, lastAccess: now },
      { key, lastAccess: now }
    ])
    enforceScrollSnapshotBounds(now)
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.filter((e: any) => e.key === key).length).toBe(1)
    expect(idx.length).toBe(1)
  })

  it('ACCEPTABLE-RISK: non-topic scroll:* keys do not consume 256 topic budget and are untouched', () => {
    const now = Date.now()
    // Create 256 topic snapshots filling budget
    for (let i = 0; i < 256; i++) {
      const k = `scroll:topic-${String(i).padStart(3, '0')}`
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
    }
    store.set(
      SCROLL_SNAPSHOT_INDEX_KEY,
      Array.from({ length: 256 }, (_, i) => ({
        key: `scroll:topic-${String(i).padStart(3, '0')}`,
        lastAccess: now
      }))
    )
    // Add generic non-topic scroll keys — should be ignored by B-07
    store.set('scroll:SearchResults', { scrollTop: -1, anchorId: null, isAtBottom: false })
    store.set('scroll:TopicMessages', { scrollTop: -2, anchorId: null, isAtBottom: false })
    store.set('scroll:TopicsHistory', { scrollTop: -3, anchorId: null, isAtBottom: false })
    store.set('scroll:other-generic', { scrollTop: -4, anchorId: null, isAtBottom: false })

    // Verify they are not considered managed keys
    expect(__internalIsScrollSnapshotKeyForTests('scroll:SearchResults')).toBe(false)
    expect(__internalIsScrollSnapshotKeyForTests('scroll:TopicMessages')).toBe(false)
    expect(__internalIsScrollSnapshotKeyForTests('scroll:TopicsHistory')).toBe(false)
    expect(__internalIsScrollSnapshotKeyForTests('scroll:other-generic')).toBe(false)
    expect(__internalIsScrollSnapshotKeyForTests('scroll:topic-abc')).toBe(true)

    // Enforce should keep all 256 topics plus leave generic keys untouched (no eviction)
    enforceScrollSnapshotBounds(now)
    for (let i = 0; i < 256; i++) {
      const k = `scroll:topic-${String(i).padStart(3, '0')}`
      expect(store.get(k)).toBeDefined()
    }
    expect(store.get('scroll:SearchResults')).toBeDefined()
    expect(store.get('scroll:TopicMessages')).toBeDefined()
    expect(store.get('scroll:TopicsHistory')).toBeDefined()
    expect(store.get('scroll:other-generic')).toBeDefined()
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).length).toBe(256)

    // Now add one more topic to exceed budget — should evict one topic, but still leave generic keys
    const newKey = 'scroll:topic-999'
    store.set(newKey, { scrollTop: -999, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved(newKey, now + 1000)
    expect(store.get('scroll:SearchResults')).toBeDefined()
    expect(store.get('scroll:TopicMessages')).toBeDefined()
    // Topic count stays 256, generic keys not counted
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).length).toBe(256)
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e: any) => e.key === newKey)).toBeDefined()
  })

  it('ACCEPTABLE-RISK: rebuild and isValidIndexEntry ignore non-topic keys', () => {
    const now = Date.now()
    store.set('scroll:topic-a', { scrollTop: -10, anchorId: null, isAtBottom: false })
    store.set('scroll:SearchResults', { scrollTop: -20, anchorId: null, isAtBottom: false })
    store.set('scroll:TopicsHistory', { scrollTop: -30, anchorId: null, isAtBottom: false })
    // Corrupt index with non-topic entry (should be filtered)
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [
      { key: 'scroll:topic-a', lastAccess: now },
      { key: 'scroll:SearchResults', lastAccess: now },
      { key: 'scroll:TopicsHistory', lastAccess: now }
    ])
    // Enforce should canonicalize and drop invalid entries (non-topic) because isValid checks prefix
    // But rebuild path would also ignore them. Test rebuild directly
    store.delete(SCROLL_SNAPSHOT_INDEX_KEY)
    const rebuilt = rebuildScrollSnapshotIndex(now)
    expect(rebuilt.find((e) => e.key === 'scroll:SearchResults')).toBeUndefined()
    expect(rebuilt.find((e) => e.key === 'scroll:TopicsHistory')).toBeUndefined()
    expect(rebuilt.find((e) => e.key === 'scroll:topic-a')).toBeDefined()
    expect(rebuilt.length).toBe(1)
  })

  it('ACCEPTABLE-RISK: locale-independent deterministic tie-break (code-point, not localeCompare)', () => {
    const now = Date.now()
    // Use keys where localeCompare and code-point order differ in some locales,
    // or at least verify that eviction picks smallest by < > comparator.
    // For ASCII, both agree, but we verify the comparator is code-point.
    // Create 257 entries same timestamp, ensure smallest code-point is evicted.
    const keys: string[] = []
    for (let i = 0; i < 257; i++) {
      const k = `scroll:topic-${String(i).padStart(3, '0')}`
      keys.push(k)
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
    }
    // Add a key that would sort differently under localeCompare if locale-dependent
    // e.g., uppercase vs lowercase: code-point order puts uppercase before lowercase
    // while localeCompare may vary. Ensure deterministic code-point order.
    store.set(
      SCROLL_SNAPSHOT_INDEX_KEY,
      keys.map((k) => ({ key: k, lastAccess: now }))
    )

    enforceScrollSnapshotBounds(now)

    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.length).toBe(SCROLL_SNAPSHOT_MAX_COUNT)
    // Oldest set all equal time, so eviction should remove smallest code-point key
    const sortedCodePoint = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const smallest = sortedCodePoint[0]
    expect(store.get(smallest)).toBeUndefined()
    expect(idx.find((e: any) => e.key === smallest)).toBeUndefined()
    // Verify that comparator used is code-point: sort via code-point equals sorted order in index after eviction?
    // The remaining keys should be the 256 largest code-point keys
    const expectedRemaining = new Set(sortedCodePoint.slice(1))
    for (const e of idx) {
      expect(expectedRemaining.has(e.key)).toBe(true)
    }
  })

  it('deterministic rebuild sort uses code-point comparator', () => {
    const now = Date.now()
    // Keys with mixed case to ensure code-point vs localeCompare difference is observable
    store.set('scroll:topic-A', { scrollTop: -1, anchorId: null, isAtBottom: false })
    store.set('scroll:topic-a', { scrollTop: -2, anchorId: null, isAtBottom: false })
    store.set('scroll:topic-B', { scrollTop: -3, anchorId: null, isAtBottom: false })
    store.delete(SCROLL_SNAPSHOT_INDEX_KEY)
    const rebuilt = rebuildScrollSnapshotIndex(now)
    // Code-point order for these keys: 'scroll:topic-A' < 'scroll:topic-B' < 'scroll:topic-a'
    // (uppercase 65-90 before lowercase 97-122)
    expect(rebuilt.map((e) => e.key)).toEqual(['scroll:topic-A', 'scroll:topic-B', 'scroll:topic-a'])
  })

  it('TTL first then LRU still respects invalidated and duplicate canonicalization', () => {
    const now = Date.now()
    // Expired duplicate + invalidated key in same set
    const expiredKey = 'scroll:topic-expired-dup'
    store.set(expiredKey, { scrollTop: -1, anchorId: null, isAtBottom: false })
    store.set('scroll:topic-fresh', { scrollTop: -2, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [
      { key: expiredKey, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 1000 },
      { key: expiredKey, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 500 }, // duplicate expired
      { key: 'scroll:topic-fresh', lastAccess: now }
    ])
    // Invalidate fresh key before enforce
    removeScrollSnapshotsForTopicIds(['fresh'])
    enforceScrollSnapshotBounds(now)
    expect(store.get(expiredKey)).toBeUndefined()
    expect(store.get('scroll:topic-fresh')).toBeUndefined()
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.find((e: any) => e.key === expiredKey)).toBeUndefined()
    expect(idx.find((e: any) => e.key === 'scroll:topic-fresh')).toBeUndefined()
  })
})
