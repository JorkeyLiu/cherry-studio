/**
 * PROJ-13 renderer group capability (pure helpers, no DOM).
 *
 * - Answer groups resolve from the loaded projection (members + loaded user
 *   root) and require EVERY loaded member mutable through the active route.
 *   Unknown groups, unknown capability, route mismatch, or one shared loaded
 *   member fail closed.
 * - Edit selections resolve selectedGroupIds through the current loaded
 *   groups; only fully private selections are writable. Copy stays
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

  it('private loaded groups are mutable', () => {
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

  it('one shared loaded member (or root) fails the whole group closed', () => {
    // Shared answer member.
    const sharedMember = rootState({
      loadedIds: ['u1', 'a1', 'a2'],
      entities,
      mutableIds: ['u1', 'a1'],
      mutableRoute: null
    })
    const group = resolveLoadedAnswerGroup(sharedMember, 't1', 'a1')!
    expect(isLoadedAnswerGroupMutable(sharedMember, 't1', group)).toBe(false)
    expect(() => requireAnswerGroupForMember(sharedMember, 't1', 'a1')).toThrow()
    // The selected ID itself is private — the precheck is group-level, not selected-ID-only.
    expect(() => requireAnswerGroupForMember(sharedMember, 't1', 'a2')).toThrow()
    // Shared user root.
    const sharedRoot = rootState({
      loadedIds: ['u1', 'a1', 'a2'],
      entities,
      mutableIds: ['a1', 'a2'],
      mutableRoute: null
    })
    expect(() => requireAnswerGroupForMember(sharedRoot, 't1', 'a1')).toThrow()
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

  it('fully private selections are writable', () => {
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

  it('one shared member blocks the whole mixed selection', () => {
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
