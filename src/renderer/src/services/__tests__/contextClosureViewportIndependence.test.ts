/**
 * Viewport-independent branch/main context display (focused acceptance).
 *
 * - Full-route authoritative counts/anchor/boundary are independent of the
 *   currently loaded viewport: pure latest/around/load-more read publications
 *   do not invalidate semantic context or reject it via viewport
 *   membership/fingerprint changes.
 * - UI never substitutes viewport-derived counts during an authoritative
 *   miss/pending branch switch (authority-pending, no bounded display).
 * - Genuine append/edit/delete invalidates, including outside-viewport and
 *   uncached in-flight races; route key and pinned-request isolation hold.
 */
import {
  bumpAndInvalidate,
  bumpClosureGeneration,
  bumpGlobalBlockGeneration,
  computeClosureFingerprint,
  getClosureLoadGeneration,
  getFreshValidatedClosure,
  getGlobalBlockGeneration,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import { resolveSharedContextInfo } from '@renderer/services/contextInfoService'
import { closureInvalidationMiddleware } from '@renderer/store'
import { markClosureReadOnly, withClosureTopics } from '@renderer/store/closureOwnership'
import type { Assistant } from '@renderer/types'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (assistant: {
    settings?: { contextCount?: number | null; contextWindowAnchor?: Record<string, any> }
  }) => ({
    contextCount: assistant?.settings?.contextCount === undefined ? 25 : assistant.settings.contextCount,
    contextWindowAnchor: assistant?.settings?.contextWindowAnchor ?? {}
  })
}))

function makeClosure(
  topicId: string,
  anchor: string,
  ids: string[],
  counts: { total: number; selected: number }
): FetchContextClosureResponse {
  const messages = ids.map((id) => ({
    id,
    role: id.startsWith('u') ? 'user' : 'assistant',
    topicId,
    blocks: [],
    ...(id.startsWith('a') ? { askId: ids[0] } : {})
  }))
  return {
    messages: messages as any,
    blocks: [],
    closure: {
      completeness: 'context-closure' as const,
      topicId,
      anchorGroupKey: anchor,
      firstMessageId: ids[0],
      lastMessageId: ids[ids.length - 1],
      returnedCount: ids.length,
      totalTurnCount: counts.total,
      selectedTurnCount: counts.selected,
      boundaryMessageId: counts.selected === counts.total ? null : ids[0]
    }
  } as any
}

function runMiddleware(action: unknown): unknown {
  const next = (a: unknown): unknown => a
  return (closureInvalidationMiddleware as any)({} as any)(next)(action)
}

function assistantWithAnchor(routeKey: string, groupKey: string | null): Assistant {
  return {
    id: 'asst-1',
    settings: {
      contextCount: 5,
      contextWindowAnchor: groupKey ? { [routeKey]: { kind: 'active', groupKey } } : {}
    }
  } as unknown as Assistant
}

describe('viewport-independent context display', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
    vi.clearAllMocks()
  })

  it('retains closure across read-only viewport hydrations and fingerprint membership changes', () => {
    const topicId = 't-viewport'
    const anchor = 'u1'
    const closure = makeClosure(topicId, anchor, ['u1', 'a1', 'u2', 'a2'], { total: 10, selected: 7 })
    const seedFp = computeClosureFingerprint([
      { id: 'u2', role: 'user', blocks: [] },
      { id: 'a2', role: 'assistant', askId: 'u2', blocks: [] }
    ] as any)
    setCachedContextClosureWithFingerprint(topicId, closure, seedFp)

    // Load-more growth changes the viewport fingerprint/shape.
    const grownFp = computeClosureFingerprint([
      { id: 'u1', role: 'user', blocks: [] },
      { id: 'a1', role: 'assistant', askId: 'u1', blocks: [] },
      { id: 'u2', role: 'user', blocks: [] },
      { id: 'a2', role: 'assistant', askId: 'u2', blocks: [] }
    ] as any)
    expect(grownFp).not.toBe(seedFp)
    const retained = getFreshValidatedClosure(topicId, anchor, grownFp)
    expect(retained).not.toBeNull()
    expect(retained?.closure.selectedTurnCount).toBe(7)
    expect(retained?.closure.totalTurnCount).toBe(10)

    // Pure read publications never invalidate: rebase / window-merged /
    // read-only block hydration / joint lifecycle all retain.
    runMiddleware({ type: 'newMessages/rebaseRouteMessages', payload: { topicId, messages: [] } })
    expect(getFreshValidatedClosure(topicId, anchor, grownFp)).not.toBeNull()
    runMiddleware({ type: 'newMessages/messagesWindowMerged', payload: { topicId, messages: [] } })
    expect(getFreshValidatedClosure(topicId, anchor, grownFp)).not.toBeNull()
    runMiddleware({ type: 'newMessages/messagesReceived', payload: { topicId, messages: [] } })
    expect(getFreshValidatedClosure(topicId, anchor, grownFp)).not.toBeNull()
    runMiddleware({ type: 'newMessages/setTopicLoading', payload: { topicId, loading: true } })
    expect(getFreshValidatedClosure(topicId, anchor, grownFp)).not.toBeNull()
    runMiddleware(
      markClosureReadOnly(
        withClosureTopics({ type: 'messageBlocks/upsertManyBlocks', payload: [{ id: 'b-win' }] }, topicId)
      )
    )
    expect(getFreshValidatedClosure(topicId, anchor, grownFp)).not.toBeNull()
  })

  it('genuine mutations invalidate, including outside-viewport and uncached races', () => {
    const topicId = 't-mutate'
    const anchor = 'u1'
    const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', blocks: [] }] as any)
    setCachedContextClosureWithFingerprint(
      topicId,
      makeClosure(topicId, anchor, ['u1', 'a1'], { total: 4, selected: 3 }),
      fp
    )
    expect(getFreshValidatedClosure(topicId, anchor, fp)).not.toBeNull()

    // Genuine message mutation invalidates (safe default, no read-only marker).
    runMiddleware({ type: 'newMessages/addMessage', payload: { topicId, message: { id: 'u9' } } })
    expect(getFreshValidatedClosure(topicId, anchor, fp)).toBeNull()

    // Outside-viewport same-length mutation invalidates via generation even
    // when the viewport fingerprint is unchanged.
    resetAllClosureStateForTests()
    setCachedContextClosureWithFingerprint(
      topicId,
      makeClosure(topicId, anchor, ['u1', 'a1'], { total: 4, selected: 3 }),
      fp
    )
    expect(getFreshValidatedClosure(topicId, anchor, fp)).not.toBeNull()
    bumpClosureGeneration(topicId)
    expect(getFreshValidatedClosure(topicId, anchor, fp)).toBeNull()

    // Uncached in-flight race: a mutation during fetch discards publication.
    resetAllClosureStateForTests()
    const genAtFetch = getClosureLoadGeneration(topicId)
    const globalAtFetch = getGlobalBlockGeneration()
    bumpAndInvalidate(topicId)
    expect(getClosureLoadGeneration(topicId)).not.toBe(genAtFetch)
    void globalAtFetch

    // Global block epoch race (covers uncached topics with active fetches).
    resetAllClosureStateForTests()
    const globalBefore = getGlobalBlockGeneration()
    bumpGlobalBlockGeneration()
    expect(getGlobalBlockGeneration()).not.toBe(globalBefore)
  })

  it('pending branch switch shows no bounded display; authoritative result is shared', () => {
    const topicId = 't-branch'
    const branchId = 'b1'
    const routeKey = `${topicId}:${branchId}`
    const assistant = assistantWithAnchor(routeKey, 'u5')
    // No fresh closure yet for the persisted anchor -> authority-pending.
    const pending = resolveSharedContextInfo([], assistant, topicId, null, branchId)
    expect(pending.isAuthoritativePending).toBe(true)
    expect(pending.anchorGroupKey).toBe('u5')
    expect(pending.boundaryMessageId).toBeNull()
    expect(pending.uiMessages).toEqual([])
    // Pending counts are explicitly non-viewport (never the bounded 1/2 etc.).
    expect(pending.contextCount).toEqual({ current: 0, max: null })

    // Once the authoritative closure arrives, TokenCount/anchor/boundary share
    // the same full-route result.
    const closure = makeClosure(topicId, 'u5', ['u5', 'a5', 'u6', 'a6'], { total: 12, selected: 4 })
    const ready = resolveSharedContextInfo([], assistant, topicId, closure, branchId)
    expect(ready.isAuthoritativePending).toBe(false)
    expect(ready.anchorGroupKey).toBe('u5')
    expect(ready.boundaryMessageId).toBe('u5')
    expect(ready.contextCount).toEqual({ current: 4, max: 12 })
  })

  it('empty/no-anchor routes keep the legitimate fallback (not pending)', () => {
    const assistant = assistantWithAnchor('t-empty', null)
    const empty = resolveSharedContextInfo([], assistant, 't-empty', null, null)
    expect(empty.isAuthoritativePending).toBe(false)
    expect(empty.anchorGroupKey).toBeNull()
    expect(empty.boundaryMessageId).toBeNull()
    expect(empty.contextCount).toEqual({ current: 0, max: 0 })
  })

  it('route key and pinned-request isolation: no cross-route leak', () => {
    const topicId = 't-iso'
    const mainFp = computeClosureFingerprint([{ id: 'u1', role: 'user', blocks: [] }] as any)
    const branchFp = computeClosureFingerprint([{ id: 'ub', role: 'user', blocks: [] }] as any)
    setCachedContextClosureWithFingerprint(
      topicId,
      makeClosure(topicId, 'u1', ['u1', 'a1'], { total: 8, selected: 8 }),
      mainFp,
      null
    )
    setCachedContextClosureWithFingerprint(
      topicId,
      makeClosure(topicId, 'ub', ['ub', 'ab'], { total: 3, selected: 2 }),
      branchFp,
      'b1'
    )
    // Each route reads only its own closure.
    expect(getFreshValidatedClosure(topicId, 'u1', mainFp, null)?.closure.totalTurnCount).toBe(8)
    expect(getFreshValidatedClosure(topicId, 'ub', branchFp, 'b1')?.closure.totalTurnCount).toBe(3)
    expect(getFreshValidatedClosure(topicId, 'u1', mainFp, 'b1')).toBeNull()
    expect(getFreshValidatedClosure(topicId, 'ub', branchFp, null)).toBeNull()
    // Pinned request route wins even if the active route moved: the request
    // resolves the captured route's closure, never the latest active.
    const pinnedRoute = 'b1'
    const pinned = getFreshValidatedClosure(topicId, 'ub', undefined, pinnedRoute)
    expect(pinned?.closure.anchorGroupKey).toBe('ub')

    // Mutating one route never leaks into the other route's closure.
    bumpAndInvalidate(topicId, 'b1')
    expect(getFreshValidatedClosure(topicId, 'ub', branchFp, 'b1')).toBeNull()
    expect(getFreshValidatedClosure(topicId, 'u1', mainFp, null)).not.toBeNull()
  })
})
