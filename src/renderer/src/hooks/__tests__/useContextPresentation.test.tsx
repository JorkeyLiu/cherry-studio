/**
 * Chat-scoped context presentation (route B) smoke test.
 *
 * Real presentation hook + real store slice + real overlay registry + real
 * shared-info derivation; only the closure fetch (mocked `useContextClosure`)
 * and the loaded-message source are stubbed.
 *
 * Covered:
 * - accepted closure: bodies come from the closure snapshot, never the
 *   ordinary store (store holds no such entity); one accepted result drives
 *   the token lists;
 * - execution delta: overlay body updates the snapshot and the estimate while
 *   membership stays put;
 * - route switch: the retained projection for another topic never displays
 *   (fail-closed), pending snapshot comes from the new route's loaded blocks.
 */
import { configureStore } from '@reduxjs/toolkit'
import {
  getComposedOverlayBlocks,
  registerExecutionOverlay,
  resetExecutionOverlayForTests,
  routeKeyForExecutionOverlay,
  setExecutionOverlayGenerationReadersForTests,
  subscribeExecutionOverlay
} from '@renderer/services/executionOverlayRegistry'
import messageBlocksReducer from '@renderer/store/messageBlock'
import { MessageBlockType } from '@renderer/types/newMessage'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { act, renderHook } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  closure: null as any,
  loadedByTopic: new Map<string, any[]>()
}))

vi.mock('@renderer/hooks/useContextClosure', () => ({
  useContextClosure: () => ({ closure: hoisted.closure, loading: false })
}))

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useLoadedTopicMessages: (topicId: string) => hoisted.loadedByTopic.get(topicId) ?? []
}))

const { useContextPresentation } = await import('../useContextPresentation')

const TOPIC = 't-present'
const ANCHOR = 'u1'
const TS = '2026-01-01T00:00:00.000Z'

const assistant: any = {
  id: 'asst-1',
  name: 'asst',
  settings: { contextCount: 5, contextWindowAnchor: { [TOPIC]: { kind: 'active', groupKey: ANCHOR } } }
}

function makeClosure(topicId: string, anchor: string, body: string): FetchContextClosureResponse {
  return {
    messages: [
      { id: 'u1', role: 'user', topicId, blocks: ['u1-block'] },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId, blocks: ['a1-block'] }
    ],
    blocks: [
      { id: 'u1-block', messageId: 'u1', type: MessageBlockType.MAIN_TEXT, content: 'question', status: 'success' },
      { id: 'a1-block', messageId: 'a1', type: MessageBlockType.MAIN_TEXT, content: body, status: 'success' }
    ],
    closure: {
      completeness: 'context-closure',
      topicId,
      anchorGroupKey: anchor,
      firstMessageId: 'u1',
      lastMessageId: 'a1',
      returnedCount: 2,
      totalTurnCount: 2,
      selectedTurnCount: 2,
      foldedMessageIds: [],
      boundaryMessageId: null
    }
  } as any
}

function makeStore() {
  return configureStore({ reducer: { messageBlocks: messageBlocksReducer } })
}

function wrapper(store: ReturnType<typeof makeStore>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <Provider store={store}>{children}</Provider>
  }
}

const topicMessages = (topicId: string) => [
  { id: 'u1', role: 'user', topicId, blocks: ['u1-block'], createdAt: TS, status: 'success' },
  { id: 'a1', role: 'assistant', topicId, askId: 'u1', blocks: ['a1-block'], createdAt: TS, status: 'success' }
]

describe('useContextPresentation', () => {
  beforeEach(() => {
    resetExecutionOverlayForTests()
    setExecutionOverlayGenerationReadersForTests({
      getCachedGeneration: () => undefined,
      getLoadGeneration: () => 0
    })
    vi.clearAllMocks()
    hoisted.closure = null
    hoisted.loadedByTopic.clear()
  })

  it('drives counts and token lists from the accepted closure snapshot, not the ordinary store', () => {
    const store = makeStore()
    hoisted.closure = makeClosure(TOPIC, ANCHOR, 'closure-body')
    hoisted.loadedByTopic.set(TOPIC, topicMessages(TOPIC))

    const { result } = renderHook(
      () =>
        useContextPresentation({
          topicId: TOPIC,
          anchorGroupKey: ANCHOR,
          topicMessages: topicMessages(TOPIC) as any,
          assistant
        }),
      { wrapper: wrapper(store) }
    )

    // Bodies come from the closure snapshot: the ordinary store was never seeded.
    expect(store.getState().messageBlocks.entities['a1-block']).toBeUndefined()
    expect((result.current.blockSnapshot.get('a1-block') as { content?: unknown })?.content).toBe('closure-body')
    expect(result.current.sharedContextInfo.isAuthoritativePending).toBe(false)
    expect(result.current.sharedContextInfo.contextCount).toEqual({ current: 2, max: 2 })
    expect(result.current.sharedContextInfo.tokenEstimationMessages.map((m: any) => m.id)).toEqual(['u1', 'a1'])

    // Execution delta follows the active execution body; membership does not move.
    const routeKey = routeKeyForExecutionOverlay(TOPIC, null)
    const unsubscribe = subscribeExecutionOverlay(routeKey, () => {})
    const handle = registerExecutionOverlay({
      topicId: TOPIC,
      route: null,
      messageId: 'a1',
      snapshot: () => ({
        blocks: [{ id: 'a1-block', messageId: 'a1', type: MessageBlockType.MAIN_TEXT, content: 'live-body' } as any]
      })
    })
    act(() => {
      handle.notifyDelta()
    })
    expect((result.current.blockSnapshot.get('a1-block') as { content?: unknown })?.content).toBe('live-body')
    expect(result.current.sharedContextInfo.tokenEstimationMessages.map((m: any) => m.id)).toEqual(['u1', 'a1'])
    expect(store.getState().messageBlocks.entities['a1-block']).toBeUndefined()
    // Non-member execution bodies never enter the snapshot.
    const overlay = getComposedOverlayBlocks(routeKey, ['u1-block'])
    expect(overlay.has('a1-block')).toBe(false)
    handle.dispose()
    unsubscribe()
  })

  it('fail-closed on route switch: no retained projection for another topic', () => {
    const store = makeStore()
    hoisted.closure = makeClosure(TOPIC, ANCHOR, 'closure-body')
    hoisted.loadedByTopic.set(TOPIC, topicMessages(TOPIC))
    hoisted.loadedByTopic.set('t-other', [])

    const { result, rerender } = renderHook(
      ({ topicId }: { topicId: string }) =>
        useContextPresentation({
          topicId,
          anchorGroupKey: ANCHOR,
          topicMessages: (hoisted.loadedByTopic.get(topicId) ?? []) as any,
          assistant
        }),
      { wrapper: wrapper(store), initialProps: { topicId: TOPIC } }
    )
    expect(result.current.freshClosure).not.toBeNull()

    rerender({ topicId: 't-other' })
    expect(result.current.freshClosure).toBeNull()
    // No stale body rides along: the new route (no anchor, no loaded blocks)
    // takes the legitimate empty-route fallback — never pending-authority,
    // never viewport counts.
    expect(result.current.blockSnapshot.has('a1-block')).toBe(false)
    expect(result.current.sharedContextInfo.tokenEstimationMessages).toEqual([])
    expect(result.current.sharedContextInfo.isAuthoritativePending).toBe(false)
    expect(result.current.sharedContextInfo.contextCount).toEqual({ current: 0, max: 0 })
  })
})
