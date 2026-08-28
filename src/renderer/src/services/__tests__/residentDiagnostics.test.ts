/**
 * Resident lifecycle-foundation observability — bounded scalar diagnostics.
 *
 * Renderer-local, read-only, no B-01..B-05, no persistence/IPC/StoreSync.
 * Verifies pure adapter counts completeness markers/generation accurately and
 * composition into Phase4Snapshot + bound scalars, including stale-generation protection.
 */

import { configureStore } from '@reduxjs/toolkit'
import { getPhase4BoundScalars, getPhase4Snapshot } from '@renderer/services/phase4Observability'
import { getResidentDiagnostics, getResidentDiagnosticsFromState } from '@renderer/services/residentDiagnostics'
import type { ResidentEntry } from '@renderer/store/residentRegistry'
import residentRegistryReducer, {
  bumpGeneration,
  clearEntry as clearResidentEntry,
  markSegmentsLoaded,
  publishResidentComplete,
  resetAllResidentRegistry,
  shouldDiscardJointPublish
} from '@renderer/store/residentRegistry'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'
import { describe, expect, it } from 'vitest'

function makeWindowResponse(topicId: string, messages: Array<{ id: string }>): FetchMessagesWindowResponse {
  const returnedCount = messages.length
  return {
    messages: messages as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: { limit: 10 },
      firstMessageId: returnedCount > 0 ? messages[0].id : null,
      lastMessageId: returnedCount > 0 ? messages[returnedCount - 1].id : null,
      returnedCount,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as unknown as FetchMessagesWindowResponse
}

function entriesFromStore(store: ReturnType<typeof configureStore>): Record<string, ResidentEntry> {
  return (store.getState() as any).residentRegistry.entries as Record<string, ResidentEntry>
}

describe('residentDiagnostics pure adapter — bounded scalars, read-only', () => {
  it('empty registry: all zero scalars, bounded shape, no collection retention', () => {
    const diag = getResidentDiagnostics(null)
    expect(diag).toEqual({
      entryCount: 0,
      residentCount: 0,
      chatDataCount: 0,
      segmentsCount: 0,
      incompleteCount: 0,
      maxGeneration: 0
    })
    // bounded shape only
    expect(Object.keys(diag).sort()).toEqual(
      ['chatDataCount', 'entryCount', 'incompleteCount', 'maxGeneration', 'residentCount', 'segmentsCount'].sort()
    )
    // pure: no mutation of input
    const entries: Record<string, ResidentEntry> = {}
    const before = JSON.stringify(entries)
    getResidentDiagnostics(entries)
    expect(JSON.stringify(entries)).toBe(before)
    // serialized contains only bounded scalar keys, not per-topic collections or payload path/credential/size
    const serialized = JSON.stringify(diag)
    expect(serialized).not.toContain('entries')
    expect(serialized).not.toContain('topic-')
    expect(serialized).not.toContain('path')
    expect(serialized).not.toContain('credential')
    // field values are scalars, not arrays/maps
    expect(typeof diag.entryCount).toBe('number')
    expect(typeof diag.maxGeneration).toBe('number')
  })

  it('partial entry after bumpGeneration: incomplete, not resident, maxGeneration 1', () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    store.dispatch(bumpGeneration('t-partial'))
    const e = entriesFromStore(store)
    const diag = getResidentDiagnostics(e)
    expect(diag.entryCount).toBe(1)
    expect(diag.residentCount).toBe(0)
    expect(diag.chatDataCount).toBe(0)
    expect(diag.segmentsCount).toBe(0)
    expect(diag.incompleteCount).toBe(1)
    expect(diag.maxGeneration).toBe(1)
    // completeness invariant: resident false implies chatData && segments not both true
    const entry = e['t-partial']
    expect(entry.chatData).toBe(false)
    expect(entry.segments).toBe(false)
    expect(entry.residentTopic).toBe(false)
  })

  it('standalone segment marker (segments true, chatData false) is partial, not resident, generation advances', () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    store.dispatch(bumpGeneration('t-seg'))
    const gen1 = (store.getState() as any).residentRegistry.entries['t-seg'].applicabilityGeneration as number
    expect(gen1).toBe(1)
    // markSegmentsLoaded simulates standalone segment load: segments true, resident false, gen+1
    store.dispatch(markSegmentsLoaded('t-seg'))
    const diag = getResidentDiagnostics(entriesFromStore(store))
    expect(diag.entryCount).toBe(1)
    expect(diag.residentCount).toBe(0)
    expect(diag.chatDataCount).toBe(0)
    expect(diag.segmentsCount).toBe(1)
    expect(diag.incompleteCount).toBe(1)
    expect(diag.maxGeneration).toBe(2)
    const entry = entriesFromStore(store)['t-seg']
    expect(entry.segments).toBe(true)
    expect(entry.chatData).toBe(false)
    expect(entry.residentTopic).toBe(false)
    // joint completeness requires both; scalar counts reflect that
    expect(diag.residentCount).toBeLessThanOrEqual(Math.min(diag.chatDataCount, diag.segmentsCount) + 1) // but here 0 <=0
  })

  it('complete entry after same-generation joint publication: resident true, both markers true', () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    store.dispatch(bumpGeneration('t-complete'))
    const gen = (store.getState() as any).residentRegistry.entries['t-complete'].applicabilityGeneration as number
    const wr = makeWindowResponse('t-complete', [{ id: 'm1' }])
    store.dispatch(
      publishResidentComplete({ topicId: 't-complete', generation: gen, windowResponse: wr, segments: [] })
    )
    const diag = getResidentDiagnostics(entriesFromStore(store))
    expect(diag.entryCount).toBe(1)
    expect(diag.residentCount).toBe(1)
    expect(diag.chatDataCount).toBe(1)
    expect(diag.segmentsCount).toBe(1)
    expect(diag.incompleteCount).toBe(0)
    expect(diag.maxGeneration).toBe(1)
    const entry = entriesFromStore(store)['t-complete']
    expect(entry.residentTopic).toBe(true)
    expect(entry.chatData).toBe(true)
    expect(entry.segments).toBe(true)
    // invariant: residentCount <= min(chatDataCount, segmentsCount) and equals count where both true
    expect(diag.residentCount).toBe(1)
    expect(diag.chatDataCount).toBe(1)
  })

  it('multiple topics: aggregates correctly, maxGeneration is max across entries', () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    // t1 complete gen1
    store.dispatch(bumpGeneration('t1'))
    const g1 = (store.getState() as any).residentRegistry.entries['t1'].applicabilityGeneration as number
    store.dispatch(
      publishResidentComplete({
        topicId: 't1',
        generation: g1,
        windowResponse: makeWindowResponse('t1', [{ id: 'm1' }]),
        segments: []
      })
    )
    // t2 partial gen1
    store.dispatch(bumpGeneration('t2'))
    // t3 bump twice to get gen2 partial
    store.dispatch(bumpGeneration('t3'))
    store.dispatch(bumpGeneration('t3'))
    const diag = getResidentDiagnostics(entriesFromStore(store))
    expect(diag.entryCount).toBe(3)
    expect(diag.residentCount).toBe(1)
    expect(diag.chatDataCount).toBe(1)
    expect(diag.segmentsCount).toBe(1)
    expect(diag.incompleteCount).toBe(2)
    expect(diag.maxGeneration).toBe(2)
    // fromState helper returns same
    const diag2 = getResidentDiagnosticsFromState(store.getState())
    expect(diag2).toEqual(diag)
  })

  it('generation changes: bump advances maxGeneration and makes entry incomplete', () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    store.dispatch(bumpGeneration('t-gen'))
    const g1 = getResidentDiagnostics(entriesFromStore(store)).maxGeneration
    expect(g1).toBe(1)
    // publish to become resident
    store.dispatch(
      publishResidentComplete({
        topicId: 't-gen',
        generation: 1,
        windowResponse: makeWindowResponse('t-gen', [{ id: 'm1' }]),
        segments: []
      })
    )
    expect(getResidentDiagnostics(entriesFromStore(store)).residentCount).toBe(1)
    expect(getResidentDiagnostics(entriesFromStore(store)).maxGeneration).toBe(1)
    // bump again simulates deletion advance or standalone invalidation
    store.dispatch(bumpGeneration('t-gen'))
    const diag = getResidentDiagnostics(entriesFromStore(store))
    expect(diag.maxGeneration).toBe(2)
    expect(diag.residentCount).toBe(0)
    expect(diag.incompleteCount).toBe(1)
    expect(diag.chatDataCount).toBe(0)
    expect(diag.segmentsCount).toBe(0)
  })

  it('stale publication behavior: older generation does not establish residency, diagnostics unchanged', () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    store.dispatch(bumpGeneration('t-stale'))
    const gen1 = (store.getState() as any).residentRegistry.entries['t-stale'].applicabilityGeneration as number
    expect(gen1).toBe(1)
    // advance generation before publication (concurrent load scenario)
    store.dispatch(bumpGeneration('t-stale'))
    const gen2 = (store.getState() as any).residentRegistry.entries['t-stale'].applicabilityGeneration as number
    expect(gen2).toBe(2)
    const before = getResidentDiagnostics(entriesFromStore(store))
    expect(before.residentCount).toBe(0)
    expect(before.maxGeneration).toBe(2)
    // attempt stale publish with old generation should be discarded
    const stalePayload = {
      topicId: 't-stale',
      generation: gen1,
      windowResponse: makeWindowResponse('t-stale', [{ id: 'm-stale' }]),
      segments: []
    }
    expect(shouldDiscardJointPublish(store.getState(), stalePayload)).toBe(true)
    store.dispatch(publishResidentComplete(stalePayload as any))
    const after = getResidentDiagnostics(entriesFromStore(store))
    expect(after).toEqual(before)
    expect(after.residentCount).toBe(0)
    expect(after.maxGeneration).toBe(2)
    // correct generation publish succeeds
    const goodPayload = {
      topicId: 't-stale',
      generation: gen2,
      windowResponse: makeWindowResponse('t-stale', [{ id: 'm-good' }]),
      segments: []
    }
    expect(shouldDiscardJointPublish(store.getState(), goodPayload)).toBe(false)
    store.dispatch(publishResidentComplete(goodPayload as any))
    const afterGood = getResidentDiagnostics(entriesFromStore(store))
    expect(afterGood.residentCount).toBe(1)
    expect(afterGood.chatDataCount).toBe(1)
    expect(afterGood.segmentsCount).toBe(1)
    expect(afterGood.incompleteCount).toBe(0)
    expect(afterGood.maxGeneration).toBe(2)
  })

  it('empty complete topic joint publication: still resident, still counted', () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    store.dispatch(bumpGeneration('t-empty'))
    const gen = (store.getState() as any).residentRegistry.entries['t-empty'].applicabilityGeneration as number
    const wr = makeWindowResponse('t-empty', [])
    store.dispatch(publishResidentComplete({ topicId: 't-empty', generation: gen, windowResponse: wr, segments: [] }))
    const diag = getResidentDiagnostics(entriesFromStore(store))
    expect(diag.entryCount).toBe(1)
    expect(diag.residentCount).toBe(1)
    expect(diag.chatDataCount).toBe(1)
    expect(diag.segmentsCount).toBe(1)
  })

  it('diagnostics are pure/read-only and do not retain per-topic collections', () => {
    const entries: Record<string, ResidentEntry> = {
      a: { chatData: true, segments: true, residentTopic: true, applicabilityGeneration: 5 },
      b: { chatData: false, segments: true, residentTopic: false, applicabilityGeneration: 2 }
    }
    const d1 = getResidentDiagnostics(entries)
    const d2 = getResidentDiagnostics(entries)
    expect(d1).toEqual(d2)
    // mutating returned copy does not affect next call
    ;(d1 as any).entryCount = 999
    expect(getResidentDiagnostics(entries).entryCount).toBe(2)
    // input not mutated
    expect(entries.a.applicabilityGeneration).toBe(5)
    // no per-topic array/map retained in snapshot — only scalar keys, not topic ids
    const serialized = JSON.stringify(d2)
    expect(serialized).not.toContain('"a"')
    expect(Object.keys(d2)).not.toContain('entries')
    expect(Object.keys(d2)).not.toContain('a')
    // ensure scalar only
    for (const v of Object.values(d2)) {
      expect(typeof v).toBe('number')
    }
  })

  it('composed into Phase4Snapshot and bound scalars: accuracy across lifecycle transitions', () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    // empty composed snapshot
    let snap = getPhase4Snapshot(null, entriesFromStore(store))
    expect(snap.resident.entryCount).toBe(0)
    expect(snap.resident.residentCount).toBe(0)
    // partial
    store.dispatch(bumpGeneration('t-snap'))
    snap = getPhase4Snapshot(null, entriesFromStore(store))
    expect(snap.resident.entryCount).toBe(1)
    expect(snap.resident.residentCount).toBe(0)
    expect(snap.resident.maxGeneration).toBe(1)
    // verify bound scalars reflect same
    let scalars = getPhase4BoundScalars(null, entriesFromStore(store))
    expect(scalars.residentEntryCount).toBe(1)
    expect(scalars.residentResidentCount).toBe(0)
    expect(scalars.residentIncompleteCount).toBe(1)
    expect(scalars.residentMaxGeneration).toBe(1)
    // complete
    store.dispatch(
      publishResidentComplete({
        topicId: 't-snap',
        generation: 1,
        windowResponse: makeWindowResponse('t-snap', [{ id: 'm1' }]),
        segments: []
      })
    )
    snap = getPhase4Snapshot(null, entriesFromStore(store))
    expect(snap.resident.residentCount).toBe(1)
    expect(snap.resident.chatDataCount).toBe(1)
    expect(snap.resident.segmentsCount).toBe(1)
    expect(snap.resident.incompleteCount).toBe(0)
    scalars = getPhase4BoundScalars(null, entriesFromStore(store))
    expect(scalars.residentResidentCount).toBe(1)
    expect(scalars.residentChatDataCount).toBe(1)
    expect(scalars.residentSegmentsCount).toBe(1)
    // stale attempt does not change composed snapshot
    store.dispatch(bumpGeneration('t-snap')) // now gen2 incomplete
    const beforeStale = getPhase4Snapshot(null, entriesFromStore(store)).resident
    store.dispatch(
      publishResidentComplete({
        topicId: 't-snap',
        generation: 1,
        windowResponse: makeWindowResponse('t-snap', [{ id: 'm-stale2' }]),
        segments: []
      }) as any
    )
    const afterStale = getPhase4Snapshot(null, entriesFromStore(store)).resident
    expect(afterStale).toEqual(beforeStale)
    expect(afterStale.residentCount).toBe(0)
    expect(afterStale.maxGeneration).toBe(2)
    // privacy: composed snapshot serializes to scalars only, no message content/paths/credentials
    const serialized = JSON.stringify(snap)
    expect(serialized).not.toContain('blocks')
    expect(serialized).not.toContain('path')
    expect(serialized).not.toContain('credential')
    // resident field itself has bounded scalar keys only
    expect(Object.keys(snap.resident).sort()).toEqual(
      ['chatDataCount', 'entryCount', 'incompleteCount', 'maxGeneration', 'residentCount', 'segmentsCount'].sort()
    )
    // B-06..B-09 remain accessible via same snapshot
    expect(snap.b07).toBeDefined()
    expect(snap.b08).toBeDefined()
    expect(snap.b09).toBeDefined()
  })

  it('global store fallback: getPhase4Snapshot without entries reads from window.store when present', () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    store.dispatch(bumpGeneration('t-global'))
    const gen = (store.getState() as any).residentRegistry.entries['t-global'].applicabilityGeneration as number
    store.dispatch(
      publishResidentComplete({
        topicId: 't-global',
        generation: gen,
        windowResponse: makeWindowResponse('t-global', [{ id: 'm1' }]),
        segments: []
      })
    )
    // install global
    const prev = (window as any).store
    ;(window as any).store = store
    try {
      const snap = getPhase4Snapshot(null)
      expect(snap.resident.entryCount).toBe(1)
      expect(snap.resident.residentCount).toBe(1)
    } finally {
      ;(window as any).store = prev
    }
    // without global, fallback to empty
    ;(window as any).store = undefined
    const emptySnap = getPhase4Snapshot(null)
    expect(emptySnap.resident.entryCount).toBe(0)
    // restore
    ;(window as any).store = prev
  })

  it('clearing highest-generation entry recomputes maxGeneration and resetAll clears all derived resident scalars', () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })

    // surviving lower-generation resident entry (gen 1)
    store.dispatch(bumpGeneration('t-survivor'))
    const survivorGen = (store.getState() as any).residentRegistry.entries['t-survivor']
      .applicabilityGeneration as number
    expect(survivorGen).toBe(1)
    store.dispatch(
      publishResidentComplete({
        topicId: 't-survivor',
        generation: survivorGen,
        windowResponse: makeWindowResponse('t-survivor', [{ id: 'm-survivor' }]),
        segments: []
      })
    )

    // removable highest-generation resident entry (gen 3)
    store.dispatch(bumpGeneration('t-high'))
    store.dispatch(bumpGeneration('t-high'))
    store.dispatch(bumpGeneration('t-high'))
    const highGen = (store.getState() as any).residentRegistry.entries['t-high'].applicabilityGeneration as number
    expect(highGen).toBe(3)
    store.dispatch(
      publishResidentComplete({
        topicId: 't-high',
        generation: highGen,
        windowResponse: makeWindowResponse('t-high', [{ id: 'm-high' }]),
        segments: []
      })
    )

    // before: both complete/observable, different generations
    const before = getResidentDiagnostics(entriesFromStore(store))
    const beforeFromState = getResidentDiagnosticsFromState(store.getState())
    expect(before).toEqual(beforeFromState)
    expect(before.entryCount).toBe(2)
    expect(before.residentCount).toBe(2)
    expect(before.chatDataCount).toBe(2)
    expect(before.segmentsCount).toBe(2)
    expect(before.incompleteCount).toBe(0)
    expect(before.maxGeneration).toBe(3)
    expect(before.incompleteCount).toBe(before.entryCount - before.residentCount)
    // Phase4 composition reflects same before state
    const snapBefore = getPhase4Snapshot(null, entriesFromStore(store))
    expect(snapBefore.resident).toEqual(before)
    const scalarsBefore = getPhase4BoundScalars(null, entriesFromStore(store))
    expect(scalarsBefore.residentEntryCount).toBe(2)
    expect(scalarsBefore.residentResidentCount).toBe(2)
    expect(scalarsBefore.residentChatDataCount).toBe(2)
    expect(scalarsBefore.residentSegmentsCount).toBe(2)
    expect(scalarsBefore.residentIncompleteCount).toBe(0)
    expect(scalarsBefore.residentMaxGeneration).toBe(3)

    // clear highest-generation entry via public slice action path
    store.dispatch(clearResidentEntry('t-high'))
    expect(entriesFromStore(store)['t-high']).toBeUndefined()
    const afterClear = getResidentDiagnostics(entriesFromStore(store))
    const afterClearFromState = getResidentDiagnosticsFromState(store.getState())
    expect(afterClear).toEqual(afterClearFromState)
    expect(afterClear.entryCount).toBe(1)
    expect(afterClear.entryCount).toBeLessThan(before.entryCount)
    expect(afterClear.maxGeneration).toBe(survivorGen)
    expect(afterClear.maxGeneration).toBeLessThan(before.maxGeneration)
    expect(afterClear.residentCount).toBe(1)
    expect(afterClear.chatDataCount).toBe(1)
    expect(afterClear.segmentsCount).toBe(1)
    expect(afterClear.incompleteCount).toBe(0)
    expect(afterClear.incompleteCount).toBe(afterClear.entryCount - afterClear.residentCount)
    // privacy: bounded scalar-only, no per-topic collections or sensitive payload
    const serializedClear = JSON.stringify(afterClear)
    expect(serializedClear).not.toContain('t-survivor')
    expect(serializedClear).not.toContain('t-high')
    expect(serializedClear).not.toContain('path')
    expect(serializedClear).not.toContain('credential')
    expect(Object.keys(afterClear).sort()).toEqual(
      ['chatDataCount', 'entryCount', 'incompleteCount', 'maxGeneration', 'residentCount', 'segmentsCount'].sort()
    )
    // Phase4 composition after clear remains coherent and recomputed
    const snapAfterClear = getPhase4Snapshot(null, entriesFromStore(store))
    expect(snapAfterClear.resident).toEqual(afterClear)
    expect(snapAfterClear.resident.maxGeneration).toBe(1)
    const scalarsAfterClear = getPhase4BoundScalars(null, entriesFromStore(store))
    expect(scalarsAfterClear.residentEntryCount).toBe(1)
    expect(scalarsAfterClear.residentMaxGeneration).toBe(1)
    expect(scalarsAfterClear.residentResidentCount).toBe(1)
    expect(scalarsAfterClear.residentIncompleteCount).toBe(0)
    expect(scalarsAfterClear.residentChatDataCount).toBe(1)
    expect(scalarsAfterClear.residentSegmentsCount).toBe(1)

    // resetAll clears all derived resident scalars to zero
    store.dispatch(resetAllResidentRegistry())
    const afterReset = getResidentDiagnostics(entriesFromStore(store))
    const afterResetFromState = getResidentDiagnosticsFromState(store.getState())
    expect(afterReset).toEqual(afterResetFromState)
    expect(afterReset).toEqual({
      entryCount: 0,
      residentCount: 0,
      chatDataCount: 0,
      segmentsCount: 0,
      incompleteCount: 0,
      maxGeneration: 0
    })
    expect(Object.keys(afterReset).sort()).toEqual(
      ['chatDataCount', 'entryCount', 'incompleteCount', 'maxGeneration', 'residentCount', 'segmentsCount'].sort()
    )
    const serializedReset = JSON.stringify(afterReset)
    expect(serializedReset).not.toContain('t-survivor')
    expect(serializedReset).not.toContain('entries')
    // Phase4 snapshot/bound scalars composition after reset
    const snapAfterReset = getPhase4Snapshot(null, entriesFromStore(store))
    expect(snapAfterReset.resident).toEqual(afterReset)
    expect(snapAfterReset.resident.entryCount).toBe(0)
    expect(snapAfterReset.resident.maxGeneration).toBe(0)
    const scalarsAfterReset = getPhase4BoundScalars(null, entriesFromStore(store))
    expect(scalarsAfterReset.residentEntryCount).toBe(0)
    expect(scalarsAfterReset.residentResidentCount).toBe(0)
    expect(scalarsAfterReset.residentChatDataCount).toBe(0)
    expect(scalarsAfterReset.residentSegmentsCount).toBe(0)
    expect(scalarsAfterReset.residentIncompleteCount).toBe(0)
    expect(scalarsAfterReset.residentMaxGeneration).toBe(0)
    // pure adapter: global diagnostics also zero when entries cleared
    expect(getResidentDiagnosticsFromState(store.getState())).toEqual(afterReset)
  })
})
