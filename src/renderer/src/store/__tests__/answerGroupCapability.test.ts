/**
 * BRANCH-4/9/12 renderer group capability (pure helpers, no DOM).
 *
 * - Answer groups resolve from the loaded projection (assistant members plus
 *   the loaded user root for shape) and require EVERY loaded ASSISTANT member
 *   owned through the active route. Reading the loaded user root never
 *   blocks (BRANCH-12 actual-write-target). Unknown groups, unknown
 *   capability, route mismatch, or one non-owned loaded member fail closed.
 * - Edit selections resolve selectedGroupIds through the current loaded
 *   groups; only fully owned selections are writable (every resolved message
 *   is an actual delete/segment target). Copy stays
 *   unrestricted (no gate here by design).
 */
import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import {
  requireEditSelectionMutable,
  resolveEditSelectionMessageIds,
  selectIsEditSelectionMutable
} from '../editSelection'
import {
  isLoadedAnswerGroupMutable,
  loadedAnswerMemberIds,
  requireAnswerGroupForMember,
  requireLoadedAnswerMembersMutable,
  resolveLoadedAnswerGroup
} from '../routeAnswerGroup'

function userMsg(id: string): Message {
  return { id, topicId: 't1', role: 'user' } as unknown as Message
}

function assistantMsg(id: string, askId: string): Message {
  return { id, topicId: 't1', role: 'assistant', askId } as unknown as Message
}

function rootState(opts: {
  loadedIds: string[]
  entities: Record<string, Message>
  mutableIds?: string[]
  mutableRoute?: string | null
  activeRoute?: string | null
  selectedGroupIds?: string[]
}) {
  const { loadedIds, entities, mutableIds, mutableRoute, activeRoute = null, selectedGroupIds = [] } = opts
  return {
    messages: {
      entities,
      messageIdsByTopic: { t1: loadedIds },
      mutableMessageIdsByTopic: mutableIds === undefined ? {} : { t1: mutableIds },
      mutableRouteByTopic: mutableRoute === undefined ? {} : { t1: mutableRoute }
    },
    topicBranch: {
      activeBranchIdByTopic: activeRoute === null ? {} : { t1: activeRoute }
    },
    editMode: { selectedGroupIds },
    residentRegistry: { entries: { t1: { residentTopic: true } } }
  } as never
}

describe('resolveLoadedAnswerGroup', () => {
  it('resolves members plus the loaded user root', () => {
    const state = rootState({
      loadedIds: ['u1', 'a1', 'a2'],
      entities: { u1: userMsg('u1'), a1: assistantMsg('a1', 'u1'), a2: assistantMsg('a2', 'u1') }
    })
    const group = resolveLoadedAnswerGroup(state, 't1', 'a1')
    expect(group).not.toBeNull()
    expect(group?.askId).toBe('u1')
    expect(group?.memberIds).toEqual(['a1', 'a2'])
    expect(group?.userRootId).toBe('u1')
    expect(group?.allIds).toEqual(['u1', 'a1', 'a2'])
  })

  it('resolves from the user root id and tolerates a window-outside root', () => {
    const fromRoot = rootState({
      loadedIds: ['u1', 'a1'],
      entities: { u1: userMsg('u1'), a1: assistantMsg('a1', 'u1') }
    })
    expect(resolveLoadedAnswerGroup(fromRoot, 't1', 'u1')?.memberIds).toEqual(['a1'])
    const rootOutside = rootState({
      loadedIds: ['a1', 'a2'],
      entities: { a1: assistantMsg('a1', 'u1'), a2: assistantMsg('a2', 'u1') }
    })
    const group = resolveLoadedAnswerGroup(rootOutside, 't1', 'a1')
    expect(group?.userRootId).toBeNull()
    expect(group?.allIds).toEqual(['a1', 'a2'])
  })

  it('returns null for unknown ids and group-less messages', () => {
    const state = rootState({ loadedIds: ['u1'], entities: { u1: userMsg('u1') } })
    expect(resolveLoadedAnswerGroup(state, 't1', 'missing')).toBeNull()
    // A lone user root with no loaded answers is not an actionable group.
    expect(resolveLoadedAnswerGroup(state, 't1', 'u1')).toBeNull()
  })
})

describe('answer-group mutability', () => {
  const entities = { u1: userMsg('u1'), a1: assistantMsg('a1', 'u1'), a2: assistantMsg('a2', 'u1') }

  it('owned loaded groups are mutable', () => {
    const state = rootState({
      loadedIds: ['u1', 'a1', 'a2'],
      entities,
      mutableIds: ['u1', 'a1', 'a2'],
      mutableRoute: null
    })
    const group = resolveLoadedAnswerGroup(state, 't1', 'a1')!
    expect(isLoadedAnswerGroupMutable(state, 't1', group)).toBe(true)
    expect(() => requireAnswerGroupForMember(state, 't1', 'a1')).not.toThrow()
  })

  it('one non-owned loaded member fails the whole group closed; the user root never gates (BRANCH-12)', () => {
    // Non-owned answer member.
    const nonOwnedMember = rootState({
      loadedIds: ['u1', 'a1', 'a2'],
      entities,
      mutableIds: ['u1', 'a1'],
      mutableRoute: null
    })
    const group = resolveLoadedAnswerGroup(nonOwnedMember, 't1', 'a1')!
    expect(isLoadedAnswerGroupMutable(nonOwnedMember, 't1', group)).toBe(false)
    expect(() => requireAnswerGroupForMember(nonOwnedMember, 't1', 'a1')).toThrow()
    // The selected ID itself is owned — the precheck is group-level, not selected-ID-only.
    expect(() => requireAnswerGroupForMember(nonOwnedMember, 't1', 'a2')).toThrow()
    // Non-owned (or capability-absent) user root never blocks: only actually-
    // written assistant members gate the UI. Window-outside members stay
    // Main-decided.
    const unreadableRoot = rootState({
      loadedIds: ['u1', 'a1', 'a2'],
      entities,
      mutableIds: ['a1', 'a2'],
      mutableRoute: null
    })
    const rootGroup = resolveLoadedAnswerGroup(unreadableRoot, 't1', 'a1')!
    expect(isLoadedAnswerGroupMutable(unreadableRoot, 't1', rootGroup)).toBe(true)
    expect(() => requireAnswerGroupForMember(unreadableRoot, 't1', 'a1')).not.toThrow()
  })

  it('unknown capability and route mismatch fail closed', () => {
    const unknown = rootState({ loadedIds: ['u1', 'a1'], entities })
    expect(() => requireAnswerGroupForMember(unknown, 't1', 'a1')).toThrow()
    const mismatch = rootState({
      loadedIds: ['u1', 'a1'],
      entities,
      mutableIds: ['u1', 'a1'],
      mutableRoute: null,
      activeRoute: 'b1'
    })
    expect(() => requireAnswerGroupForMember(mismatch, 't1', 'a1')).toThrow()
  })

  it('batch member precheck is vacuous when nothing is loaded and strict otherwise', () => {
    const empty = rootState({
      loadedIds: ['u1'],
      entities: { u1: userMsg('u1') },
      mutableIds: ['u1'],
      mutableRoute: null
    })
    expect(loadedAnswerMemberIds(empty, 't1', 'u1')).toEqual([])
    expect(() => requireLoadedAnswerMembersMutable(empty, 't1', 'u1')).not.toThrow()
    const strict = rootState({
      loadedIds: ['u1', 'a1', 'a2'],
      entities,
      mutableIds: ['u1', 'a1'],
      mutableRoute: null
    })
    expect(() => requireLoadedAnswerMembersMutable(strict, 't1', 'u1')).toThrow()
  })
})

describe('edit-selection mutability', () => {
  const entities = {
    u1: userMsg('u1'),
    a1: assistantMsg('a1', 'u1'),
    u2: userMsg('u2'),
    a2: assistantMsg('a2', 'u2')
  }

  it('fully owned selections are writable', () => {
    const state = rootState({
      loadedIds: ['u1', 'a1', 'u2', 'a2'],
      entities,
      mutableIds: ['u1', 'a1', 'u2', 'a2'],
      mutableRoute: null,
      selectedGroupIds: ['u1', 'u2']
    })
    expect(resolveEditSelectionMessageIds(state, 't1', ['u1', 'u2'])).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(selectIsEditSelectionMutable(state, 't1')).toBe(true)
    expect(requireEditSelectionMutable(state, 't1')).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('one non-owned member blocks the whole mixed selection', () => {
    const state = rootState({
      loadedIds: ['u1', 'a1', 'u2', 'a2'],
      entities,
      mutableIds: ['u1', 'a1', 'u2'],
      mutableRoute: null,
      selectedGroupIds: ['u1', 'u2']
    })
    expect(selectIsEditSelectionMutable(state, 't1')).toBe(false)
    expect(() => requireEditSelectionMutable(state, 't1')).toThrow()
  })

  it('unknown groups, empty selections, and route mismatch fail closed', () => {
    const base = {
      loadedIds: ['u1', 'a1'],
      entities: { u1: userMsg('u1'), a1: assistantMsg('a1', 'u1') },
      mutableIds: ['u1', 'a1'],
      mutableRoute: null as string | null
    }
    // Stale/unknown selection id.
    expect(selectIsEditSelectionMutable(rootState({ ...base, selectedGroupIds: ['ghost'] }), 't1')).toBe(false)
    // Empty selection never writes.
    expect(selectIsEditSelectionMutable(rootState({ ...base, selectedGroupIds: [] }), 't1')).toBe(false)
    // Route-switch residue: capability belongs to another route.
    expect(
      selectIsEditSelectionMutable(rootState({ ...base, selectedGroupIds: ['u1'], activeRoute: 'b1' }), 't1')
    ).toBe(false)
    // Unknown capability.
    const { mutableIds: _drop, ...rest } = base
    void _drop
    expect(
      selectIsEditSelectionMutable(rootState({ ...rest, mutableIds: undefined, selectedGroupIds: ['u1'] }), 't1')
    ).toBe(false)
  })
})
