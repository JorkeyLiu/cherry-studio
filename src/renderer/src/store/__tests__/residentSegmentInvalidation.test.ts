/**
 * LOCK-302 receiving-window and local structural mutation regression
 *
 * Verifies:
 *  - Inbound StoreSync `topicSegments/replaceSegmentsForTopic` (meta.fromSync) invalidates
 *    only the affected topic's resident claim and advances generation, leaving unrelated
 *    resident topics untouched.
 *  - Every unpaired local structural segment mutation family invalidates the
 *    originating window's resident claim via centralized rootReducer, not only
 *    via hooks/thunks. Metadata-only updateSegment is exempt.
 *  - Local joint follow-up `replaceSegmentsForTopic` with meta.isJointFollowUp does NOT
 *    invalidate originating, while inbound copy (fromSync) still does.
 */
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { bumpGeneration, publishResidentComplete } from '@renderer/store/residentRegistry'
import {
  addSegment,
  clearSegmentsForTopic,
  loadSegments,
  removeSegment,
  replaceSegmentsForTopic,
  updateSegment
} from '@renderer/store/topicSegment'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it } from 'vitest'

function makeWindowResponse(topicId: string, messages: Array<{ id: string }>): FetchMessagesWindowResponse {
  const returnedCount = messages.length
  const firstMessageId = returnedCount > 0 ? messages[0].id : null
  const lastMessageId = returnedCount > 0 ? messages[returnedCount - 1].id : null
  return {
    messages: messages as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: { limit: 10 },
      firstMessageId,
      lastMessageId,
      returnedCount,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as unknown as FetchMessagesWindowResponse
}

function makeSegment(id: string, topicId: string, messageIds: string[] = ['m1']): any {
  return {
    id,
    topicId,
    name: 'Seg',
    messageIds,
    color: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

describe('resident segment invalidation — centralized LOCK-302', () => {
  let store: ReturnType<typeof configureStore>

  beforeEach(() => {
    store = configureStore({ reducer: rootReducer })
  })

  function establishResident(topicId: string, genSeed?: number) {
    store.dispatch(bumpGeneration(topicId))
    if (genSeed !== undefined) {
      // already bumped once; if need higher, bump again
      while ((store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration < genSeed) {
        store.dispatch(bumpGeneration(topicId))
      }
    }
    const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration as number
    const wr = makeWindowResponse(topicId, [{ id: `m-${topicId}` }])
    const seg = makeSegment(`seg-${topicId}`, topicId)
    store.dispatch(publishResidentComplete({ topicId, generation: gen, windowResponse: wr, segments: [seg] }))
    return gen
  }

  it('inbound StoreSync replaceSegmentsForTopic invalidates only affected resident and advances generation', () => {
    const genA = establishResident('t-a')
    const genB = establishResident('t-b')
    expect((store.getState() as any).residentRegistry.entries['t-a'].residentTopic).toBe(true)
    expect((store.getState() as any).residentRegistry.entries['t-b'].residentTopic).toBe(true)
    expect(genA).toBe(1)
    expect(genB).toBe(1)

    // inbound fromSync standalone replacement for t-a only
    const inboundSeg = makeSegment('seg-a-inbound', 't-a', ['m-a-2'])
    store.dispatch({
      ...replaceSegmentsForTopic({ topicId: 't-a', segments: [inboundSeg] }),
      meta: { fromSync: true }
    } as any)

    const entryA = (store.getState() as any).residentRegistry.entries['t-a']
    const entryB = (store.getState() as any).residentRegistry.entries['t-b']
    expect(entryA.residentTopic).toBe(false)
    expect(entryA.chatData).toBe(false)
    expect(entryA.segments).toBe(true)
    expect(entryA.applicabilityGeneration).toBe(2)
    // t-b unchanged — per-topic isolation
    expect(entryB.residentTopic).toBe(true)
    expect(entryB.applicabilityGeneration).toBe(1)
    // projection updated for t-a
    expect((store.getState() as any).topicSegments.segmentsByTopic['t-a']).toEqual(['seg-a-inbound'])
    expect((store.getState() as any).topicSegments.segmentsByTopic['t-b']).toEqual(['seg-t-b'])
  })

  it('local joint follow-up replaceSegmentsForTopic does NOT invalidate originating, inbound does', () => {
    const gen = establishResident('t-joint')
    expect((store.getState() as any).residentRegistry.entries['t-joint'].residentTopic).toBe(true)

    // local joint follow-up (originating window) — must not invalidate
    const jointSeg = makeSegment('seg-joint-follow', 't-joint')
    const localFollow = {
      ...replaceSegmentsForTopic({ topicId: 't-joint', segments: [jointSeg] }),
      meta: { isJointFollowUp: true }
    } as any
    store.dispatch(localFollow)
    let entry = (store.getState() as any).residentRegistry.entries['t-joint']
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(gen) // still 1

    // inbound copy of same segments (fromSync) — must invalidate receiving window
    // Simulate receiving window state: reset to resident true at gen 1, then receive inbound
    // For simplicity, use same store as receiving window after re-establishing
    // Bump to simulate receiving window had resident at gen 1
    // Already at gen 1 resident true, now inbound
    const inboundJointSeg = makeSegment('seg-joint-inbound', 't-joint')
    store.dispatch({
      ...replaceSegmentsForTopic({ topicId: 't-joint', segments: [inboundJointSeg] }),
      meta: { fromSync: true, isJointFollowUp: true } // inbound carries both, but fromSync takes precedence
    } as any)
    entry = (store.getState() as any).residentRegistry.entries['t-joint']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(2)
  })

  // ---- Local structural mutation families ----

  it('local addSegment (useTopicSegments.createSegment path) invalidates resident', () => {
    const gen = establishResident('t-add')
    const seg = makeSegment('seg-add-1', 't-add')
    store.dispatch(addSegment(seg))
    const entry = (store.getState() as any).residentRegistry.entries['t-add']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(gen + 1)
  })

  it('local removeSegment (useTopicSegments.deleteSegment path) invalidates resident', () => {
    establishResident('t-remove')
    // ensure segment exists to be removed
    const seg = makeSegment('seg-remove-1', 't-remove')
    store.dispatch(addSegment(seg))
    // need to re-establish resident after add invalidated it
    // bump and republish to get back to resident true at new gen
    const gen2 = (store.getState() as any).residentRegistry.entries['t-remove'].applicabilityGeneration as number
    const wr = makeWindowResponse('t-remove', [{ id: 'm-t-remove' }])
    store.dispatch(
      publishResidentComplete({ topicId: 't-remove', generation: gen2, windowResponse: wr, segments: [seg] })
    )
    expect((store.getState() as any).residentRegistry.entries['t-remove'].residentTopic).toBe(true)
    const beforeGen = (store.getState() as any).residentRegistry.entries['t-remove'].applicabilityGeneration as number
    store.dispatch(removeSegment('seg-remove-1'))
    const entry = (store.getState() as any).residentRegistry.entries['t-remove']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeGen + 1)
  })

  it('local updateSegment with messageIds (useTopicSegments.updateSegmentMessageIds path) invalidates, metadata-only does not', () => {
    establishResident('t-update')
    const seg = makeSegment('seg-update-1', 't-update', ['m1'])
    store.dispatch(addSegment(seg))
    // re-establish after add
    const gen2 = (store.getState() as any).residentRegistry.entries['t-update'].applicabilityGeneration as number
    const wr = makeWindowResponse('t-update', [{ id: 'm-t-update' }])
    store.dispatch(
      publishResidentComplete({ topicId: 't-update', generation: gen2, windowResponse: wr, segments: [seg] })
    )
    const beforeGen = (store.getState() as any).residentRegistry.entries['t-update'].applicabilityGeneration as number
    // structural: messageIds change
    store.dispatch(
      updateSegment({ id: 'seg-update-1', changes: { messageIds: ['m2'], updatedAt: new Date().toISOString() } })
    )
    let entry = (store.getState() as any).residentRegistry.entries['t-update']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeGen + 1)

    // re-establish again
    const gen3 = entry.applicabilityGeneration as number
    const wr2 = makeWindowResponse('t-update', [{ id: 'm-t-update' }])
    store.dispatch(
      publishResidentComplete({
        topicId: 't-update',
        generation: gen3,
        windowResponse: wr2,
        segments: [{ ...seg, messageIds: ['m2'] }]
      })
    )
    const beforeGen2 = (store.getState() as any).residentRegistry.entries['t-update'].applicabilityGeneration as number
    // metadata-only: name change should NOT invalidate (classification: non-structural)
    store.dispatch(
      updateSegment({ id: 'seg-update-1', changes: { name: 'NewName', updatedAt: new Date().toISOString() } })
    )
    entry = (store.getState() as any).residentRegistry.entries['t-update']
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(beforeGen2) // unchanged
  })

  it('local loadSegments and clearSegmentsForTopic invalidate resident', () => {
    const gen = establishResident('t-load')
    const seg = makeSegment('seg-load-1', 't-load')
    // loadSegments path (direct dispatch)
    store.dispatch(loadSegments([seg]))
    let entry = (store.getState() as any).residentRegistry.entries['t-load']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(gen + 1)

    // re-establish
    const gen2 = entry.applicabilityGeneration as number
    const wr = makeWindowResponse('t-load', [{ id: 'm-t-load' }])
    store.dispatch(
      publishResidentComplete({ topicId: 't-load', generation: gen2, windowResponse: wr, segments: [seg] })
    )
    const beforeGen = (store.getState() as any).residentRegistry.entries['t-load'].applicabilityGeneration as number
    store.dispatch(clearSegmentsForTopic('t-load'))
    entry = (store.getState() as any).residentRegistry.entries['t-load']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeGen + 1)
  })

  it('local standalone replaceSegmentsForTopic invalidates immediately in same dispatch', () => {
    // standalone replace must invalidate atomically in same root dispatch, single bump, no observable resident true
    const gen = establishResident('t-replace')
    const seg = makeSegment('seg-replace-new', 't-replace')
    store.dispatch(replaceSegmentsForTopic({ topicId: 't-replace', segments: [seg] }) as any)
    const entry = (store.getState() as any).residentRegistry.entries['t-replace']
    expect(entry.residentTopic).toBe(false)
    expect(entry.chatData).toBe(false)
    expect(entry.segments).toBe(true)
    expect(entry.applicabilityGeneration).toBe(gen + 1)
    // projection updated
    expect((store.getState() as any).topicSegments.segmentsByTopic['t-replace']).toEqual(['seg-replace-new'])
  })

  it('narrow exemption: only local paired replaceSegmentsForTopic with isJointFollowUp retains residency; other structural actions with isJointFollowUp still invalidate', () => {
    // addSegment with isJointFollowUp must still invalidate (not exempt)
    const genAdd = establishResident('t-exempt-add')
    const segAdd = makeSegment('seg-exempt-add', 't-exempt-add')
    store.dispatch({ ...addSegment(segAdd), meta: { isJointFollowUp: true } } as any)
    let entry = (store.getState() as any).residentRegistry.entries['t-exempt-add']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(genAdd + 1)

    // removeSegment with isJointFollowUp must still invalidate
    establishResident('t-exempt-remove')
    const segRem = makeSegment('seg-exempt-rem', 't-exempt-remove')
    store.dispatch(addSegment(segRem) as any)
    // re-establish after add
    const genRemove2 = (store.getState() as any).residentRegistry.entries['t-exempt-remove'].applicabilityGeneration
    const wrRem = makeWindowResponse('t-exempt-remove', [{ id: 'm-t-exempt-remove' }])
    store.dispatch(
      publishResidentComplete({
        topicId: 't-exempt-remove',
        generation: genRemove2,
        windowResponse: wrRem,
        segments: [segRem]
      })
    )
    const beforeRemove = (store.getState() as any).residentRegistry.entries['t-exempt-remove'].applicabilityGeneration
    store.dispatch({ ...removeSegment('seg-exempt-rem'), meta: { isJointFollowUp: true } } as any)
    entry = (store.getState() as any).residentRegistry.entries['t-exempt-remove']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeRemove + 1)

    // updateSegment structural (messageIds) with isJointFollowUp must still invalidate
    establishResident('t-exempt-update')
    const segUp = makeSegment('seg-exempt-up', 't-exempt-update', ['m1'])
    store.dispatch(addSegment(segUp) as any)
    const genUpdate2 = (store.getState() as any).residentRegistry.entries['t-exempt-update'].applicabilityGeneration
    const wrUp = makeWindowResponse('t-exempt-update', [{ id: 'm-t-exempt-update' }])
    store.dispatch(
      publishResidentComplete({
        topicId: 't-exempt-update',
        generation: genUpdate2,
        windowResponse: wrUp,
        segments: [segUp]
      })
    )
    const beforeUpdate = (store.getState() as any).residentRegistry.entries['t-exempt-update'].applicabilityGeneration
    store.dispatch({
      ...updateSegment({ id: 'seg-exempt-up', changes: { messageIds: ['m2'] } }),
      meta: { isJointFollowUp: true }
    } as any)
    entry = (store.getState() as any).residentRegistry.entries['t-exempt-update']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeUpdate + 1)

    // metadata-only updateSegment with isJointFollowUp must remain exempt (non-structural)
    const genMeta = (store.getState() as any).residentRegistry.entries['t-exempt-update'].applicabilityGeneration
    const wrMeta = makeWindowResponse('t-exempt-update', [{ id: 'm-t-exempt-update' }])
    store.dispatch(
      publishResidentComplete({
        topicId: 't-exempt-update',
        generation: genMeta,
        windowResponse: wrMeta,
        segments: [{ ...segUp, messageIds: ['m2'] }]
      })
    )
    const beforeMeta = (store.getState() as any).residentRegistry.entries['t-exempt-update'].applicabilityGeneration
    store.dispatch({
      ...updateSegment({ id: 'seg-exempt-up', changes: { name: 'NewName' } }),
      meta: { isJointFollowUp: true }
    } as any)
    entry = (store.getState() as any).residentRegistry.entries['t-exempt-update']
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(beforeMeta)

    // loadSegments with isJointFollowUp must still invalidate
    establishResident('t-exempt-load')
    const segLoad = makeSegment('seg-exempt-load', 't-exempt-load')
    const beforeLoad = (store.getState() as any).residentRegistry.entries['t-exempt-load'].applicabilityGeneration
    store.dispatch({ ...loadSegments([segLoad]), meta: { isJointFollowUp: true } } as any)
    entry = (store.getState() as any).residentRegistry.entries['t-exempt-load']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeLoad + 1)

    // clearSegmentsForTopic with isJointFollowUp must still invalidate
    establishResident('t-exempt-clear')
    const beforeClear = (store.getState() as any).residentRegistry.entries['t-exempt-clear'].applicabilityGeneration
    store.dispatch({ ...clearSegmentsForTopic('t-exempt-clear'), meta: { isJointFollowUp: true } } as any)
    entry = (store.getState() as any).residentRegistry.entries['t-exempt-clear']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeClear + 1)

    // replaceSegmentsForTopic inbound with isJointFollowUp must still invalidate (fromSync precedence)
    establishResident('t-exempt-inbound-joint')
    const segInbound = makeSegment('seg-exempt-inbound', 't-exempt-inbound-joint')
    const beforeInbound = (store.getState() as any).residentRegistry.entries['t-exempt-inbound-joint']
      .applicabilityGeneration
    store.dispatch({
      ...replaceSegmentsForTopic({ topicId: 't-exempt-inbound-joint', segments: [segInbound] }),
      meta: { fromSync: true, isJointFollowUp: true }
    } as any)
    entry = (store.getState() as any).residentRegistry.entries['t-exempt-inbound-joint']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeInbound + 1)
  })

  it('inbound structural mutations via StoreSync (add/remove/update) invalidate receiving window', () => {
    const gen = establishResident('t-inbound-struct')
    // prepare segment for removal
    const seg = makeSegment('seg-inbound-struct-1', 't-inbound-struct')
    // need to have segment present before inbound remove; add via local then re-establish
    store.dispatch(addSegment(seg))
    const gen2 = (store.getState() as any).residentRegistry.entries['t-inbound-struct']
      .applicabilityGeneration as number
    const wr = makeWindowResponse('t-inbound-struct', [{ id: 'm-t-inbound-struct' }])
    store.dispatch(
      publishResidentComplete({ topicId: 't-inbound-struct', generation: gen2, windowResponse: wr, segments: [seg] })
    )
    const beforeGen = (store.getState() as any).residentRegistry.entries['t-inbound-struct']
      .applicabilityGeneration as number
    // inbound addSegment for another topic should not affect this one? Test per-topic
    // inbound removeSegment for this topic
    store.dispatch({ ...removeSegment('seg-inbound-struct-1'), meta: { fromSync: true } } as any)
    let entry = (store.getState() as any).residentRegistry.entries['t-inbound-struct']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeGen + 1)

    // re-establish for update test
    const seg2 = makeSegment('seg-inbound-update-1', 't-inbound-struct', ['m1'])
    store.dispatch(addSegment(seg2) as any)
    // need to handle that add had fromSync? Actually inbound add would also invalidate, but we did local add above which already invalidated, need to reset
    // For update test, re-establish resident
    const gen3 = (store.getState() as any).residentRegistry.entries['t-inbound-struct']
      .applicabilityGeneration as number
    const wr2 = makeWindowResponse('t-inbound-struct', [{ id: 'm-t-inbound-struct' }])
    store.dispatch(
      publishResidentComplete({ topicId: 't-inbound-struct', generation: gen3, windowResponse: wr2, segments: [seg2] })
    )
    const beforeGen2 = (store.getState() as any).residentRegistry.entries['t-inbound-struct']
      .applicabilityGeneration as number
    store.dispatch({
      ...updateSegment({ id: 'seg-inbound-update-1', changes: { messageIds: ['m2'] } }),
      meta: { fromSync: true }
    } as any)
    entry = (store.getState() as any).residentRegistry.entries['t-inbound-struct']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeGen2 + 1)

    void gen
  })

  it('segment-message deletion operation paths (syncSegmentsAfterMessageDeletion style) via remove/update invalidate', () => {
    const gen = establishResident('t-del-op')
    const seg = makeSegment('seg-del-1', 't-del-op', ['m1', 'm2'])
    store.dispatch(addSegment(seg))
    const gen2 = (store.getState() as any).residentRegistry.entries['t-del-op'].applicabilityGeneration as number
    const wr = makeWindowResponse('t-del-op', [{ id: 'm-t-del-op' }])
    store.dispatch(
      publishResidentComplete({ topicId: 't-del-op', generation: gen2, windowResponse: wr, segments: [seg] })
    )
    const beforeGen = (store.getState() as any).residentRegistry.entries['t-del-op'].applicabilityGeneration as number
    // Simulate syncSegmentsAfterMessageDeletion: remove when empty, update when partial
    // Here we simulate update to remove one messageId
    store.dispatch(
      updateSegment({ id: 'seg-del-1', changes: { messageIds: ['m1'], updatedAt: new Date().toISOString() } })
    )
    let entry = (store.getState() as any).residentRegistry.entries['t-del-op']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeGen + 1)

    // re-establish
    const gen3 = entry.applicabilityGeneration as number
    const wr2 = makeWindowResponse('t-del-op', [{ id: 'm-t-del-op' }])
    store.dispatch(
      publishResidentComplete({
        topicId: 't-del-op',
        generation: gen3,
        windowResponse: wr2,
        segments: [{ ...seg, messageIds: ['m1'] }]
      })
    )
    const beforeGen2 = (store.getState() as any).residentRegistry.entries['t-del-op'].applicabilityGeneration as number
    store.dispatch(removeSegment('seg-del-1'))
    entry = (store.getState() as any).residentRegistry.entries['t-del-op']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeGen2 + 1)

    void gen
  })
})
