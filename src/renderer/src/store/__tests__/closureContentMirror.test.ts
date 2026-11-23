import { configureStore } from '@reduxjs/toolkit'
import { selectClosureBlocksForHydration } from '@renderer/services/closureBlockHydration'
import {
  computeClosureFingerprint,
  ensureContentGeneration,
  getClosureLoadGeneration,
  getClosureSemanticToken,
  getContentGeneration,
  getFreshValidatedClosure,
  getGlobalBlockGeneration,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint,
  subscribeClosureInvalidations
} from '@renderer/services/contextClosure'
import { closureInvalidationMiddleware } from '@renderer/store'
import {
  isExemptContentMirrorAction,
  markClosureContentMirror,
  markClosureReadOnly,
  withClosureTopics
} from '@renderer/store/closureOwnership'
import messageBlocksReducer, { updateOneBlock, upsertOneBlock } from '@renderer/store/messageBlock'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it } from 'vitest'

function makeResp(topicId: string, anchor: string, ids: string[] = ['u1', 'a1']): FetchContextClosureResponse {
  const messages = ids.map((id) => ({
    id,
    role: id.startsWith('u') ? 'user' : 'assistant',
    topicId,
    ...(id.startsWith('a') ? { askId: 'u1' } : {})
  }))
  return {
    messages: messages as any,
    blocks: [],
    closure: {
      completeness: 'context-closure' as const,
      topicId,
      anchorGroupKey: anchor,
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      totalTurnCount: 1,
      selectedTurnCount: 1,
      foldedMessageIds: [],
      boundaryMessageId: null
    }
  } as any
}

function seedFresh(topicId: string, anchor = 'u1', ids: string[] = ['u1', 'a1']): string {
  const viewportMsgs = ids.map((id) => ({
    id,
    role: id.startsWith('u') ? 'user' : 'assistant',
    topicId,
    blocks: [] as string[]
  }))
  const fp = computeClosureFingerprint(viewportMsgs as any)
  setCachedContextClosureWithFingerprint(topicId, makeResp(topicId, anchor, ids), fp)
  expect(getFreshValidatedClosure(topicId, anchor, fp)).not.toBeNull()
  return fp
}

/** Trusted scheduler mirror: exactly the production `mirrorToRedux` shape. */
function trustedMirror(topicId: string, id: string, changes: Record<string, unknown>) {
  return markClosureContentMirror(withClosureTopics(updateOneBlock({ id, changes: changes as any }), topicId))
}

function makeLiveStore() {
  return configureStore({
    reducer: { messageBlocks: messageBlocksReducer },
    middleware: (getDefault) => getDefault().concat(closureInvalidationMiddleware as any)
  })
}

describe('closure streaming content-mirror exemption', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
  })

  it('repeated same-block content deltas keep structural cache fresh and the semantic token still', () => {
    const fp = seedFresh('topicA')
    const tokenBefore = getClosureSemanticToken('topicA', null)
    const genBefore = getClosureLoadGeneration('topicA')
    const globalBefore = getGlobalBlockGeneration()
    const contentBefore = getContentGeneration('topicA')
    let notifications = 0
    const unsubscribe = subscribeClosureInvalidations(() => {
      notifications += 1
    })
    try {
      // Mechanism proxy for "no IPC refetch": the hook refetch trigger is the
      // reactive semantic signal; unchanged token + no emission => no refetch.
      for (const text of ['Hello', 'Hello world', 'Hello world!']) {
        const action = trustedMirror('topicA', 'b-stream', { content: text })
        expect(isExemptContentMirrorAction(action)).toBe(true)
        ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(action)
      }
      expect(getFreshValidatedClosure('topicA', 'u1', fp)).not.toBeNull()
      expect(getClosureSemanticToken('topicA', null)).toBe(tokenBefore)
      expect(getClosureLoadGeneration('topicA')).toBe(genBefore)
      expect(getGlobalBlockGeneration()).toBe(globalBefore)
      expect(getContentGeneration('topicA')).toBeGreaterThan(contentBefore)
      expect(notifications).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  it('exempt mirrors still apply store content in real time (empty -> text)', () => {
    const store = makeLiveStore()
    store.dispatch(
      withClosureTopics(
        upsertOneBlock({ id: 'b-stream', messageId: 'a1', type: 'main_text', content: '' } as any),
        'topicA'
      ) as any
    )
    const fp = seedFresh('topicA')
    store.dispatch(trustedMirror('topicA', 'b-stream', { content: 'Hello world!' }) as any)
    const entity = (store.getState().messageBlocks as any).entities['b-stream']
    expect(entity?.content).toBe('Hello world!')
    // The live store delta is the fresh body; the cached closure stays
    // structurally fresh (counts/boundary), but its block bytes are never
    // claimed as authoritative fresh bodies.
    expect(getFreshValidatedClosure('topicA', 'u1', fp)).not.toBeNull()
    expect(getContentGeneration('topicA')).toBeGreaterThan(0)
  })

  it('unmarked or structurally meaningful block writes still invalidate', () => {
    const fp = seedFresh('topicA')
    // Same payload WITHOUT the trusted marker: fail closed to invalidation.
    ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(
      withClosureTopics(updateOneBlock({ id: 'b-stream', changes: { content: 'x' } as any }), 'topicA')
    )
    expect(getFreshValidatedClosure('topicA', 'u1', fp)).toBeNull()

    // Marker present, but terminal status: invalidates.
    const fp2 = seedFresh('topicA')
    ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(
      trustedMirror('topicA', 'b-stream', { content: 'done', status: 'success' })
    )
    expect(getFreshValidatedClosure('topicA', 'u1', fp2)).toBeNull()

    // Marker present, but error status: invalidates.
    const fp3 = seedFresh('topicA')
    ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(
      trustedMirror('topicA', 'b-stream', { status: 'error' })
    )
    expect(getFreshValidatedClosure('topicA', 'u1', fp3)).toBeNull()

    // Marker present, but a type key rides along: invalidates (type transitions never exempt).
    const fp4 = seedFresh('topicA')
    ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(
      trustedMirror('topicA', 'b-stream', { content: 'x', type: 'main_text' })
    )
    expect(getFreshValidatedClosure('topicA', 'u1', fp4)).toBeNull()

    // Marker present, but unknown key: invalidates.
    const fp5 = seedFresh('topicA')
    ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(
      trustedMirror('topicA', 'b-stream', { content: 'x', messageId: 'a1' })
    )
    expect(getFreshValidatedClosure('topicA', 'u1', fp5)).toBeNull()

    // Marker present, but empty changes: invalidates (fail closed).
    const fp6 = seedFresh('topicA')
    ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(trustedMirror('topicA', 'b-stream', {}))
    expect(getFreshValidatedClosure('topicA', 'u1', fp6)).toBeNull()
  })

  it('upsert/remove/unscoped terminal writes still invalidate even with the marker', () => {
    const fp = seedFresh('topicA')
    const markedUpsert = markClosureContentMirror(
      withClosureTopics({ type: 'messageBlocks/upsertOneBlock', payload: { id: 'b-new' } }, 'topicA')
    )
    expect(isExemptContentMirrorAction(markedUpsert)).toBe(false)
    ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(markedUpsert)
    expect(getFreshValidatedClosure('topicA', 'u1', fp)).toBeNull()

    const fp2 = seedFresh('topicA')
    const markedRemove = markClosureContentMirror(
      withClosureTopics({ type: 'messageBlocks/removeManyBlocks', payload: ['b-stream'] }, 'topicA')
    )
    expect(isExemptContentMirrorAction(markedRemove)).toBe(false)
    ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(markedRemove)
    expect(getFreshValidatedClosure('topicA', 'u1', fp2)).toBeNull()

    // Unscoped mirror (no ownership): global fallback still invalidates.
    const fpB = seedFresh('topicB')
    const fpC = seedFresh('topicC')
    const unscoped = markClosureContentMirror(updateOneBlock({ id: 'b-x', changes: { content: 'x' } as any }))
    expect(isExemptContentMirrorAction(unscoped)).toBe(false)
    ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(unscoped)
    expect(getFreshValidatedClosure('topicB', 'u1', fpB)).toBeNull()
    expect(getFreshValidatedClosure('topicC', 'u1', fpC)).toBeNull()
  })

  it('content delta during a fetch accepts structure but gap-fills bodies; structural ABA still invalidates', () => {
    const fp = seedFresh('topicA')
    ensureContentGeneration('topicA', null)
    const generationAtFetch = getClosureLoadGeneration('topicA')
    const contentAtFetch = getContentGeneration('topicA')
    const globalAtFetch = getGlobalBlockGeneration()

    // A same-block streaming delta lands during the fetch: structure stays
    // fresh, content revision moves.
    ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(
      trustedMirror('topicA', 'b-stream', { content: 'newer delta' })
    )
    // Structural acceptance is unaffected: the authoritative closure is still
    // fresh (no discard → no authority-pending).
    expect(getFreshValidatedClosure('topicA', 'u1', fp)).not.toBeNull()
    expect(getClosureLoadGeneration('topicA')).toBe(generationAtFetch)
    expect(getGlobalBlockGeneration()).toBe(globalAtFetch)
    expect(getContentGeneration('topicA')).not.toBe(contentAtFetch)

    // The content advance selects gap-fill: a live body is never overwritten,
    // a missing roster block is filled.
    const liveEntities: Record<string, unknown> = { 'b-live': { id: 'b-live', content: 'live-newest' } }
    const publication = selectClosureBlocksForHydration(
      [
        { id: 'b-live', content: 'stale-from-response' },
        { id: 'b-missing', content: 'gap-fill-me' },
        { id: 42 as unknown as string, content: 'no identity' }
      ],
      (id) => id in liveEntities,
      true
    )
    expect(publication.mode).toBe('gap-fill')
    expect(publication.blocks).toEqual([{ id: 'b-missing', content: 'gap-fill-me' }])
    // No content advance → full snapshot publication (pre-existing behavior).
    expect(
      selectClosureBlocksForHydration([{ id: 'b-live', content: 'authoritative' }], (id) => id in liveEntities, false)
        .mode
    ).toBe('full')

    // Structural ABA on the same route (invalidate then republish) still
    // moves the structural generation, so a same-route ABA cannot masquerade
    // as fresh.
    const structuralBefore = getClosureLoadGeneration('topicA')
    ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(
      withClosureTopics({ type: 'messageBlocks/upsertManyBlocks', payload: [{ id: 'b2' }] }, 'topicA')
    )
    expect(getClosureLoadGeneration('topicA')).not.toBe(structuralBefore)
    expect(getFreshValidatedClosure('topicA', 'u1', fp)).toBeNull()
  })

  it('anchor mismatch still fails closed after exempt mirrors', () => {
    const fp = seedFresh('topicA', 'u1')
    ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(
      trustedMirror('topicA', 'b-stream', { content: 'delta' })
    )
    expect(getFreshValidatedClosure('topicA', 'u1', fp)).not.toBeNull()
    // A different anchor is never served from this cache entry.
    expect(getFreshValidatedClosure('topicA', 'u2', fp)).toBeNull()
  })

  it('read-only closure hydration stays exempt without moving the content revision', () => {
    seedFresh('topicA')
    const contentBefore = getContentGeneration('topicA')
    ;(closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(
      markClosureReadOnly(
        withClosureTopics({ type: 'messageBlocks/upsertManyBlocks', payload: [{ id: 'b-h' }] }, 'topicA')
      )
    )
    expect(getContentGeneration('topicA')).toBe(contentBefore)
  })
})
