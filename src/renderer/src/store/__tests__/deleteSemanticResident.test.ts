/**
 * Natural-boundary semantic delete — resident projection preservation.
 *
 * Verifies the paired delete dispatches (removeMessages + full replaceSegmentsForTopic)
 * are treated as a joint semantic transaction:
 *  - replaceSegmentsForTopic dispatched with meta.isDeletePairedFollowUp retains residency
 *  - loaded messages shrink N -> N-1 (not transient [] / undefined)
 *  - segments are authority-derived (full catalog consumed, not standalone stale)
 *  - ordinary standalone replaceSegmentsForTopic still invalidates (no weakening)
 *  - inbound fromSync copy still invalidates receivers
 */
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import { bumpGeneration, publishResidentComplete } from '@renderer/store/residentRegistry'
import { addSegment, replaceSegmentsForTopic } from '@renderer/store/topicSegment'
import type { Message } from '@renderer/types/newMessage'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it } from 'vitest'

function makeWindowResponse(topicId: string, messages: Array<{ id: string }>): FetchMessagesWindowResponse {
  return {
    messages: messages as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: { limit: 10 },
      firstMessageId: messages[0]?.id ?? null,
      lastMessageId: messages[messages.length - 1]?.id ?? null,
      returnedCount: messages.length,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as unknown as FetchMessagesWindowResponse
}

function makeSegment(id: string, topicId: string, messageIds: string[]): any {
  return {
    id,
    topicId,
    name: 'Seg',
    messageIds,
    color: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sortOrder: 0,
    firstMessageId: messageIds[0] ?? null,
    lastMessageId: messageIds[messageIds.length - 1] ?? null,
    messageCount: messageIds.length
  }
}

function makeMsg(id: string, topicId: string): Message {
  return {
    id,
    topicId,
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    blocks: [],
    status: 'success'
  } as unknown as Message
}

describe('semantic delete — natural boundary resident preservation', () => {
  let store: ReturnType<typeof configureStore>

  function establish(topicId: string, messageIds: string[], segments: any[]) {
    store.dispatch(bumpGeneration(topicId))
    const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    const msgs = messageIds.map((id) => makeMsg(id, topicId))
    const wr = makeWindowResponse(topicId, msgs as any)
    store.dispatch(publishResidentComplete({ topicId, generation: gen, windowResponse: wr, segments }))
    // Also populate messageIdsByTopic via publishResidentComplete extraReducer in newMessage
    // publishResidentComplete already upserts messages and ids; ensure match
    return gen
  }

  beforeEach(() => {
    store = configureStore({ reducer: rootReducer })
  })

  it('paired delete retains residency, loaded N-1, authority segments applied', () => {
    const topicId = 't-del-semantic'
    const gen = establish(topicId, ['m1', 'm2', 'm3'], [makeSegment('seg-1', topicId, ['m1', 'm2', 'm3'])])
    expect((store.getState() as any).residentRegistry.entries[topicId].residentTopic).toBe(true)
    expect((store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration).toBe(gen)
    // loaded projection before delete
    const beforeIds = (store.getState() as any).messages.messageIdsByTopic[topicId] as string[]
    expect(beforeIds).toEqual(['m1', 'm2', 'm3'])

    // Simulate executeDeleteMessagesWithDependents paired dispatches:
    // 1) removeMessages (single authority expansion, loaded intersection)
    store.dispatch(newMessagesActions.removeMessages({ topicId, messageIds: ['m2'] }))
    // 2) full authority segment catalog (topic's segments without m2)
    const authoritySegments = [makeSegment('seg-1', topicId, ['m1', 'm3'])]
    store.dispatch({
      ...replaceSegmentsForTopic({ topicId, segments: authoritySegments }),
      meta: { isDeletePairedFollowUp: true }
    } as any)

    const after = store.getState() as any
    // Resident preserved — no transient invalidation, no generation bump, no reload required
    expect(after.residentRegistry.entries[topicId].residentTopic).toBe(true)
    expect(after.residentRegistry.entries[topicId].chatData).toBe(true)
    expect(after.residentRegistry.entries[topicId].segments).toBe(true)
    expect(after.residentRegistry.entries[topicId].applicabilityGeneration).toBe(gen)
    // Loaded messages shrink N -> N-1, not [] or undefined
    expect(after.messages.messageIdsByTopic[topicId]).toEqual(['m1', 'm3'])
    expect(after.messages.messageIdsByTopic[topicId].length).toBe(2)
    expect(after.messages.messageIdsByTopic[topicId]).not.toEqual([])
    // Segments authority-derived (full catalog consumed)
    expect(after.topicSegments.segmentsByTopic[topicId]).toEqual(['seg-1'])
    const seg = after.topicSegments.segments.entities['seg-1']
    expect(seg.messageIds).toEqual(['m1', 'm3'])
    // Loaded projection remains defined (resident true) -> Messages sees N-1 not []
    const isResident = !!after.residentRegistry.entries[topicId].residentTopic
    expect(isResident).toBe(true)
    const loadedIds = isResident ? after.messages.messageIdsByTopic[topicId] : undefined
    expect(loadedIds).toEqual(['m1', 'm3'])
  })

  it('paired delete with isJointFollowUp also retains (existing mechanism compatibility)', () => {
    const topicId = 't-del-joint'
    const gen = establish(topicId, ['m1', 'm2'], [makeSegment('seg-1', topicId, ['m1', 'm2'])])
    store.dispatch(newMessagesActions.removeMessages({ topicId, messageIds: ['m1'] }))
    store.dispatch({
      ...replaceSegmentsForTopic({ topicId, segments: [makeSegment('seg-1', topicId, ['m2'])] }),
      meta: { isJointFollowUp: true }
    } as any)
    const after = store.getState() as any
    expect(after.residentRegistry.entries[topicId].residentTopic).toBe(true)
    expect(after.residentRegistry.entries[topicId].applicabilityGeneration).toBe(gen)
    expect(after.messages.messageIdsByTopic[topicId]).toEqual(['m2'])
  })

  it('ordinary standalone replaceSegmentsForTopic still invalidates (no weakening)', () => {
    const topicId = 't-standalone'
    const gen = establish(topicId, ['m1', 'm2'], [makeSegment('seg-1', topicId, ['m1', 'm2'])])
    store.dispatch(replaceSegmentsForTopic({ topicId, segments: [makeSegment('seg-1', topicId, ['m1'])] }) as any)
    const after = store.getState() as any
    expect(after.residentRegistry.entries[topicId].residentTopic).toBe(false)
    expect(after.residentRegistry.entries[topicId].chatData).toBe(false)
    expect(after.residentRegistry.entries[topicId].applicabilityGeneration).toBe(gen + 1)
    // Standalone still applies new catalog even while invalidating
    expect(after.topicSegments.segments.entities['seg-1'].messageIds).toEqual(['m1'])
  })

  it('inbound fromSync replace with identical paired flag still invalidates receiver (fromSync precedence)', () => {
    const topicId = 't-inbound'
    const gen = establish(topicId, ['m1', 'm2'], [makeSegment('seg-1', topicId, ['m1', 'm2'])])
    const segNew = makeSegment('seg-inbound', topicId, ['m1'])
    store.dispatch({
      ...replaceSegmentsForTopic({ topicId, segments: [segNew] }),
      meta: { fromSync: true, isDeletePairedFollowUp: true }
    } as any)
    const after = store.getState() as any
    expect(after.residentRegistry.entries[topicId].residentTopic).toBe(false)
    expect(after.residentRegistry.entries[topicId].applicabilityGeneration).toBe(gen + 1)
  })

  it('other structural actions with isDeletePairedFollowUp still invalidate (narrow exemption)', () => {
    const topicId = 't-narrow'
    establish(topicId, ['m1'], [makeSegment('seg-1', topicId, ['m1'])])
    const beforeGen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    // Simulate addSegment with isDeletePairedFollowUp — must still invalidate (only replace exempt)
    store.dispatch({
      ...addSegment(makeSegment('seg-2', topicId, ['m1'])),
      meta: { isDeletePairedFollowUp: true }
    } as any)
    const after = store.getState() as any
    expect(after.residentRegistry.entries[topicId].residentTopic).toBe(false)
    expect(after.residentRegistry.entries[topicId].applicabilityGeneration).toBe(beforeGen + 1)
  })

  it('identical catalog with paired flag is no-op (generation/flags unchanged)', () => {
    const topicId = 't-ident'
    const seg = makeSegment('seg-1', topicId, ['m1', 'm2'])
    const gen = establish(topicId, ['m1', 'm2'], [seg])
    const before = store.getState() as any
    const beforeEntry = before.residentRegistry.entries[topicId]
    const beforeRef = before.topicSegments.segmentsByTopic[topicId]
    // Dispatch identical catalog with delete paired flag — should be state identity no-op
    store.dispatch({
      ...replaceSegmentsForTopic({ topicId, segments: [{ ...seg }] }),
      meta: { isDeletePairedFollowUp: true }
    } as any)
    const after = store.getState() as any
    expect(after).toBe(before)
    expect(after.residentRegistry.entries[topicId]).toBe(beforeEntry)
    expect(after.topicSegments.segmentsByTopic[topicId]).toBe(beforeRef)
    expect(after.residentRegistry.entries[topicId].applicabilityGeneration).toBe(gen)
  })
})
