import type { ContextWindowAnchor } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildGroupList,
  ensureTopicAnchorEstablished,
  inheritAnchorForBranch,
  resolveGroupKey,
  transferAnchorOnDeletion,
  transferAnchorsAfterDeletion
} from '../anchorService'

const updateAssistantSettings = vi.fn()
const selectMessagesForTopic = vi.fn()
const getAssistantSettings = vi.fn()

vi.mock('@renderer/store/assistants', () => ({
  updateAssistantSettings: (...args: unknown[]) => updateAssistantSettings(...args)
}))

vi.mock('@renderer/store/newMessage', () => ({
  selectMessagesForTopic: (...args: unknown[]) => selectMessagesForTopic(...args)
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (...args: unknown[]) => getAssistantSettings(...args)
}))

beforeEach(() => {
  updateAssistantSettings.mockReset()
  selectMessagesForTopic.mockReset()
  getAssistantSettings.mockReset()
})

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

// --- transferAnchorOnDeletion ---

describe('transferAnchorOnDeletion', () => {
  const g = (key: string): ContextWindowAnchor => ({ kind: 'active', groupKey: key })

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

// --- transferAnchorsAfterDeletion (contextWindowAnchor field) ---

describe('transferAnchorsAfterDeletion', () => {
  const g = (key: string): ContextWindowAnchor => ({ kind: 'active', groupKey: key })
  const topicId = 'topic-1'

  const makeGetState = (settings: { contextWindowAnchor?: Record<string, ContextWindowAnchor | undefined> }) => () =>
    ({
      assistants: {
        assistants: [{ id: 'asst-1', settings }]
      }
    }) as any

  it('reads and rewrites the contextWindowAnchor field', () => {
    const getState = makeGetState({
      contextWindowAnchor: { [topicId]: g('u3') }
    })
    const dispatch = vi.fn()

    // Delete u3 (anchor group): old [u1,u2,u3,u4] → new [u1,u2,u4] → transfer to u2.
    transferAnchorsAfterDeletion(dispatch, getState, topicId, ['u1', 'u2', 'u3', 'u4'], ['u1', 'u2', 'u4'])

    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: {
        contextWindowAnchor: { [topicId]: g('u2') }
      }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('removes the topic key when the anchor resolves to undefined', () => {
    const getState = makeGetState({
      contextWindowAnchor: { [topicId]: g('u1'), otherTopic: g('u9') }
    })
    const dispatch = vi.fn()

    // All groups deleted → anchor becomes undefined → key removed.
    transferAnchorsAfterDeletion(dispatch, getState, topicId, ['u1'], [])

    expect(updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: {
        contextWindowAnchor: { otherTopic: g('u9') }
      }
    })
  })

  it('skips assistants without an active anchor for the topic', () => {
    const getState = makeGetState({})
    const dispatch = vi.fn()

    transferAnchorsAfterDeletion(dispatch, getState, topicId, ['u1', 'u2'], ['u1'])

    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
})

// --- inheritAnchorForBranch (branch anchor inheritance) ---

describe('inheritAnchorForBranch', () => {
  const g = (key: string): ContextWindowAnchor => ({ kind: 'active', groupKey: key })

  it('maps an in-range parent anchor into the branch by index', () => {
    // Parent anchor u2 (index 2); branch has >= 3 groups → branch u2' by index.
    const source = ['u0', 'u1', 'u2', 'u3']
    const branch = ['b0', 'b1', 'b2', 'b3']
    expect(inheritAnchorForBranch(g('u2'), source, branch)).toEqual(g('b2'))
  })

  it('clamps an out-of-range parent position to the branch LAST group (nearest predecessor)', () => {
    // Parent anchor u2 (index 2); branch is a strict prefix (only 1 group).
    // Index 2 >= branch length → clamp to branchGroupList[last] = b0.
    const source = ['u0', 'u1', 'u2', 'u3']
    const branch = ['b0']
    expect(inheritAnchorForBranch(g('u2'), source, branch)).toEqual(g('b0'))
  })

  it('clamps an out-of-range parent position to the branch last group (multi-group prefix)', () => {
    // Parent anchor u4 (index 4); branch has 2 groups → clamp to last (b1).
    const source = ['u0', 'u1', 'u2', 'u3', 'u4']
    const branch = ['b0', 'b1']
    expect(inheritAnchorForBranch(g('u4'), source, branch)).toEqual(g('b1'))
  })

  it('returns undefined when the source anchor is missing', () => {
    expect(inheritAnchorForBranch(undefined, ['u0', 'u1'], ['b0', 'b1'])).toBeUndefined()
  })

  it('returns undefined when the source anchor is invalid (non-active)', () => {
    const invalid = { kind: 'vacant' } as unknown as ContextWindowAnchor
    expect(inheritAnchorForBranch(invalid, ['u0', 'u1'], ['b0', 'b1'])).toBeUndefined()
  })

  it('returns undefined when the source anchor groupKey is absent from the source list', () => {
    const source = ['u0', 'u1']
    const branch = ['b0', 'b1']
    expect(inheritAnchorForBranch(g('ghost'), source, branch)).toBeUndefined()
  })

  it('returns undefined for an empty branch (empty topics have no anchor)', () => {
    const source = ['u0', 'u1', 'u2']
    expect(inheritAnchorForBranch(g('u1'), source, [])).toBeUndefined()
  })

  it('never recomputes from contextCount — pure index transfer', () => {
    // Same source anchor and branch regardless of any default-position math:
    // index 1 → branch group 1 even when a default computation would differ.
    const source = ['u0', 'u1', 'u2', 'u3', 'u4', 'u5']
    const branch = ['b0', 'b1', 'b2']
    expect(inheritAnchorForBranch(g('u1'), source, branch)).toEqual(g('b1'))
  })
})

// --- ensureTopicAnchorEstablished (first establishment / compatibility repair glue) ---

describe('ensureTopicAnchorEstablished', () => {
  const g = (key: string): ContextWindowAnchor => ({ kind: 'active', groupKey: key })
  const topicId = 'topic-1'

  const makeGetState = (settings: { contextWindowAnchor?: Record<string, ContextWindowAnchor | undefined> }) => () =>
    ({
      assistants: {
        assistants: [{ id: 'asst-1', settings }]
      }
    }) as any

  beforeEach(() => {
    getAssistantSettings.mockImplementation((assistant: { settings: { contextWindowAnchor?: unknown } }) => ({
      contextCount: 2,
      contextWindowAnchor: assistant.settings?.contextWindowAnchor ?? {}
    }))
  })

  it('establishes the default-derived anchor for a non-empty topic with no anchor', () => {
    // Turns: u1/u2/u3 (user-led). contextCount=2 → default position is u2.
    selectMessagesForTopic.mockReturnValue([
      user('u1'),
      assistant('a1', 'u1'),
      user('u2'),
      assistant('a2', 'u2'),
      user('u3')
    ])
    const getState = makeGetState({})
    const dispatch = vi.fn()

    ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: {
        contextWindowAnchor: { [topicId]: g('u2') }
      }
    })
  })

  it('never recalculates a valid persisted anchor (idempotent no-op)', () => {
    selectMessagesForTopic.mockReturnValue([user('u1'), assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2')])
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('u1') } })
    const dispatch = vi.fn()

    ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('repairs an unresolvable legacy anchor exactly once', () => {
    selectMessagesForTopic.mockReturnValue([user('u1'), assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2')])
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('ghost') } })
    const dispatch = vi.fn()

    ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: {
        contextWindowAnchor: { [topicId]: g('u1') }
      }
    })
  })

  it('empty topic never receives an anchor (no dispatch)', () => {
    selectMessagesForTopic.mockReturnValue([])
    const getState = makeGetState({})
    const dispatch = vi.fn()

    ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('unknown assistant id is a silent no-op', () => {
    const getState = makeGetState({})
    const dispatch = vi.fn()

    ensureTopicAnchorEstablished(dispatch, getState, 'missing-assistant', topicId)

    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
})
