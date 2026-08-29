/**
 * Pure deterministic policy engine tests for B-01..B-05 ordering/boundaries/tie-breaks.
 * Renderer-local, no IPC/persistence.
 */

import { describe, expect, it } from 'vitest'

import {
  RETENTION_MAX_BYTES,
  RETENTION_TTL_MS,
  type RetentionCandidate,
  selectRetentionEvictionOrder
} from '../residentRetentionPolicy'

const MAX_BYTES = RETENTION_MAX_BYTES
const TTL = RETENTION_TTL_MS
const NOW = 1_700_000_000_000

function cand(id: string, lastAccessOffsetMs: number, bytes: number): RetentionCandidate {
  return { topicId: id, lastAccess: NOW - lastAccessOffsetMs, byteLength: bytes }
}

describe('residentRetentionPolicy — B-01..B-05 deterministic ordering', () => {
  it('TTL: >=30m idle evicts, 29:59 does not', () => {
    const justExpired = cand('t-expired', TTL, 1000)
    const exactlyExpired = cand('t-exact', TTL, 1000)
    const notExpired = cand('t-fresh', TTL - 1, 1000)
    const { victims, reasonByTopic } = selectRetentionEvictionOrder([justExpired, notExpired], NOW)
    expect(victims).toContain('t-expired')
    expect(victims).not.toContain('t-fresh')
    expect(reasonByTopic['t-expired']).toBe('ttl')

    const { victims: v2 } = selectRetentionEvictionOrder([exactlyExpired], NOW)
    expect(v2).toContain('t-exact')

    const { victims: v3 } = selectRetentionEvictionOrder([cand('t-near', TTL - 60000, 1000)], NOW)
    expect(v3.length).toBe(0)
  })

  it('oversized: >32MiB evicts, exactly 32MiB does not', () => {
    const oversized = cand('t-over', 1000, MAX_BYTES + 1)
    const exact = cand('t-exact', 1000, MAX_BYTES)
    const { victims, reasonByTopic } = selectRetentionEvictionOrder([oversized, exact], NOW)
    expect(victims).toContain('t-over')
    expect(victims).not.toContain('t-exact')
    expect(reasonByTopic['t-over']).toBe('oversized')

    const { victims: v2 } = selectRetentionEvictionOrder([exact], NOW)
    expect(v2.length).toBe(0)
  })

  it('count pressure: max 8 inactive evictable, LRU evicts oldest (9th) with lexical tie-break', () => {
    const candidates: RetentionCandidate[] = []
    for (let i = 0; i < 9; i++) {
      // lastAccess increasing with i (0 oldest)
      candidates.push(cand(`t-${String(i).padStart(2, '0')}`, (9 - i) * 1000, 1000))
    }
    // t-00 oldest (lastAccess smallest), t-08 newest
    // Need to make oldest have smallest lastAccess: NOW - offset, so larger offset = older
    // Our loop gives t-00 offset 9000 (oldest), t-08 offset 1000 (newest)
    const { victims } = selectRetentionEvictionOrder(candidates, NOW)
    expect(victims.length).toBe(1)
    expect(victims[0]).toBe('t-00')
  })

  it('byte pressure: aggregate >32MiB evicts LRU until <=32MiB; exactly 32MiB does not evict', () => {
    const bytesEach = 8 * 1024 * 1024 // 8 MiB
    const candidates: RetentionCandidate[] = []
    // 5 topics *8 =40 MiB >32, should evict 1 oldest to get 32
    for (let i = 0; i < 5; i++) {
      candidates.push(cand(`t-${i}`, (5 - i) * 1000, bytesEach))
    }
    const { victims } = selectRetentionEvictionOrder(candidates, NOW)
    expect(victims.length).toBe(1)
    expect(victims[0]).toBe('t-0')

    // exactly 32 MiB aggregate should not evict (4*8=32)
    const exactCandidates: RetentionCandidate[] = []
    for (let i = 0; i < 4; i++) exactCandidates.push(cand(`t-${i}`, 1000, bytesEach))
    const { victims: v2 } = selectRetentionEvictionOrder(exactCandidates, NOW)
    expect(v2.length).toBe(0)

    // 33 MiB aggregate should evict
    const over = [cand('t-a', 2000, 16 * 1024 * 1024), cand('t-b', 1000, 16 * 1024 * 1024 + 1)]
    const { victims: v3 } = selectRetentionEvictionOrder(over, NOW)
    expect(v3.length).toBe(1)
    expect(v3[0]).toBe('t-a')
  })

  it('lexical tie-break for equal recency (LRU tie-break)', () => {
    const sameTime = NOW - 5000
    const a: RetentionCandidate = { topicId: 't-a', lastAccess: sameTime, byteLength: 1000 }
    const b: RetentionCandidate = { topicId: 't-b', lastAccess: sameTime, byteLength: 1000 }
    const c: RetentionCandidate = { topicId: 't-0', lastAccess: sameTime, byteLength: 1000 }
    // Need 9 topics with same lastAccess to trigger count pressure; lexical smallest evicted first
    const candidates: RetentionCandidate[] = []
    const ids = ['t-2', 't-1', 't-0', 't-3', 't-4', 't-5', 't-6', 't-7', 't-8']
    for (const id of ids) candidates.push({ topicId: id, lastAccess: sameTime, byteLength: 1000 })
    const { victims } = selectRetentionEvictionOrder(candidates, NOW)
    expect(victims.length).toBe(1)
    expect(victims[0]).toBe('t-0') // lexical smallest among equal recency oldest
    void a
    void b
    void c
  })

  it('deterministic global order: TTL first, then oversized, then LRU', () => {
    const ttlVictim = cand('t-ttl', TTL + 1000, 1000) // expired
    const oversizedVictim = cand('t-over', 1000, MAX_BYTES + 1000) // not TTL but oversized
    const lruVictimOld = cand('t-lru-old', 5000, 1000)
    const lruVictimNew = cand('t-lru-new', 1000, 1000)
    // Create 9 evictable topics to force LRU after TTL/oversized removed
    // Candidates: ttl, oversized, plus 7 LRU normals + 2 extra to push count to 9? Let's create precisely
    // We have ttl + oversized + 7 normals =9; but after removing ttl and oversized, remaining 7 is within 8, so no LRU.
    // To force LRU after, need remaining >8. So make 9 normals + ttl + oversized =11 total, after removing 2 => 9 remain >8 => 1 LRU
    const normals: RetentionCandidate[] = []
    for (let i = 0; i < 9; i++) {
      const isOld = i === 0
      normals.push(cand(`t-n-${i}`, isOld ? 10000 : 1000, 1000))
    }
    const all = [ttlVictim, oversizedVictim, ...normals]
    const { victims, reasonByTopic } = selectRetentionEvictionOrder(all, NOW)
    // First should be TTL, second oversized, third LRU oldest normal
    expect(victims[0]).toBe('t-ttl')
    expect(reasonByTopic['t-ttl']).toBe('ttl')
    expect(victims[1]).toBe('t-over')
    expect(reasonByTopic['t-over']).toBe('oversized')
    expect(victims[2]).toBe('t-n-0')
    expect(reasonByTopic['t-n-0']).toBe('lru-count')
    void lruVictimOld
    void lruVictimNew
  })

  it('count and byte pressure together use LRU; deterministic tie handling', () => {
    // 9 topics each 8MiB => count pressure (9>8) and byte pressure (72>32) both violated => evict LRU oldest first
    const bytes = 8 * 1024 * 1024
    const candidates: RetentionCandidate[] = []
    for (let i = 0; i < 9; i++) candidates.push(cand(`t-${String(i).padStart(2, '0')}`, (9 - i) * 1000, bytes))
    const { victims } = selectRetentionEvictionOrder(candidates, NOW)
    // Must evict at least until byte pressure gone: need to go from 72 to <=32 => evict 5 oldest (72-40=32)
    // But also count pressure: 9->8 needs 1 eviction; byte pressure dominates.
    // Policy evicts oldest repeatedly until both satisfied: so expect 5 victims
    expect(victims.length).toBe(5)
    expect(victims).toEqual(['t-00', 't-01', 't-02', 't-03', 't-04'])
  })

  it('empty and single candidate produce no spurious victims', () => {
    expect(selectRetentionEvictionOrder([], NOW).victims.length).toBe(0)
    expect(selectRetentionEvictionOrder([cand('t-1', 1000, 1000)], NOW).victims.length).toBe(0)
  })
})
