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
 *   (fail-closed); pending carries no block snapshot (derivation default
 *   empty Map), never the ordinary store.
 */
import { configureStore } from '@reduxjs/toolkit'
import {
  bindClosureReadReceipt,
  captureClosureReadReceipt,
  getClosureReadReceipt
} from '@renderer/services/executionOverlayReadReceipt'
import {
  getComposedOverlayBlocks,
  registerExecutionOverlay,
  resetExecutionOverlayForTests,
  routeKeyForExecutionOverlay,
  subscribeExecutionOverlay,
  tryHandoffAfterClosure
} from '@renderer/services/executionOverlayRegistry'
import messageBlocksReducer, { messageBlocksSlice } from '@renderer/store/messageBlock'
import { MessageBlockType } from '@renderer/types/newMessage'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { act, renderHook } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  closure: null as any,
  loadedByTopic: new Map<string, any[]>(),
  closureCalls: [] as unknown[][]
}))

vi.mock('@renderer/hooks/useContextClosure', () => ({
  useContextClosure: (...args: unknown[]) => {
    hoisted.closureCalls.push(args)
    return { closure: hoisted.closure, loading: false }
  }
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
    vi.clearAllMocks()
    hoisted.closure = null
    hoisted.loadedByTopic.clear()
    hoisted.closureCalls.length = 0
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

    expect(Object.keys(result.current)).toEqual(['sharedContextInfo'])
    // Bodies come from the closure snapshot: the ordinary store was never seeded.
    expect(store.getState().messageBlocks.entities['a1-block']).toBeUndefined()
    expect((result.current.sharedContextInfo.blockSnapshot.get('a1-block') as { content?: unknown })?.content).toBe(
      'closure-body'
    )
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
    expect((result.current.sharedContextInfo.blockSnapshot.get('a1-block') as { content?: unknown })?.content).toBe(
      'live-body'
    )
    expect(result.current.sharedContextInfo.tokenEstimationMessages.map((m: any) => m.id)).toEqual(['u1', 'a1'])
    expect(store.getState().messageBlocks.entities['a1-block']).toBeUndefined()
    // Non-member execution bodies never enter the snapshot.
    const overlay = getComposedOverlayBlocks(routeKey, ['u1-block'])
    expect(overlay.has('a1-block')).toBe(false)
    handle.dispose()
    unsubscribe()
  })

  it('keeps the accepted base stable across overlay version bumps with no member overlay', () => {
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
    const base = result.current.sharedContextInfo.blockSnapshot
    // Non-member execution delta: bumps the route version but composes no
    // member overlay, so the accepted base must not re-hydrate.
    const handle = registerExecutionOverlay({
      topicId: TOPIC,
      route: null,
      messageId: 'a1',
      snapshot: () => ({
        blocks: [
          { id: 'non-member-block', messageId: 'a1', type: MessageBlockType.MAIN_TEXT, content: 'live-body' } as any
        ]
      })
    })
    act(() => {
      handle.notifyDelta()
    })
    expect(result.current.sharedContextInfo.blockSnapshot).toBe(base)
    expect((result.current.sharedContextInfo.blockSnapshot.get('a1-block') as { content?: unknown })?.content).toBe(
      'closure-body'
    )
    act(() => {
      handle.dispose()
    })
    expect(result.current.sharedContextInfo.blockSnapshot).toBe(base)
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
    expect(result.current.sharedContextInfo.isAuthoritativePending).toBe(false)

    rerender({ topicId: 't-other' })
    // No stale body rides along: the new route (no anchor, no loaded blocks)
    // takes the legitimate empty-route fallback — never pending-authority,
    // never viewport counts.
    expect(result.current.sharedContextInfo.blockSnapshot.has('a1-block')).toBe(false)
    expect(result.current.sharedContextInfo.tokenEstimationMessages).toEqual([])
    expect(result.current.sharedContextInfo.isAuthoritativePending).toBe(false)
    expect(result.current.sharedContextInfo.contextCount).toEqual({ current: 0, max: 0 })
  })

  it('pending carries no snapshot: ordinary block commits never touch the shared input', () => {
    const store = makeStore()
    // Seed the ordinary store with a referenced block: pending must ignore it.
    store.dispatch(
      messageBlocksSlice.actions.upsertOneBlock({
        id: 'a1-block',
        messageId: 'a1',
        type: MessageBlockType.MAIN_TEXT,
        content: 'ordinary-body',
        status: 'success'
      } as never)
    )
    hoisted.closure = null
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
    // Authority-pending: persisted anchor, no closure — empty lists, default empty snapshot.
    expect(result.current.sharedContextInfo.isAuthoritativePending).toBe(true)
    expect(result.current.sharedContextInfo.anchorGroupKey).toBe(ANCHOR)
    expect(result.current.sharedContextInfo.uiMessages).toEqual([])
    expect(result.current.sharedContextInfo.tokenEstimationMessages).toEqual([])
    expect(result.current.sharedContextInfo.contextCount).toEqual({ current: 0, max: null })
    expect(result.current.sharedContextInfo.blockSnapshot.size).toBe(0)
    expect(result.current.sharedContextInfo.blockSnapshot.has('a1-block')).toBe(false)
    const pendingInfo = result.current.sharedContextInfo
    // Ordinary block commits (referenced or not) never touch the pending input.
    act(() => {
      store.dispatch(
        messageBlocksSlice.actions.upsertOneBlock({
          id: 'a1-block',
          messageId: 'a1',
          type: MessageBlockType.MAIN_TEXT,
          content: 'ordinary-body-updated',
          status: 'success'
        } as never)
      )
      store.dispatch(
        messageBlocksSlice.actions.upsertOneBlock({
          id: 'unrelated-block',
          messageId: 'm9',
          type: MessageBlockType.MAIN_TEXT,
          content: 'unrelated',
          status: 'success'
        } as never)
      )
    })
    expect(result.current.sharedContextInfo).toBe(pendingInfo)
    expect(result.current.sharedContextInfo.blockSnapshot.size).toBe(0)
  })

  it('retires a retained terminal via the accepted response’s own read receipt', () => {
    const store = makeStore()
    hoisted.loadedByTopic.set(TOPIC, topicMessages(TOPIC))
    const routeKey = routeKeyForExecutionOverlay(TOPIC, null)
    const unsubscribe = subscribeExecutionOverlay(routeKey, () => {})
    try {
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
      handle.recordTerminalPersisted('success')
      handle.dispose()
      // Read issued after the ack, bound to this exact response object.
      const closure = makeClosure(TOPIC, ANCHOR, 'closure-body')
      bindClosureReadReceipt(closure, captureClosureReadReceipt(TOPIC, null))
      hoisted.closure = closure

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
      // The handoff effect retired the retained terminal: the accepted
      // closure body shows, not the overlay.
      expect(getClosureReadReceipt(closure)).toBeDefined()
      expect((result.current.sharedContextInfo.blockSnapshot.get('a1-block') as { content?: unknown })?.content).toBe(
        'closure-body'
      )
    } finally {
      unsubscribe()
    }
  })

  it('retains the terminal when the accepted response carries no read receipt', () => {
    const store = makeStore()
    hoisted.loadedByTopic.set(TOPIC, topicMessages(TOPIC))
    const routeKey = routeKeyForExecutionOverlay(TOPIC, null)
    const unsubscribe = subscribeExecutionOverlay(routeKey, () => {})
    try {
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
      handle.recordTerminalPersisted('success')
      handle.dispose()
      // Pre-existing cache-style response with no receipt: fail-closed.
      hoisted.closure = makeClosure(TOPIC, ANCHOR, 'closure-body')

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
      expect(getClosureReadReceipt(hoisted.closure)).toBeUndefined()
      expect((result.current.sharedContextInfo.blockSnapshot.get('a1-block') as { content?: unknown })?.content).toBe(
        'live-body'
      )
      // Direct proof with an explicit stale witness also retains.
      expect(
        tryHandoffAfterClosure(TOPIC, null, hoisted.closure as never, {
          routeKey,
          terminals: []
        })
      ).toBe(false)
    } finally {
      unsubscribe()
    }
  })
  it('loaded-projection growth (0→many) passes no new inputs to the closure hook and retains the accepted read', () => {
    const store = makeStore()
    hoisted.closure = makeClosure(TOPIC, ANCHOR, 'closure-body')
    const { result, rerender } = renderHook(
      ({ msgs }: { msgs: any[] }) =>
        useContextPresentation({
          topicId: TOPIC,
          anchorGroupKey: ANCHOR,
          topicMessages: msgs,
          assistant
        }),
      { wrapper: wrapper(store), initialProps: { msgs: [] as any[] } }
    )
    expect(result.current.sharedContextInfo.isAuthoritativePending).toBe(false)
    const acceptedSnapshot = result.current.sharedContextInfo.blockSnapshot
    expect(hoisted.closureCalls.length).toBeGreaterThan(0)
    // Pages arrive 0→many with no identity/semantic change.
    const grown = [...topicMessages(TOPIC), ...topicMessages(TOPIC).map((m) => ({ ...m, id: `${m.id}-p2` }))] as any[]
    rerender({ msgs: grown })
    // The closure hook is entered with identity-only args on every call:
    // loaded-projection membership is never passed down as a new input.
    for (const args of hoisted.closureCalls) {
      expect(args).toEqual([TOPIC, ANCHOR, null])
    }
    // The accepted read is undisturbed: same snapshot reference, same counts.
    expect(result.current.sharedContextInfo.blockSnapshot).toBe(acceptedSnapshot)
    expect(result.current.sharedContextInfo.contextCount).toEqual({ current: 2, max: 2 })
    expect(result.current.sharedContextInfo.isAuthoritativePending).toBe(false)
    expect((result.current.sharedContextInfo.blockSnapshot.get('a1-block') as { content?: unknown })?.content).toBe(
      'closure-body'
    )
  })
})
