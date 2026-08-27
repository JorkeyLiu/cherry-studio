import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  enforceScrollSnapshotBounds,
  getScrollSnapshotDiagnostics,
  getScrollSnapshotEnforcementDiagnostics,
  resetScrollSnapshotCacheForTests,
  resetScrollSnapshotDiagnosticsForTests,
  SCROLL_SNAPSHOT_MAX_COUNT,
  SCROLL_SNAPSHOT_TTL_MS
} from '../scrollSnapshotCache'

let store: Map<string, unknown>

function createKeyvMock() {
  return {
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => store.set(k, v),
    remove: (k: string) => store.delete(k),
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
  resetScrollSnapshotDiagnosticsForTests()
})

describe('B-07 diagnostics exports and raw/success semantics', () => {
  it('exports are available and return scalar/no-sensitive values', () => {
    const d = getScrollSnapshotDiagnostics()
    expect(typeof d.indexCount).toBe('number')
    expect(d.maxCount).toBe(SCROLL_SNAPSHOT_MAX_COUNT)
    expect(d.ttlMs).toBe(SCROLL_SNAPSHOT_TTL_MS)
    expect(d.lastEnforcement).toBeNull()
    const e = getScrollSnapshotEnforcementDiagnostics()
    expect(e).toBeNull()
    const serialized = JSON.stringify(d)
    expect(serialized).not.toContain('scroll:topic')
    expect(serialized).not.toContain('path')
  })

  it('raw indexCountBefore captures persisted array length before repair', () => {
    const now = Date.now()
    // 7 raw entries including duplicates and malformed
    const raw: unknown[] = [
      { key: 'scroll:topic-a', lastAccess: now },
      { key: 'scroll:topic-a', lastAccess: now },
      { key: 'scroll:topic-b', lastAccess: now },
      { key: 'scroll:SearchResults', lastAccess: now },
      { key: '', lastAccess: now },
      { lastAccess: now } as unknown,
      { key: 'scroll:topic-a', lastAccess: NaN } as unknown
    ]
    store.set('scroll:topic-a', { scrollTop: -1 })
    store.set('scroll:topic-b', { scrollTop: -1 })
    store.set('scroll:__index__', raw)
    enforceScrollSnapshotBounds(now)
    const diag = getScrollSnapshotDiagnostics()
    expect(diag.lastEnforcement!.indexCountBefore).toBe(7)
    expect(diag.lastEnforcement!.didRebuild).toBe(true)
    expect(diag.lastEnforcement!.indexCountAfter).toBe(2)
  })

  it('expiredRemoved counts only successful removals (false and throw not counted)', () => {
    const now = Date.now()
    // 3 expired, 1 returns false, 1 throws
    for (let i = 0; i < 3; i++) store.set(`scroll:topic-exp-${i}`, { scrollTop: -i })
    for (let i = 0; i < 2; i++) store.set(`scroll:topic-fresh-${i}`, { scrollTop: -i })
    const idx = [
      ...[0, 1, 2].map((i) => ({ key: `scroll:topic-exp-${i}`, lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 1000 })),
      ...[0, 1].map((i) => ({ key: `scroll:topic-fresh-${i}`, lastAccess: now }))
    ]
    store.set('scroll:__index__', idx)
    // mock remove: exp-0 false, exp-1 throw, exp-2 success
    let calls = 0
    ;(window as any).keyv = {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => store.set(k, v),
      remove: (k: string) => {
        calls += 1
        if (k === 'scroll:topic-exp-0') return false
        if (k === 'scroll:topic-exp-1') throw new Error('fail')
        return store.delete(k)
      },
      keys: () => Array.from(store.keys())
    }
    enforceScrollSnapshotBounds(now)
    const diag = getScrollSnapshotDiagnostics()
    expect(diag.lastEnforcement!.indexCountBefore).toBe(5)
    expect(diag.lastEnforcement!.expiredRemoved).toBe(1)
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  it('lruEvicted counts only successful removals (false and throw not counted)', () => {
    const now = Date.now()
    const total = SCROLL_SNAPSHOT_MAX_COUNT + 3 // 259
    for (let i = 0; i < total; i++) {
      const k = `scroll:topic-${String(i).padStart(3, '0')}`
      store.set(k, { scrollTop: -i })
    }
    const idx = Array.from({ length: total }, (_, i) => ({
      key: `scroll:topic-${String(i).padStart(3, '0')}`,
      lastAccess: now
    }))
    store.set('scroll:__index__', idx)
    // mock: first 2 evictions fail (false, throw), third succeeds
    ;(window as any).keyv = {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => store.set(k, v),
      remove: (k: string) => {
        if (k === 'scroll:topic-000') return false
        if (k === 'scroll:topic-001') throw new Error('fail')
        return store.delete(k)
      },
      keys: () => Array.from(store.keys())
    }
    enforceScrollSnapshotBounds(now)
    const diag = getScrollSnapshotDiagnostics()
    // 3 entries over budget, but 2 failures so success 1
    expect(diag.lastEnforcement!.indexCountBefore).toBe(total)
    expect(diag.lastEnforcement!.lruEvicted).toBe(1)
    expect(diag.lastEnforcement!.indexCountAfter).toBe(SCROLL_SNAPSHOT_MAX_COUNT)
    expect(diag.lastEnforcement!.didRebuild).toBe(false)
  })

  it('reset helper clears diagnostics only without altering Keyv/index', () => {
    const now = Date.now()
    store.set('scroll:topic-x', { scrollTop: -1 })
    store.set('scroll:topic-y', { scrollTop: -1 })
    store.set('scroll:__index__', [
      { key: 'scroll:topic-x', lastAccess: now },
      { key: 'scroll:topic-y', lastAccess: now }
    ])
    enforceScrollSnapshotBounds(now)
    const before = getScrollSnapshotDiagnostics()
    expect(before.lastEnforcement).not.toBeNull()
    expect(before.indexCount).toBe(2)
    resetScrollSnapshotDiagnosticsForTests()
    const after = getScrollSnapshotDiagnostics()
    expect(after.lastEnforcement).toBeNull()
    expect(after.indexCount).toBe(2)
    expect(getScrollSnapshotEnforcementDiagnostics()).toBeNull()
    // Keyv still intact
    expect(store.get('scroll:__index__')).toBeDefined()
    expect(store.get('scroll:topic-x')).toBeDefined()
  })

  it('getScrollSnapshotEnforcementDiagnostics mirrors lastEnforcement', () => {
    const now = Date.now()
    enforceScrollSnapshotBounds(now)
    expect(getScrollSnapshotEnforcementDiagnostics()).toEqual(getScrollSnapshotDiagnostics().lastEnforcement)
  })
})
