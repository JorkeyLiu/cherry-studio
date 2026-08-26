import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  enforceScrollSnapshotBounds,
  handleScrollSnapshotCleared,
  handleScrollSnapshotRead,
  handleScrollSnapshotSaved,
  initScrollSnapshotCache,
  rebuildScrollSnapshotIndex,
  removeScrollSnapshotsForTopicIds,
  SCROLL_SNAPSHOT_INDEX_KEY,
  SCROLL_SNAPSHOT_MAX_COUNT,
  SCROLL_SNAPSHOT_TTL_MS
} from '../scrollSnapshotCache'

// In-memory keyv store for test isolation
let store: Map<string, unknown>

function createKeyvMock() {
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value)
    },
    remove: (key: string) => {
      store.delete(key)
    },
    keys: () => Array.from(store.keys())
  }
}

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('window', {
    ...window,
    keyv: createKeyvMock()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('scrollSnapshotCache B-07 bounded cache', () => {
  it('exposes calibration defaults (256 and 90-day TTL) without performance claim', () => {
    expect(SCROLL_SNAPSHOT_MAX_COUNT).toBe(256)
    expect(SCROLL_SNAPSHOT_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000)
  })

  it('saves snapshot and creates/updates index entry', () => {
    const now = Date.now()
    store.set('scroll:topic-a', { scrollTop: -100, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved('scroll:topic-a', now)

    const index = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as Array<{ key: string; lastAccess: number }>
    expect(index).toBeDefined()
    expect(index.find((e) => e.key === 'scroll:topic-a')?.lastAccess).toBe(now)
  })

  it('read updates lastAccess and enforces bounds (recency)', () => {
    const base = Date.now()
    // Save with old time
    store.set('scroll:topic-a', { scrollTop: -100, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved('scroll:topic-a', base - 10000)
    const beforeIdx = (store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e) => e.key === 'scroll:topic-a')
    expect(beforeIdx.lastAccess).toBe(base - 10000)

    handleScrollSnapshotRead('scroll:topic-a', base)
    const afterIdx = (store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find((e) => e.key === 'scroll:topic-a')
    expect(afterIdx.lastAccess).toBe(base)
  })

  it('clear removes snapshot and index entry without cross-namespace deletion', () => {
    const now = Date.now()
    store.set('scroll:topic-a', { scrollTop: -10, anchorId: null, isAtBottom: false })
    store.set('scroll:topic-b', { scrollTop: -20, anchorId: null, isAtBottom: false })
    store.set('memory.wait.settings', true)
    handleScrollSnapshotSaved('scroll:topic-a', now)
    handleScrollSnapshotSaved('scroll:topic-b', now)
    // Ensure both indexed
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).length).toBe(2)

    // Clear a
    store.delete('scroll:topic-a') // simulate window.keyv.remove already done by caller
    handleScrollSnapshotCleared('scroll:topic-a')

    expect(store.get('scroll:topic-a')).toBeUndefined()
    expect(store.get('scroll:topic-b')).toBeDefined()
    expect(store.get('memory.wait.settings')).toBe(true)
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.find((e) => e.key === 'scroll:topic-a')).toBeUndefined()
    expect(idx.find((e) => e.key === 'scroll:topic-b')).toBeDefined()
  })

  it('257th LRU eviction removes oldest (deterministic)', () => {
    const now = Date.now()
    // Create 256 snapshots with increasing lastAccess (oldest = topic-000)
    for (let i = 0; i < 256; i++) {
      const key = `scroll:topic-${String(i).padStart(3, '0')}`
      store.set(key, { scrollTop: -i, anchorId: null, isAtBottom: false })
      // Use increasing timestamp so topic-000 is oldest
      handleScrollSnapshotSaved(key, now - (256 - i) * 1000)
    }
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).length).toBe(256)
    // Ensure oldest is 000
    const idxBefore = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    const oldest = idxBefore.reduce((min, e) => (e.lastAccess < min.lastAccess ? e : min), idxBefore[0])
    expect(oldest.key).toBe('scroll:topic-000')

    // Add 257th newest
    const newKey = 'scroll:topic-999'
    store.set(newKey, { scrollTop: -999, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved(newKey, now)

    // Should still be 256, oldest evicted, newest kept
    const idxAfter = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idxAfter.length).toBe(256)
    expect(store.get('scroll:topic-000')).toBeUndefined()
    expect(idxAfter.find((e) => e.key === 'scroll:topic-000')).toBeUndefined()
    expect(store.get(newKey)).toBeDefined()
    expect(idxAfter.find((e) => e.key === newKey)).toBeDefined()
    // Ensure another old key still present (001)
    expect(store.get('scroll:topic-001')).toBeDefined()
  })

  it('TTL expiry removes entries older than 90 days (TTL first)', () => {
    const now = Date.now()
    const expiredKey = 'scroll:topic-expired'
    const freshKey = 'scroll:topic-fresh'
    store.set(expiredKey, { scrollTop: -100, anchorId: null, isAtBottom: false })
    store.set(freshKey, { scrollTop: -200, anchorId: null, isAtBottom: false })
    // Manually craft index with expired lastAccess
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [
      { key: expiredKey, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 1000 },
      { key: freshKey, lastAccess: now }
    ])

    enforceScrollSnapshotBounds(now)

    expect(store.get(expiredKey)).toBeUndefined()
    expect(store.get(freshKey)).toBeDefined()
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.find((e) => e.key === expiredKey)).toBeUndefined()
    expect(idx.find((e) => e.key === freshKey)).toBeDefined()
    expect(idx.length).toBe(1)
  })

  it('TTL first then LRU: expired removed before capacity check', () => {
    const now = Date.now()
    // Create 256 fresh entries
    for (let i = 0; i < 256; i++) {
      const key = `scroll:topic-${String(i).padStart(3, '0')}`
      store.set(key, { scrollTop: -i, anchorId: null, isAtBottom: false })
    }
    // Index: 256 fresh with now, plus 1 expired that would make 257 but TTL should purge expired first
    const freshEntries = Array.from({ length: 256 }, (_, i) => ({
      key: `scroll:topic-${String(i).padStart(3, '0')}`,
      lastAccess: now
    }))
    const expiredKey = 'scroll:topic-expired'
    store.set(expiredKey, { scrollTop: -999, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [
      ...freshEntries,
      { key: expiredKey, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 5000 }
    ])

    enforceScrollSnapshotBounds(now)

    // Expired removed, fresh 256 remain (no LRU eviction needed)
    expect(store.get(expiredKey)).toBeUndefined()
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).length).toBe(256)
    for (let i = 0; i < 256; i++) {
      const key = `scroll:topic-${String(i).padStart(3, '0')}`
      expect(store.get(key)).toBeDefined()
    }
  })

  it('deterministic tie-break: same lastAccess evicts lexicographically smallest topicId', () => {
    const now = Date.now()
    // Create 257 entries all with same timestamp
    const keys: string[] = []
    for (let i = 0; i < 257; i++) {
      const key = `scroll:topic-${String(i).padStart(3, '0')}`
      keys.push(key)
      store.set(key, { scrollTop: -i, anchorId: null, isAtBottom: false })
    }
    // Sort keys lexicographically; smallest is topic-000
    const sorted = [...keys].sort((a, b) => a.localeCompare(b))
    const smallest = sorted[0]
    expect(smallest).toBe('scroll:topic-000')

    // Build index with same timestamp
    store.set(
      SCROLL_SNAPSHOT_INDEX_KEY,
      keys.map((k) => ({ key: k, lastAccess: now }))
    )

    enforceScrollSnapshotBounds(now)

    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.length).toBe(256)
    expect(store.get(smallest)).toBeUndefined()
    expect(idx.find((e) => e.key === smallest)).toBeUndefined()
    // The second smallest should remain
    const second = sorted[1]
    expect(store.get(second)).toBeDefined()
    expect(idx.find((e) => e.key === second)).toBeDefined()
    // Largest remains
    const largest = sorted[sorted.length - 1]
    expect(store.get(largest)).toBeDefined()
  })

  it('missing index rebuilds from keys deterministically', () => {
    const now = Date.now()
    store.set('scroll:topic-a', { scrollTop: -10, anchorId: null, isAtBottom: false })
    store.set('scroll:topic-b', { scrollTop: -20, anchorId: null, isAtBottom: false })
    store.set('scroll:topic-c', { scrollTop: -30, anchorId: null, isAtBottom: false })
    // No index present
    expect(store.get(SCROLL_SNAPSHOT_INDEX_KEY)).toBeUndefined()

    const rebuilt = rebuildScrollSnapshotIndex(now)
    expect(rebuilt.length).toBe(3)
    expect(rebuilt.map((e) => e.key).sort()).toEqual(['scroll:topic-a', 'scroll:topic-b', 'scroll:topic-c'].sort())
    // After rebuild, enforce should keep all (under capacity)
    enforceScrollSnapshotBounds(now)
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).length).toBe(3)
  })

  it('does not delete cross-namespace keys', () => {
    const now = Date.now()
    store.set('scroll:topic-a', { scrollTop: -10, anchorId: null, isAtBottom: false })
    store.set('memory.wait.settings', true)
    store.set('other:key', { foo: 1 })
    store.set('scroll:__index__', [{ key: 'scroll:topic-a', lastAccess: now }]) // index itself
    // Enforce should not delete non-scroll keys
    enforceScrollSnapshotBounds(now)
    expect(store.get('memory.wait.settings')).toBe(true)
    expect(store.get('other:key')).toBeDefined()
    // Index still present
    expect(store.get(SCROLL_SNAPSHOT_INDEX_KEY)).toBeDefined()
  })

  it('hard-delete cleanup removes only targeted snapshots', () => {
    const now = Date.now()
    store.set('scroll:topic-a', { scrollTop: -10, anchorId: null, isAtBottom: false })
    store.set('scroll:topic-b', { scrollTop: -20, anchorId: null, isAtBottom: false })
    store.set('scroll:topic-c', { scrollTop: -30, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved('scroll:topic-a', now)
    handleScrollSnapshotSaved('scroll:topic-b', now)
    handleScrollSnapshotSaved('scroll:topic-c', now)
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).length).toBe(3)

    removeScrollSnapshotsForTopicIds(['a', 'c'])

    expect(store.get('scroll:topic-a')).toBeUndefined()
    expect(store.get('scroll:topic-c')).toBeUndefined()
    expect(store.get('scroll:topic-b')).toBeDefined()
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.find((e) => e.key === 'scroll:topic-a')).toBeUndefined()
    expect(idx.find((e) => e.key === 'scroll:topic-c')).toBeUndefined()
    expect(idx.find((e) => e.key === 'scroll:topic-b')).toBeDefined()
    expect(idx.length).toBe(1)
  })

  it('hard-delete is idempotent and retains soft-delete snapshot', () => {
    const now = Date.now()
    store.set('scroll:topic-soft', { scrollTop: -10, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved('scroll:topic-soft', now)
    // Soft-delete would NOT call removeScrollSnapshotsForTopicIds, so snapshot remains
    expect(store.get('scroll:topic-soft')).toBeDefined()
    // Hard delete twice should not throw and second is no-op
    removeScrollSnapshotsForTopicIds(['soft'])
    expect(store.get('scroll:topic-soft')).toBeUndefined()
    removeScrollSnapshotsForTopicIds(['soft'])
    expect(store.get('scroll:topic-soft')).toBeUndefined()
  })

  it('index stays consistent through save/read/clear lifecycle', () => {
    const base = Date.now()
    const keyA = 'scroll:topic-lifecycle'
    // Save
    store.set(keyA, { scrollTop: -100, anchorId: 'msg-1', isAtBottom: false })
    handleScrollSnapshotSaved(keyA, base)
    let idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.length).toBe(1)
    expect(idx[0].key).toBe(keyA)

    // Read updates timestamp
    handleScrollSnapshotRead(keyA, base + 5000)
    idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx[0].lastAccess).toBe(base + 5000)
    expect(store.get(keyA)).toBeDefined()

    // Clear
    store.delete(keyA)
    handleScrollSnapshotCleared(keyA)
    idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.length).toBe(0)
    expect(store.get(keyA)).toBeUndefined()
  })

  it('legacy numeric snapshot is preserved and indexed on read', () => {
    const now = Date.now()
    store.set('scroll:topic-legacy', -250 as unknown as any)
    // Simulate getSavedPosition path: read would detect number and update index
    handleScrollSnapshotRead('scroll:topic-legacy', now)
    // Snapshot still numeric
    expect(store.get('scroll:topic-legacy')).toBe(-250)
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.find((e) => e.key === 'scroll:topic-legacy')).toBeDefined()
  })

  it('startup init enforces TTL and LRU without timers', () => {
    const now = Date.now()
    // Prepare expired + over-capacity
    for (let i = 0; i < 257; i++) {
      const key = `scroll:topic-${String(i).padStart(3, '0')}`
      store.set(key, { scrollTop: -i, anchorId: null, isAtBottom: false })
    }
    // One of them expired
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [
      ...Array.from({ length: 256 }, (_, i) => ({
        key: `scroll:topic-${String(i).padStart(3, '0')}`,
        lastAccess: now
      })),
      { key: 'scroll:topic-256', lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 1000 }
    ])
    // Also set actual keys include expired
    store.set('scroll:topic-256', { scrollTop: -256, anchorId: null, isAtBottom: false })

    initScrollSnapshotCache(now)

    // Expired 256 removed, remaining 256 (0-255)
    expect(store.get('scroll:topic-256')).toBeUndefined()
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.length).toBe(256)
    expect(idx.find((e) => e.key === 'scroll:topic-256')).toBeUndefined()
  })

  it('handles missing keys() gracefully (legacy test double)', () => {
    // Stub without keys
    store = new Map()
    store.set('scroll:topic-a', { scrollTop: -10, anchorId: null, isAtBottom: false })
    vi.stubGlobal('window', {
      ...window,
      keyv: {
        get: (k: string) => store.get(k),
        set: (k: string, v: unknown) => store.set(k, v),
        remove: (k: string) => store.delete(k)
        // no keys()
      }
    })
    // Should not throw
    expect(() => handleScrollSnapshotSaved('scroll:topic-a', Date.now())).not.toThrow()
    expect(() => enforceScrollSnapshotBounds(Date.now())).not.toThrow()
  })
})
