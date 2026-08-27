/**
 * B-08 bounded owner protocol — audit blocker focused tests.
 *
 * Verifies the approval direction:
 * - monotonic numeric owner IDs, bounded scalars activeOwnerId/lastCommittedOwnerId, no Set growth
 * - stale A commit/clear/invalidation/rescan remain rejected after B releases
 * - never-committed B clear cannot claim/steal active A snapshot
 * - repeated owner create/commit/release does not require historical Set retention
 */

import { beforeEach, describe, expect, it } from 'vitest'

import * as diagnosticsModule from '../contentSearchDiagnostics'
import {
  createContentSearchSessionOwnerId,
  getActiveContentSearchOwnerForTests,
  getContentSearchDiagnostics,
  incrementInvalidationCount,
  incrementRescanCount,
  recordContentSearchClear,
  recordContentSearchCommit,
  recordContentSearchInvalidation,
  recordContentSearchRescan,
  recordContentSearchRescanIncrement,
  recordContentSearchSameChunkRescan,
  releaseContentSearchSessionIfOwned,
  resetContentSearchDiagnosticsForTests,
  setContentSearchDomGeneration,
  syncContentSearchDiagnosticsFromState
} from '../contentSearchDiagnostics'

describe('B-08 bounded deterministic owner protocol', () => {
  beforeEach(() => {
    resetContentSearchDiagnosticsForTests()
  })

  it('A commits -> B commits -> B releases -> stale A commit/clear/invalidation/rescan/generation remain rejected; fresh C can claim', () => {
    const ownerA = createContentSearchSessionOwnerId() // 1
    const ownerB = createContentSearchSessionOwnerId() // 2

    // A commits
    recordContentSearchCommit(ownerA, 10, 0, 10, 1)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerA)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(10)
    expect(getContentSearchDiagnostics().totalCount).toBe(10)

    // B commits and steals (newer than lastCommitted 1)
    recordContentSearchCommit(ownerB, 20, 1, 20, 2)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerB)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(20)
    const snapshotB = { ...getContentSearchDiagnostics() }
    const snapRescanBefore = snapshotB.rescanCount
    const snapInvalidBefore = snapshotB.invalidationCount

    // B releases — active null, live cleared, lastCommitted retained as B (2)
    expect(releaseContentSearchSessionIfOwned(ownerB)).toBe(true)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(0)
    expect(getContentSearchDiagnostics().totalCount).toBe(0)

    const afterRelease = { ...getContentSearchDiagnostics() }

    // Stale A commit must be rejected even though active is null (old id 1 <= lastCommitted 2)
    recordContentSearchCommit(ownerA, 999, 9, 9999, 999)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(afterRelease.liveRangeCount)
    expect(getContentSearchDiagnostics().totalCount).toBe(afterRelease.totalCount)
    expect(getContentSearchDiagnostics().chunkIndex).toBe(afterRelease.chunkIndex)
    expect(getContentSearchDiagnostics().domGeneration).toBe(afterRelease.domGeneration)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()

    // Stale A clear must be rejected and not claim (active remains null, live stays 0)
    recordContentSearchClear(ownerA, 1000)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(afterRelease.liveRangeCount)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()

    // Stale A invalidation/rescan/generation writes must be rejected (active-owner-only)
    recordContentSearchInvalidation(ownerA, 1001)
    expect(getContentSearchDiagnostics().invalidationCount).toBe(snapInvalidBefore)
    expect(getContentSearchDiagnostics().domGeneration).toBe(afterRelease.domGeneration)

    recordContentSearchRescanIncrement(ownerA)
    expect(getContentSearchDiagnostics().rescanCount).toBe(snapRescanBefore)

    recordContentSearchRescan(ownerA, 5, 0, 5, 1002)
    expect(getContentSearchDiagnostics().rescanCount).toBe(snapRescanBefore)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(afterRelease.liveRangeCount)

    recordContentSearchSameChunkRescan(ownerA, 1003)
    expect(getContentSearchDiagnostics().rescanCount).toBe(snapRescanBefore)

    incrementRescanCount(ownerA)
    expect(getContentSearchDiagnostics().rescanCount).toBe(snapRescanBefore)

    incrementInvalidationCount(ownerA)
    expect(getContentSearchDiagnostics().invalidationCount).toBe(snapInvalidBefore)

    setContentSearchDomGeneration(ownerA, 1004)
    expect(getContentSearchDiagnostics().domGeneration).toBe(afterRelease.domGeneration)

    syncContentSearchDiagnosticsFromState(ownerA, {
      liveRangeCount: 50,
      chunkIndex: 5,
      totalCount: 500,
      domGeneration: 1005
    })
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(afterRelease.liveRangeCount)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()

    // Stale release must be false and not clear
    expect(releaseContentSearchSessionIfOwned(ownerA)).toBe(false)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()

    // Fresh C (newer than lastCommitted 2) can claim after release
    const ownerC = createContentSearchSessionOwnerId() // 3
    expect(ownerC).toBeGreaterThan(ownerB)
    recordContentSearchCommit(ownerC, 7, 0, 7, 3)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerC)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(7)
    expect(getContentSearchDiagnostics().totalCount).toBe(7)

    // Stale A still rejected even with active C
    recordContentSearchCommit(ownerA, 8, 0, 8, 4)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(7)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerC)

    recordContentSearchClear(ownerA, 10)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(7)

    // Stale B same id as released (2 <= lastCommitted 3) also rejected when trying to reclaim after C
    recordContentSearchCommit(ownerB, 9, 0, 9, 5)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(7)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerC)
  })

  it('active A -> never-committed B clear/invalidation/rescan/release remain unable to clear A snapshot', () => {
    const ownerA = createContentSearchSessionOwnerId()
    const ownerB = createContentSearchSessionOwnerId() // never committed

    recordContentSearchCommit(ownerA, 15, 2, 15, 1)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerA)
    const snapshotA = { ...getContentSearchDiagnostics() }

    // Never-committed B clear must be no-op and must NOT claim ownership
    recordContentSearchClear(ownerB, 2)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(snapshotA.liveRangeCount)
    expect(getContentSearchDiagnostics().totalCount).toBe(snapshotA.totalCount)
    expect(getContentSearchDiagnostics().chunkIndex).toBe(snapshotA.chunkIndex)
    expect(getContentSearchDiagnostics().domGeneration).toBe(snapshotA.domGeneration)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerA)

    // All active-only APIs from B must be rejected
    const beforeInvalid = getContentSearchDiagnostics().invalidationCount
    const beforeRescan = getContentSearchDiagnostics().rescanCount
    recordContentSearchInvalidation(ownerB, 999)
    expect(getContentSearchDiagnostics().invalidationCount).toBe(beforeInvalid)
    recordContentSearchRescanIncrement(ownerB)
    expect(getContentSearchDiagnostics().rescanCount).toBe(beforeRescan)
    recordContentSearchRescan(ownerB, 99, 9, 999, 999)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(snapshotA.liveRangeCount)
    recordContentSearchSameChunkRescan(ownerB, 999)
    expect(getContentSearchDiagnostics().rescanCount).toBe(beforeRescan)
    incrementRescanCount(ownerB)
    expect(getContentSearchDiagnostics().rescanCount).toBe(beforeRescan)
    incrementInvalidationCount(ownerB)
    expect(getContentSearchDiagnostics().invalidationCount).toBe(beforeInvalid)
    setContentSearchDomGeneration(ownerB, 999)
    expect(getContentSearchDiagnostics().domGeneration).toBe(snapshotA.domGeneration)
    syncContentSearchDiagnosticsFromState(ownerB, {
      liveRangeCount: 99,
      chunkIndex: 9,
      totalCount: 999,
      domGeneration: 999
    })
    // B is older than lastCommitted (1) ? Actually B=2 >1 so B could commit via sync? But B has never committed and is newer than last (1), so sync would claim.
    // To keep clear-no-claim invariant isolated, we test clear separately: create B2 that is also fresh but test that clear alone does not claim.
    // For sync, B=2 >1, so after above sync, B would have become active — reset to verify clear-only no-claim more strictly
    // So we need a dedicated never-committed newer-than-last but clear still no-op scenario: redo with fresh A

    // Reset and re-establish A as active, B never committed, then B clear must remain no-op even though B is newer than last
    resetContentSearchDiagnosticsForTests()
    const ownerA2 = createContentSearchSessionOwnerId() // 1
    const ownerB2 = createContentSearchSessionOwnerId() // 2
    recordContentSearchCommit(ownerA2, 12, 1, 12, 5)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerA2)
    const snapA2 = { ...getContentSearchDiagnostics() }
    // B2 clear must not steal even though B2=2 > lastCommitted 1 and active is A2
    recordContentSearchClear(ownerB2, 6)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(snapA2.liveRangeCount)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerA2)

    // B release must be false
    expect(releaseContentSearchSessionIfOwned(ownerB2)).toBe(false)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerA2)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(snapA2.liveRangeCount)

    // Simulate disable/reset/clear path via repeated B clear attempts
    recordContentSearchClear(ownerB2, 7)
    recordContentSearchClear(ownerB2, 8)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerA2)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(snapA2.liveRangeCount)

    // Active A clear succeeds and preserves ownership
    recordContentSearchClear(ownerA2, 9)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(0)
    expect(getContentSearchDiagnostics().totalCount).toBe(0)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerA2)

    // After active clear, never-committed B still cannot affect via invalidation
    const invalidBefore = getContentSearchDiagnostics().invalidationCount
    recordContentSearchInvalidation(ownerB2, 10)
    expect(getContentSearchDiagnostics().invalidationCount).toBe(invalidBefore)
  })

  it('repeated owner create/commit/release does not require retained historical owner state', () => {
    // Assert no unbounded committed-owner export exists; only scalar diagnostics shape
    expect((diagnosticsModule as any).committedOwners).toBeUndefined()
    // @ts-ignore check internal set not exported under any name containing committed
    const exportedKeys = Object.keys(diagnosticsModule)
    expect(exportedKeys.some((k) => k.toLowerCase().includes('committed'))).toBe(false)

    // Stress loop: 200 allocate/commit/release cycles with only scalar state
    for (let i = 0; i < 200; i++) {
      const owner = createContentSearchSessionOwnerId()
      recordContentSearchCommit(owner, (i % 500) + 1, i % 10, (i % 500) + 1, i + 1)
      expect(getActiveContentSearchOwnerForTests()).toBe(owner)
      expect(getContentSearchDiagnostics().liveRangeCount).toBeLessThanOrEqual(500)
      expect(releaseContentSearchSessionIfOwned(owner)).toBe(true)
      expect(getActiveContentSearchOwnerForTests()).toBeNull()
      expect(getContentSearchDiagnostics().liveRangeCount).toBe(0)
      // stale reuse of same id must be rejected after release (since lastCommitted = owner)
      recordContentSearchCommit(owner, 999, 9, 9999, 9999)
      expect(getActiveContentSearchOwnerForTests()).toBeNull()
      expect(getContentSearchDiagnostics().liveRangeCount).toBe(0)
    }

    // After many cycles, public diagnostic semantics remain correct: only bounded scalars
    const diag = getContentSearchDiagnostics()
    expect(Object.keys(diag).sort()).toEqual(
      [
        'chunkIndex',
        'chunkSize',
        'domGeneration',
        'invalidationCount',
        'liveRangeCount',
        'maxLiveRanges',
        'rescanCount',
        'totalCount'
      ].sort()
    )
    expect(diag.liveRangeCount).toBeLessThanOrEqual(500)
    expect(diag.maxLiveRanges).toBe(500)
    expect(diag.chunkSize).toBe(500)
    // No content retention
    const serialized = JSON.stringify(diag)
    expect(serialized).not.toContain('hello')
    expect(serialized).not.toContain('<div')

    // Oldest owner (1) still rejected after many cycles (1 <= lastCommitted ~200+)
    const veryOldOwner = 1
    recordContentSearchCommit(veryOldOwner, 123, 0, 123, 9999)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()
    recordContentSearchClear(veryOldOwner, 9999)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()

    // Fresh owner after all cycles can still claim (monotonic newer than last)
    const fresh = createContentSearchSessionOwnerId()
    recordContentSearchCommit(fresh, 42, 3, 42, 10000)
    expect(getActiveContentSearchOwnerForTests()).toBe(fresh)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(42)

    // Verify module retains only bounded scalar ownership state (no Set size growth)
    // Create 500 more owners without release, but only fresh commits should succeed via monotonic ordering
    resetContentSearchDiagnosticsForTests()
    const first = createContentSearchSessionOwnerId()
    recordContentSearchCommit(first, 10, 0, 10, 1)
    expect(getActiveContentSearchOwnerForTests()).toBe(first)
    // Subsequent owners 2..500 each commit and steal sequentially; stale first never regains
    for (let i = 0; i < 100; i++) {
      const o = createContentSearchSessionOwnerId()
      recordContentSearchCommit(o, 11, 0, 11, i + 2)
      expect(getActiveContentSearchOwnerForTests()).toBe(o)
    }
    recordContentSearchCommit(first, 99, 9, 99, 999)
    expect(getActiveContentSearchOwnerForTests()).not.toBe(first)
    // Live still bounded
    expect(getContentSearchDiagnostics().liveRangeCount).toBeLessThanOrEqual(500)
  })

  it('clear never claims when active is null; commit requires monotonic newer', () => {
    const ownerA = createContentSearchSessionOwnerId()
    recordContentSearchCommit(ownerA, 5, 0, 5, 1)
    expect(releaseContentSearchSessionIfOwned(ownerA)).toBe(true)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()

    const ownerNeverCommitted = createContentSearchSessionOwnerId() // 2
    // Even though active is null, never-committed clear must be no-op (not claim)
    recordContentSearchClear(ownerNeverCommitted, 2)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(0)

    // Commit from never-committed newer owner should succeed (since 2 > lastCommitted 1)
    recordContentSearchCommit(ownerNeverCommitted, 8, 0, 8, 2)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerNeverCommitted)

    // Release it, then stale clear from same owner should not mutate domGeneration
    expect(releaseContentSearchSessionIfOwned(ownerNeverCommitted)).toBe(true)
    const genBefore = getContentSearchDiagnostics().domGeneration
    recordContentSearchClear(ownerNeverCommitted, 99)
    expect(getContentSearchDiagnostics().domGeneration).toBe(genBefore)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()

    // Old ownerA (1) commit still rejected after two releases (lastCommitted 2)
    recordContentSearchCommit(ownerA, 7, 0, 7, 3)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()
  })
})
