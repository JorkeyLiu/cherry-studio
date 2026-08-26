import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import useScrollPosition from '../../hooks/useScrollPosition'
import {
  enforceScrollSnapshotBounds,
  handleScrollSnapshotSaved,
  SCROLL_SNAPSHOT_INDEX_KEY
} from '../scrollSnapshotCache'
import { resetInvalidatedScrollSnapshotsForTests, resetScrollSnapshotCacheForTests } from '../scrollSnapshotCache'
import {
  getDeletionGeneration,
  invalidateTopicsDeletion,
  resetAllDeletionGenerationsForTests
} from '../topicDeletionInvalidation'

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
  resetAllDeletionGenerationsForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('B-07 re-audit: malformed index repair durability', () => {
  it('filters malformed/non-topic array entries and durably persists canonical metadata via enforcement', () => {
    const now = Date.now()
    const validA = 'scroll:topic-valid-a'
    const validB = 'scroll:topic-valid-b'
    store.set(validA, { scrollTop: -10, anchorId: null, isAtBottom: false })
    store.set(validB, { scrollTop: -20, anchorId: null, isAtBottom: false })
    // Include malformed and non-topic entries in persisted index array
    const malformedIndex: unknown[] = [
      { key: validA, lastAccess: now },
      { key: validB, lastAccess: now },
      // non-topic keys must be filtered (B-07 budget only for topic snapshots)
      { key: 'scroll:SearchResults', lastAccess: now },
      { key: 'scroll:other-generic', lastAccess: now },
      // malformed: missing key
      { lastAccess: now } as unknown,
      // malformed: empty key
      { key: '', lastAccess: now },
      // malformed: non-string key
      { key: 123 as unknown as string, lastAccess: now },
      // malformed: missing lastAccess
      { key: validA } as unknown,
      // malformed: NaN lastAccess
      { key: validA, lastAccess: NaN },
      // malformed: Infinity
      { key: validB, lastAccess: Infinity },
      // malformed: non-topic prefix but string
      { key: 'memory:key', lastAccess: now },
      // duplicate valid entry (canonicalization also)
      { key: validA, lastAccess: now - 1000 }
    ]
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, malformedIndex)

    // Before enforcement, raw persisted length includes malformed
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as unknown[]).length).toBe(malformedIndex.length)

    enforceScrollSnapshotBounds(now)

    const persisted = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as Array<{ key: string; lastAccess: number }>
    // Durably cleaned: only valid topic keys remain, no non-topic/malformed
    expect(persisted).toBeDefined()
    expect(persisted.find((e) => e.key === 'scroll:SearchResults')).toBeUndefined()
    expect(persisted.find((e) => e.key === 'scroll:other-generic')).toBeUndefined()
    expect(persisted.find((e) => e.key === 'memory:key')).toBeUndefined()
    expect(persisted.find((e) => e.key === '')).toBeUndefined()
    // Valid keys remain, deduplicated to max lastAccess
    expect(persisted.filter((e) => e.key === validA).length).toBe(1)
    expect(persisted.find((e) => e.key === validA)?.lastAccess).toBe(now)
    expect(persisted.find((e) => e.key === validB)).toBeDefined()
    expect(persisted.length).toBe(2)

    // Second enforcement is idempotent — no regression, still canonical
    enforceScrollSnapshotBounds(now + 100)
    const second = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as Array<{ key: string; lastAccess: number }>
    expect(second.length).toBe(2)
    expect(second.find((e) => e.key === validA)).toBeDefined()
  })

  it('persists malformed filtering even when no TTL/LRU/sync change (pure repair)', () => {
    const now = Date.now()
    const valid = 'scroll:topic-pure'
    store.set(valid, { scrollTop: -1, anchorId: null, isAtBottom: false })
    // Index contains only one valid plus two malformed; no other triggers
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [
      { key: valid, lastAccess: now },
      { key: 'scroll:SearchResults', lastAccess: now },
      { key: valid, lastAccess: NaN } as unknown
    ])
    enforceScrollSnapshotBounds(now)
    const persisted = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(persisted.length).toBe(1)
    expect(persisted[0].key).toBe(valid)
  })
})

describe('B-07 re-audit: invalidateTopicsDeletion integration seam', () => {
  it('calls actual invalidateTopicsDeletion seam: removes deleted snapshot+index, retains unrelated', () => {
    const now = Date.now()
    const tDel = 't-del-seam'
    const tKeep = 't-keep-seam'
    const keyDel = `scroll:topic-${tDel}`
    const keyKeep = `scroll:topic-${tKeep}`
    store.set(keyDel, { scrollTop: -100, anchorId: null, isAtBottom: false })
    store.set(keyKeep, { scrollTop: -200, anchorId: null, isAtBottom: false })
    store.set(SCROLL_SNAPSHOT_INDEX_KEY, [
      { key: keyDel, lastAccess: now },
      { key: keyKeep, lastAccess: now }
    ])
    // Precondition
    expect(store.get(keyDel)).toBeDefined()
    expect(store.get(keyKeep)).toBeDefined()
    expect(getDeletionGeneration(tDel)).toBe(0)
    expect(getDeletionGeneration(tKeep)).toBe(0)

    // Production seam (not direct cache removal)
    invalidateTopicsDeletion([tDel])

    // Deleted snapshot and index entry removed
    expect(store.get(keyDel)).toBeUndefined()
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.find((e: any) => e.key === keyDel)).toBeUndefined()
    // Unrelated retained
    expect(store.get(keyKeep)).toBeDefined()
    expect(idx.find((e: any) => e.key === keyKeep)).toBeDefined()
    expect(idx.length).toBe(1)
    expect(getDeletionGeneration(tDel)).toBe(1)
    expect(getDeletionGeneration(tKeep)).toBe(0)
  })

  it('pending throttle trailing blocked through invalidateTopicsDeletion seam (hook integration)', () => {
    vi.useFakeTimers()
    const tPending = 'pending-seam'
    const keyPending = `scroll:topic-${tPending}`
    const container = document.createElement('div')
    Object.defineProperty(container, 'scrollTop', { value: -300, writable: true })
    Object.defineProperty(container, 'scrollHeight', { value: 5000, writable: true })

    const { result } = renderHook(() => useScrollPosition(`topic-${tPending}`))
    act(() => {
      result.current.containerRef.current = container as unknown as HTMLDivElement
      result.current.handleScroll()
    })
    expect((store.get(keyPending) as any)?.scrollTop).toBe(-300)

    // Second scroll within throttle window => trailing pending with -600
    Object.defineProperty(container, 'scrollTop', { value: -600 })
    act(() => {
      result.current.handleScroll()
    })
    // Still leading value
    expect((store.get(keyPending) as any)?.scrollTop).toBe(-300)

    // Production hard-delete seam while trailing pending
    act(() => {
      invalidateTopicsDeletion([tPending])
    })
    expect(store.get(keyPending)).toBeUndefined()

    // Advance past throttle — trailing must not recreate (hook cancel + cache invalidated)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(store.get(keyPending)).toBeUndefined()
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[] | undefined
    if (idx) expect(idx.find((e: any) => e.key === keyPending)).toBeUndefined()

    // Even explicit save attempt after invalidation must remain blocked
    Object.defineProperty(container, 'scrollTop', { value: -999 })
    act(() => {
      result.current.savePosition()
    })
    expect(store.get(keyPending)).toBeUndefined()

    vi.useRealTimers()
  })

  it('durably blocks handleScrollSnapshotSaved trailing after seam deletion', () => {
    const now = Date.now()
    const t = 't-trailing-seam'
    const key = `scroll:topic-${t}`
    store.set(key, { scrollTop: -50, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved(key, now)
    expect(store.get(key)).toBeDefined()

    invalidateTopicsDeletion([t])
    expect(store.get(key)).toBeUndefined()

    // Simulate late trailing write via cache helper
    store.set(key, { scrollTop: -777, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved(key, now + 10)
    expect(store.get(key)).toBeUndefined()
  })
})
