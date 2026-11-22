/**
 * Integration-level real reducer/root-store test for Phase 4 resident lifecycle
 *
 * Proves:
 *  - single joint publication dispatch updates blocks/messages/segments/window-completeness/registry together
 *  - stale generation action changes none of them (atomic discard via rootReducer + per-slice guards)
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { selectWindowBoundary } from '@renderer/store/__tests__/helpers/windowCompleteness'
import messageBlocksReducer from '@renderer/store/messageBlock'
import newMessagesReducer from '@renderer/store/newMessage'
import residentRegistryReducer, {
  bumpGeneration,
  JOINT_PUBLISH_COMPLETE,
  publishResidentComplete,
  shouldDiscardJointPublish
} from '@renderer/store/residentRegistry'
import topicSegmentReducer from '@renderer/store/topicSegment'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'
import { describe, expect, it } from 'vitest'

function makeWindowResponse(
  topicId: string,
  messages: Array<{ id: string }>,
  windowOverrides: Partial<{ kind: 'latest' | 'around'; hasMoreBefore: boolean; hasMoreAfter: boolean }> = {}
): FetchMessagesWindowResponse {
  const returnedCount = messages.length
  const firstMessageId = returnedCount > 0 ? messages[0].id : null
  const lastMessageId = returnedCount > 0 ? messages[returnedCount - 1].id : null
  const kind = windowOverrides.kind ?? 'latest'
  return {
    messages: messages as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [
      { id: 'b-1', messageId: messages[0]?.id ?? 'm-0', type: 'main_text', content: 'hi' }
    ] as unknown as FetchMessagesWindowResponse['blocks'],
    window: {
      kind,
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: kind === 'latest' ? { limit: 10 } : { before: 5, after: 5 },
      firstMessageId,
      lastMessageId,
      returnedCount,
      hasMoreBefore: windowOverrides.hasMoreBefore ?? true,
      hasMoreAfter: windowOverrides.hasMoreAfter ?? false
    }
  } as unknown as FetchMessagesWindowResponse
}

// production guarded publication — exercises the same shouldDiscardJointPublish
// helper used by the real store/index.ts rootReducer, without duplicating the guard
const appReducer = combineReducers({
  messages: newMessagesReducer,
  messageBlocks: messageBlocksReducer,
  topicSegments: topicSegmentReducer,
  residentRegistry: residentRegistryReducer
})
// production guarded publication — exercises the same shouldDiscardJointPublish
// helper used by the real store/index.ts rootReducer, without duplicating the
// guard. The window-boundary metadata is written by the resident-registry slice
// reducer itself (same publication), so nothing outside appReducer touches it.
const rootReducer: typeof appReducer = (state, action: any) => {
  if (action?.type === JOINT_PUBLISH_COMPLETE) {
    if (shouldDiscardJointPublish(state, action.payload)) {
      return state as any
    }
  }
  return appReducer(state, action)
}

describe('resident lifecycle integration — real reducers', () => {
  it('single joint publication dispatch updates blocks/messages/segments/window-completeness/registry together and stale generation changes none', () => {
    const store = configureStore({ reducer: rootReducer })

    // bump generation for t-int to 1
    store.dispatch(bumpGeneration('t-int'))
    const gen = (store.getState() as any).residentRegistry.entries['t-int'].applicabilityGeneration as number
    expect(gen).toBe(1)
    expect(selectWindowBoundary('t-int', store)).toBeUndefined()

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
    expect(selectWindowBoundary('t-int', store)).toEqual({ hasMoreBefore: true, hasMoreAfter: false })
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
    const beforeCompleteness = selectWindowBoundary('t-int', store)

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
    expect(selectWindowBoundary('t-int', store)).toEqual(beforeCompleteness)
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
    // empty but loaded: the published window boundary is retained (not a
    // whole-topic claim — hasMoreBefore/After are the Main-declared window
    // flags), while a never-published topic reads as missing (undefined)
    expect(selectWindowBoundary('t-empty', store)).toEqual({ hasMoreBefore: true, hasMoreAfter: false })
    expect(selectWindowBoundary('t-never-published', store)).toBeUndefined()
  })

  it('parallel topic publications keep their own boundaries; around windows write the same boundary shape', () => {
    const store = configureStore({ reducer: rootReducer })
    store.dispatch(bumpGeneration('t-a'))
    store.dispatch(bumpGeneration('t-b'))
    const genA = (store.getState() as any).residentRegistry.entries['t-a'].applicabilityGeneration as number
    const genB = (store.getState() as any).residentRegistry.entries['t-b'].applicabilityGeneration as number
    store.dispatch(
      publishResidentComplete({
        topicId: 't-a',
        generation: genA,
        windowResponse: makeWindowResponse('t-a', [{ id: 'm-a' }], { hasMoreBefore: true, hasMoreAfter: false }),
        segments: []
      })
    )
    store.dispatch(
      publishResidentComplete({
        topicId: 't-b',
        generation: genB,
        windowResponse: makeWindowResponse('t-b', [{ id: 'm-b' }], {
          kind: 'around',
          hasMoreBefore: false,
          hasMoreAfter: true
        }),
        segments: []
      })
    )
    // each topic reads exactly the boundary its own publication carried — no cross-write
    expect(selectWindowBoundary('t-a', store)).toEqual({ hasMoreBefore: true, hasMoreAfter: false })
    expect(selectWindowBoundary('t-b', store)).toEqual({ hasMoreBefore: false, hasMoreAfter: true })
  })
})
