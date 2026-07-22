import type { TopicAnchor } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { buildGroupList, disableAnchor, resolveGroupKey, transferAnchorOnDeletion } from '../anchorService'

// --- Test factories ---

const user = (id: string): Message => ({ id, role: 'user' }) as unknown as Message

const assistant = (id: string, askId?: string): Message => ({ id, role: 'assistant', askId }) as unknown as Message

// --- buildGroupList ---

describe('buildGroupList', () => {
  it('returns empty array for empty messageIds', () => {
    expect(buildGroupList([], () => undefined)).toEqual([])
  })

  it('returns only user message ids in order', () => {
    const messages = new Map<string, Message>([
      ['u1', user('u1')],
      ['a1', assistant('a1', 'u1')],
      ['u2', user('u2')],
      ['a2', assistant('a2', 'u2')],
      ['u3', user('u3')]
    ])
    const ids = ['u1', 'a1', 'u2', 'a2', 'u3']
    const lookup = (id: string) => messages.get(id)
    expect(buildGroupList(ids, lookup)).toEqual(['u1', 'u2', 'u3'])
  })

  it('returns empty array when no user messages', () => {
    const messages = new Map<string, Message>([
      ['a1', assistant('a1', 'u1')],
      ['a2', assistant('a2', 'u2')]
    ])
    const ids = ['a1', 'a2']
    const lookup = (id: string) => messages.get(id)
    expect(buildGroupList(ids, lookup)).toEqual([])
  })
})

// --- resolveGroupKey ---

describe('resolveGroupKey', () => {
  it('user message returns its own id', () => {
    expect(resolveGroupKey(user('u1'))).toBe('u1')
  })

  it('assistant with askId returns askId', () => {
    expect(resolveGroupKey(assistant('a1', 'u1'))).toBe('u1')
  })

  it('assistant without askId returns null', () => {
    expect(resolveGroupKey(assistant('a1'))).toBeNull()
  })
})

// --- disableAnchor ---

describe('disableAnchor', () => {
  it('returns undefined', () => {
    expect(disableAnchor()).toBeUndefined()
  })
})

// --- transferAnchorOnDeletion ---

describe('transferAnchorOnDeletion', () => {
  const g = (key: string): TopicAnchor => ({ kind: 'active', groupKey: key })

  it('active anchor not in deletion set → unchanged', () => {
    const oldList = ['u1', 'u2', 'u3']
    const newList = ['u1', 'u2', 'u3']
    expect(transferAnchorOnDeletion(g('u1'), oldList, newList)).toEqual(g('u1'))
  })

  it('delete middle group (5→4, anchor index 2) → active(newGroupList[1])', () => {
    // old: [u0, u1, u2, u3, u4], anchor = u2 (index 2)
    // delete u2, new: [u0, u1, u3, u4]
    // newIndex = 2 - 1 = 1 → newGroupList[1] = u1
    const oldList = ['u0', 'u1', 'u2', 'u3', 'u4']
    const newList = ['u0', 'u1', 'u3', 'u4']
    expect(transferAnchorOnDeletion(g('u2'), oldList, newList)).toEqual(g('u1'))
  })

  it('delete last group (5→4, anchor index 4) → active(newGroupList[3])', () => {
    // old: [u0, u1, u2, u3, u4], anchor = u4 (index 4)
    // delete u4, new: [u0, u1, u2, u3]
    // newIndex = 4 - 1 = 3 → newGroupList[3] = u3
    const oldList = ['u0', 'u1', 'u2', 'u3', 'u4']
    const newList = ['u0', 'u1', 'u2', 'u3']
    expect(transferAnchorOnDeletion(g('u4'), oldList, newList)).toEqual(g('u3'))
  })

  it('delete first group (5→4, anchor index 0) → active(newGroupList[0])', () => {
    // old: [u0, u1, u2, u3, u4], anchor = u0 (index 0)
    // delete u0, new: [u1, u2, u3, u4]
    // newIndex = 0 - 1 = -1 < 0 → newGroupList[0] = u1
    const oldList = ['u0', 'u1', 'u2', 'u3', 'u4']
    const newList = ['u1', 'u2', 'u3', 'u4']
    expect(transferAnchorOnDeletion(g('u0'), oldList, newList)).toEqual(g('u1'))
  })

  it('delete first of two (2→1, anchor index 0) → active(newGroupList[0])', () => {
    // old: [u0, u1], anchor = u0 (index 0)
    // delete u0, new: [u1]
    // newIndex = 0 - 1 = -1 < 0 → newGroupList[0] = u1
    const oldList = ['u0', 'u1']
    const newList = ['u1']
    expect(transferAnchorOnDeletion(g('u0'), oldList, newList)).toEqual(g('u1'))
  })

  it('all deleted (newGroupList empty) → undefined', () => {
    const oldList = ['u0', 'u1', 'u2']
    const newList: string[] = []
    expect(transferAnchorOnDeletion(g('u1'), oldList, newList)).toBeUndefined()
  })

  it('oldGroupList does not contain groupKey (anomaly) → original anchor', () => {
    // groupKey "ux" never existed in oldList — impossible in practice but tests robustness
    const oldList = ['u0', 'u1', 'u2']
    const newList = ['u0', 'u1']
    expect(transferAnchorOnDeletion(g('ux'), oldList, newList)).toEqual(g('ux'))
  })
})
