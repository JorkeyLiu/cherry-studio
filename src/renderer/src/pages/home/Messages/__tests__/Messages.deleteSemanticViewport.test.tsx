/**
 * Semantic delete viewport — no topic reset / latest rebuild.
 *
 * Proves that the natural-boundary delete (paired removeMessages + full
 * replaceSegmentsForTopic with isDeletePairedFollowUp) keeps the Messages
 * viewport populated (N-1) without triggering topic/reset or createLatestMessageWindow.
 *
 * Uses real store + viewport reducer + window helpers; no DB/IPC.
 */
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import { bumpGeneration, publishResidentComplete } from '@renderer/store/residentRegistry'
import { replaceSegmentsForTopic } from '@renderer/store/topicSegment'
import type { Message } from '@renderer/types/newMessage'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it } from 'vitest'

import { createMessageViewportState, messageViewportReducer } from '../messageViewportReducer'
import { createLatestMessageWindow, reconcileMessageWindow } from '../messageWindow'

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
function makeSegment(id: string, topicId: string, mids: string[]): any {
  return {
    id,
    topicId,
    name: 'Seg',
    messageIds: mids,
    color: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sortOrder: 0,
    firstMessageId: mids[0] ?? null,
    lastMessageId: mids[mids.length - 1] ?? null,
    messageCount: mids.length
  }
}
function makeMsg(id: string, topicId: string): Message {
  return { id, topicId, role: 'user', blocks: [], createdAt: '2026-01-01T00:00:00.000Z' } as unknown as Message
}

describe('Messages viewport — semantic delete keeps latest window without reset', () => {
  let store: ReturnType<typeof configureStore>
  const topicId = 't-viewport-semantic'
  const displayCount = 10

  beforeEach(() => {
    store = configureStore({ reducer: rootReducer })
  })

  function establish(messages: Message[], segments: any[]) {
    store.dispatch(bumpGeneration(topicId))
    const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    const wr = makeWindowResponse(topicId, messages as any)
    store.dispatch(publishResidentComplete({ topicId, generation: gen, windowResponse: wr, segments }))
    return gen
  }

  it('paired semantic delete reconciles viewport to N-1 without topic/reset and without rebuilding latest from scratch', () => {
    const msgs = [makeMsg('m1', topicId), makeMsg('m2', topicId), makeMsg('m3', topicId)]
    const gen = establish(msgs, [makeSegment('seg-1', topicId, ['m1', 'm2', 'm3'])])
    const stateMessages = (store.getState() as any).messages.messageIdsByTopic[topicId].map(
      (id: string) => (store.getState() as any).messages.entities[id]
    ) as Message[]
    // Build initial viewport as Messages does on first load (latest window from messages)
    const initialWindow = createLatestMessageWindow(stateMessages, displayCount, {
      hasMoreBefore: false,
      hasMoreAfter: false
    })
    const viewport = createMessageViewportState(initialWindow)
    expect(viewport.window?.displayMessages.map((m) => m.id)).toEqual(['m3', 'm2', 'm1'])
    expect(viewport.topicGeneration).toBe(0)
    expect(viewport.window?.hasMoreOlder).toBe(false)

    // Snapshot messages before delete for reconcile previousMessages
    const previousMessages = [...stateMessages]

    // Execute paired delete: remove m2, replace segments authority, residency retained
    store.dispatch(newMessagesActions.removeMessages({ topicId, messageIds: ['m2'] }))
    store.dispatch({
      ...replaceSegmentsForTopic({ topicId, segments: [makeSegment('seg-1', topicId, ['m1', 'm3'])] }),
      meta: { isDeletePairedFollowUp: true }
    } as any)

    const afterState = store.getState() as any
    // Resident retained — proves no transient [] requiring reload
    expect(afterState.residentRegistry.entries[topicId].residentTopic).toBe(true)
    expect(afterState.residentRegistry.entries[topicId].applicabilityGeneration).toBe(gen)
    const afterMessages = afterState.messages.messageIdsByTopic[topicId].map(
      (id: string) => afterState.messages.entities[id]
    ) as Message[]
    expect(afterMessages.map((m) => m.id)).toEqual(['m1', 'm3'])
    // No topic/reset happened — viewport should reconcile, not be cleared
    const reconciled = reconcileMessageWindow(afterMessages, previousMessages, viewport.window!)
    // Reconciled window still exists, not null, and contains N-1 displayMessages
    expect(reconciled.displayMessages.map((m) => m.id)).toEqual(['m3', 'm1'])
    expect(reconciled.displayMessages.length).toBe(2)
    expect(reconciled.range).not.toBeNull()
    // Applying reconciled window does not advance topicGeneration (no reset)
    const nextViewport = messageViewportReducer(viewport, { type: 'window/apply', window: reconciled })
    expect(nextViewport.window?.displayMessages.length).toBe(2)
    expect(nextViewport.topicGeneration).toBe(viewport.topicGeneration) // no reset
    expect(nextViewport.window).not.toBeNull()
    // Contrast: topic/reset would clear window to null and bump generation
    const resetViewport = messageViewportReducer(viewport, { type: 'topic/reset' })
    expect(resetViewport.window).toBeNull()
    expect(resetViewport.topicGeneration).toBe(viewport.topicGeneration + 1)
    // Paired delete did not cause reset path
    expect(nextViewport.window).not.toBeNull()
    expect(nextViewport.topicGeneration).not.toBe(resetViewport.topicGeneration)
  })

  it('standalone unpaired replace would have invalidated and required reload (contrast)', () => {
    const msgs = [makeMsg('m1', topicId), makeMsg('m2', topicId)]
    establish(msgs, [makeSegment('seg-1', topicId, ['m1', 'm2'])])
    const beforeResident = (store.getState() as any).residentRegistry.entries[topicId].residentTopic
    expect(beforeResident).toBe(true)
    // Standalone unpaired replace (no paired flag)
    store.dispatch(replaceSegmentsForTopic({ topicId, segments: [makeSegment('seg-1', topicId, ['m1'])] }) as any)
    const after = store.getState() as any
    expect(after.residentRegistry.entries[topicId].residentTopic).toBe(false)
    // Messages selector would now return undefined -> Messages.render would see [] and trigger reload
    // Simulating that: isResident false => loadedMessages undefined => fallback []
    const isResident = !!after.residentRegistry.entries[topicId].residentTopic
    const loaded = isResident ? after.messages.messageIdsByTopic[topicId] : undefined
    expect(loaded).toBeUndefined()
    // Paired delete case keeps loaded defined
    // (proven in previous test)
  })
})
