/**
 * Integration-level real reducer/root-store test for Phase 4 resident lifecycle
 *
 * Proves:
 *  - single joint publication dispatch updates blocks/messages/segments/window-completeness/registry together
 *  - stale generation action changes none of them (atomic discard via rootReducer + per-slice guards)
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import {
  clearLatestWindowCompleteness,
  getLatestWindowCompleteness,
  setLatestWindowCompleteness
} from '@renderer/pages/home/Messages/messageWindow'
import messageBlocksReducer from '@renderer/store/messageBlock'
import newMessagesReducer from '@renderer/store/newMessage'
import residentRegistryReducer, {
  bumpGeneration,
  JOINT_PUBLISH_COMPLETE,
  publishResidentComplete
} from '@renderer/store/residentRegistry'
import topicSegmentReducer from '@renderer/store/topicSegment'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it } from 'vitest'

function makeWindowResponse(topicId: string, messages: Array<{ id: string }>): FetchMessagesWindowResponse {
  const returnedCount = messages.length
  const firstMessageId = returnedCount > 0 ? messages[0].id : null
  const lastMessageId = returnedCount > 0 ? messages[returnedCount - 1].id : null
  return {
    messages: messages as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [
      { id: 'b-1', messageId: messages[0]?.id ?? 'm-0', type: 'main_text', content: 'hi' }
    ] as unknown as FetchMessagesWindowResponse['blocks'],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: { limit: 10 },
      firstMessageId,
      lastMessageId,
      returnedCount,
      hasMoreBefore: true,
      hasMoreAfter: false
    }
  } as unknown as FetchMessagesWindowResponse
}

// replicate rootReducer stale-generation guard from store/index.ts
const appReducer = combineReducers({
  messages: newMessagesReducer,
  messageBlocks: messageBlocksReducer,
  topicSegments: topicSegmentReducer,
  residentRegistry: residentRegistryReducer
})
const rootReducer: typeof appReducer = (state, action: any) => {
  if (action?.type === JOINT_PUBLISH_COMPLETE) {
    const payload = action.payload as { topicId: string; generation: number; windowResponse: any }
    const topicId: string | undefined = payload?.topicId
    const generation: number | undefined = payload?.generation
    const windowResponse = payload?.windowResponse
    const entry = (state as any)?.residentRegistry?.entries?.[topicId]
    const currentGen: number | undefined = entry?.applicabilityGeneration
    if (
      typeof topicId !== 'string' ||
      typeof generation !== 'number' ||
      entry === undefined ||
      currentGen !== generation
    ) {
      return state as any
    }
    try {
      if (windowResponse?.window) {
        setLatestWindowCompleteness(topicId, {
          hasMoreBefore: !!windowResponse.window.hasMoreBefore,
          hasMoreAfter: !!windowResponse.window.hasMoreAfter
        })
      }
    } catch {}
  }
  return appReducer(state, action)
}

describe('resident lifecycle integration — real reducers', () => {
  beforeEach(() => {
    clearLatestWindowCompleteness('t-int')
    clearLatestWindowCompleteness('t-stale')
  })

  it('single joint publication dispatch updates blocks/messages/segments/window-completeness/registry together and stale generation changes none', () => {
    const store = configureStore({ reducer: rootReducer })

    // bump generation for t-int to 1
    store.dispatch(bumpGeneration('t-int'))
    const gen = (store.getState() as any).residentRegistry.entries['t-int'].applicabilityGeneration as number
    expect(gen).toBe(1)
    expect(getLatestWindowCompleteness('t-int')).toBeUndefined()

    const windowResponse = makeWindowResponse('t-int', [{ id: 'm-int-1' }, { id: 'm-int-2' }])
    const segments = [
      {
        id: 'seg-int-1',
        topicId: 't-int',
        name: 'Seg',
        messageIds: ['m-int-1'],
        color: undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ] as any[]

    // single dispatch
    store.dispatch(publishResidentComplete({ topicId: 't-int', generation: gen, windowResponse, segments }))

    const state = store.getState() as any
    // messages
    expect(state.messages.messageIdsByTopic['t-int']).toEqual(['m-int-1', 'm-int-2'])
    expect(state.messages.entities['m-int-1']).toBeDefined()
    // blocks
    expect(state.messageBlocks.entities['b-1']).toBeDefined()
    // segments
    expect(state.topicSegments.segmentsByTopic['t-int']).toEqual(['seg-int-1'])
    expect(state.topicSegments.segments.entities['seg-int-1']).toBeDefined()
    // window completeness (via rootReducer side effect)
    expect(getLatestWindowCompleteness('t-int')).toEqual({ hasMoreBefore: true, hasMoreAfter: false })
    // registry
    const entry = state.residentRegistry.entries['t-int']
    expect(entry.chatData).toBe(true)
    expect(entry.segments).toBe(true)
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(1)

    // stale generation action must change none of them
    const staleGen = 999
    const staleWindowResponse = makeWindowResponse('t-int', [{ id: 'm-stale' }])
    const staleSegments = [
      {
        id: 'seg-stale',
        topicId: 't-int',
        name: 'Stale',
        messageIds: [],
        color: undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ] as any[]
    const beforeState = structuredClone(state)
    const beforeCompleteness = getLatestWindowCompleteness('t-int')

    store.dispatch(
      publishResidentComplete({
        topicId: 't-int',
        generation: staleGen,
        windowResponse: staleWindowResponse,
        segments: staleSegments
      })
    )

    const after = store.getState() as any
    expect(after.messages.messageIdsByTopic['t-int']).toEqual(beforeState.messages.messageIdsByTopic['t-int'])
    expect(after.messages.entities['m-stale']).toBeUndefined()
    expect(after.messageBlocks.entities['b-1']).toEqual(beforeState.messageBlocks.entities['b-1'])
    expect(after.topicSegments.segmentsByTopic['t-int']).toEqual(beforeState.topicSegments.segmentsByTopic['t-int'])
    expect(after.topicSegments.segments.entities['seg-stale']).toBeUndefined()
    expect(getLatestWindowCompleteness('t-int')).toEqual(beforeCompleteness)
    expect(after.residentRegistry.entries['t-int']).toEqual(beforeState.residentRegistry.entries['t-int'])
  })

  it('empty complete topic joint publication is a valid resident hit for cache', () => {
    const store = configureStore({ reducer: rootReducer })
    store.dispatch(bumpGeneration('t-empty'))
    const gen = (store.getState() as any).residentRegistry.entries['t-empty'].applicabilityGeneration as number
    const windowResponse = makeWindowResponse('t-empty', [])
    // blocks empty for empty topic
    windowResponse.blocks = [] as any
    windowResponse.window.returnedCount = 0
    windowResponse.window.firstMessageId = null
    windowResponse.window.lastMessageId = null
    const segments: any[] = []
    store.dispatch(publishResidentComplete({ topicId: 't-empty', generation: gen, windowResponse, segments }))
    const state = store.getState() as any
    expect(state.messages.messageIdsByTopic['t-empty']).toEqual([])
    expect(state.messages.messageIdsByTopic['t-empty'] !== undefined).toBe(true)
    expect(state.residentRegistry.entries['t-empty'].residentTopic).toBe(true)
    expect(state.residentRegistry.entries['t-empty'].chatData).toBe(true)
    expect(state.residentRegistry.entries['t-empty'].segments).toBe(true)
  })
})
