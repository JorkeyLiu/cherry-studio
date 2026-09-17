import {
  computeClosureFingerprint,
  getClosureLoadGeneration,
  getFreshValidatedClosure,
  getGlobalBlockGeneration,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import { closureInvalidationMiddleware } from '@renderer/store'
import { withClosureTopics } from '@renderer/store/closureOwnership'
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

function runMiddleware(action: unknown): unknown {
  const next = (a: unknown): unknown => a
  return (closureInvalidationMiddleware as any)({} as any)(next)(action)
}

describe('closureInvalidationMiddleware topic scoping (Task A)', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
  })

  it('topic A mutation clears only A; topic B cache stays hittable', () => {
    const fpA = seedFresh('topicA')
    const fpB = seedFresh('topicB')
    const genBBefore = getClosureLoadGeneration('topicB')

    runMiddleware(withClosureTopics({ type: 'messageBlocks/upsertManyBlocks', payload: [] }, 'topicA'))

    expect(getFreshValidatedClosure('topicA', 'u1', fpA)).toBeNull()
    expect(getFreshValidatedClosure('topicB', 'u1', fpB)).not.toBeNull()
    expect(getClosureLoadGeneration('topicB')).toBe(genBBefore)
  })

  it('topic B in-flight closure result is not discarded by an A mutation', () => {
    seedFresh('topicB')
    // Simulate a B fetch already in flight: capture publication guards.
    const generationAtFetch = getClosureLoadGeneration('topicB')
    const globalAtFetch = getGlobalBlockGeneration()

    runMiddleware(withClosureTopics({ type: 'messageBlocks/updateOneBlock', payload: { id: 'b1' } }, 'topicA'))

    // The hook discards staged B publication only when these advance.
    expect(getClosureLoadGeneration('topicB')).toBe(generationAtFetch)
    expect(getGlobalBlockGeneration()).toBe(globalAtFetch)
  })

  it.each([
    ['absent meta', { type: 'messageBlocks/upsertManyBlocks', payload: [] }],
    ['empty ownership', withClosureTopics({ type: 'messageBlocks/upsertManyBlocks', payload: [] }, [])],
    ['non-array ownership', { type: 'messageBlocks/upsertManyBlocks', payload: [], meta: { closureTopicIds: 'topicA' } }],
    ['blank ids only', { type: 'messageBlocks/upsertManyBlocks', payload: [], meta: { closureTopicIds: ['', 42] } }]
  ])('unknown ownership (%s) globally invalidates', (_label, action) => {
    resetAllClosureStateForTests()
    const fpA = seedFresh('topicA')
    const fpB = seedFresh('topicB')

    runMiddleware(action)

    expect(getFreshValidatedClosure('topicA', 'u1', fpA)).toBeNull()
    expect(getFreshValidatedClosure('topicB', 'u1', fpB)).toBeNull()
  })

  it('explicit multi-topic ownership invalidates each named topic only', () => {
    const fpA = seedFresh('topicA')
    const fpB = seedFresh('topicB')
    const fpC = seedFresh('topicC')

    runMiddleware(
      withClosureTopics({ type: 'messageBlocks/removeManyBlocks', payload: ['b1'] }, ['topicA', 'topicB', 'topicA'])
    )

    expect(getFreshValidatedClosure('topicA', 'u1', fpA)).toBeNull()
    expect(getFreshValidatedClosure('topicB', 'u1', fpB)).toBeNull()
    expect(getFreshValidatedClosure('topicC', 'u1', fpC)).not.toBeNull()
  })

  it('closure hydration upsert for A causes no global flush of B', () => {
    const fpA = seedFresh('topicA')
    const fpB = seedFresh('topicB')
    const globalBefore = getGlobalBlockGeneration()

    // Hydration publication path (useContextClosure): blocks for A only.
    runMiddleware(withClosureTopics({ type: 'messageBlocks/upsertManyBlocks', payload: [{ id: 'b-a' }] }, 'topicA'))

    expect(getFreshValidatedClosure('topicB', 'u1', fpB)).not.toBeNull()
    expect(getGlobalBlockGeneration()).toBe(globalBefore)
    // A was just hydrated-then-invalidated atomically; refetch repopulates it.
    const refetchedFp = seedFresh('topicA')
    expect(getFreshValidatedClosure('topicA', 'u1', refetchedFp)).not.toBeNull()
    expect(fpA).toBe(refetchedFp)
  })

  it.each([['messageBlocks/setMessageBlocksLoading', 'loading'], ['messageBlocks/setMessageBlocksError', 'boom']])(
    'loading/error marker %s never invalidates',
    (type, payload) => {
      resetAllClosureStateForTests()
      const fpA = seedFresh('topicA')
      const fpB = seedFresh('topicB')

      runMiddleware({ type, payload })
      runMiddleware(withClosureTopics({ type, payload }, 'topicA'))

      expect(getFreshValidatedClosure('topicA', 'u1', fpA)).not.toBeNull()
      expect(getFreshValidatedClosure('topicB', 'u1', fpB)).not.toBeNull()
    }
  )

  it('ownership metadata merges with (never replaces) existing meta such as fromSync', () => {
    const action = withClosureTopics(
      { type: 'messageBlocks/upsertManyBlocks', payload: [], meta: { fromSync: true } },
      'topicA'
    )
    expect((action as any).meta.fromSync).toBe(true)
    expect((action as any).meta.closureTopicIds).toEqual(['topicA'])
  })
})
