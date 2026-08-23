import type * as SqliteMessageDataSourceModule from '@renderer/services/db/SqliteMessageDataSource'
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
import * as contextTurnService from '../contextTurnService'

const { mocks: anchorMocks } = vi.hoisted(() => ({
  mocks: {
    updateAssistantSettings: vi.fn(),
    selectMessagesForTopic: vi.fn(),
    getAssistantSettings: vi.fn(),
    fetchContextClosure: vi.fn()
  }
}))
const updateAssistantSettings = anchorMocks.updateAssistantSettings
const selectMessagesForTopic = anchorMocks.selectMessagesForTopic
const getAssistantSettings = anchorMocks.getAssistantSettings
const fetchContextClosureMock = anchorMocks.fetchContextClosure
const buildContextTurnsSpy = vi.spyOn(contextTurnService, 'buildContextTurns')

vi.mock('@renderer/store/assistants', () => ({
  default: (state: unknown = {}) => state,
  updateAssistantSettings: (...args: unknown[]) => anchorMocks.updateAssistantSettings(...args),
  updateTopicUpdatedAt: (...args: unknown[]) => ({ type: 'updateTopicUpdatedAt', payload: args[0] })
}))

vi.mock('@renderer/store/newMessage', () => ({
  default: (state: unknown = {}) => state,
  selectMessagesForTopic: (...args: unknown[]) => anchorMocks.selectMessagesForTopic(...args),
  newMessagesActions: {
    messagesReceived: vi.fn(),
    setTopicLoading: vi.fn(),
    setCurrentTopicId: vi.fn(),
    addMessage: vi.fn()
  }
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (...args: unknown[]) => anchorMocks.getAssistantSettings(...args),
  getDefaultAssistant: vi.fn(() => ({ id: 'default', settings: {} }))
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchContextClosure: (...args: unknown[]) => anchorMocks.fetchContextClosure(...args)
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: vi.fn(() => ({ assistants: { assistants: [] }, messages: { entities: {}, messageIdsByTopic: {} } }))
  },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/services/db/topicMetadataPersist', () => ({
  ensureOrdinaryTopicOwnership: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: vi.fn(),
  useAssistants: vi.fn()
}))

vi.mock('@renderer/services/db/SqliteMessageDataSource', async () => {
  const actual = await vi.importActual<typeof SqliteMessageDataSourceModule>(
    '@renderer/services/db/SqliteMessageDataSource'
  )
  return { ...actual }
})

beforeEach(() => {
  updateAssistantSettings.mockReset()
  selectMessagesForTopic.mockReset()
  getAssistantSettings.mockReset()
  buildContextTurnsSpy.mockClear()
  fetchContextClosureMock.mockReset()
  // By default, authority probe fails closed only for active anchor not in viewport.
  // Ghost tests override to NOT_FOUND; valid-outside-viewport overrides to success.
  fetchContextClosureMock.mockRejectedValue(
    Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND', name: 'ChatDbResultError' })
  )
})

// --- Test factories ---

const user = (id: string): Message => ({ id, role: 'user' }) as unknown as Message

const assistant = (id: string, askId?: string): Message => ({ id, role: 'assistant', askId }) as unknown as Message

const system = (id: string): Message => ({ id, role: 'system' }) as unknown as Message

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

  it('establishes the default-derived anchor for a non-empty topic with no anchor', async () => {
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

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(buildContextTurnsSpy).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: {
        contextWindowAnchor: { [topicId]: g('u2') }
      }
    })
  })

  it('never recalculates a valid persisted anchor (idempotent no-op)', async () => {
    selectMessagesForTopic.mockReturnValue([user('u1'), assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2')])
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('u1') } })
    const dispatch = vi.fn()

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('accepts an assistant askId anchor without building context turns', async () => {
    selectMessagesForTopic.mockReturnValue([
      user('u1'),
      assistant('a1', 'u1'),
      user('u2'),
      assistant('orphan-a1', 'orphan-ask-1')
    ])
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('orphan-ask-1') } })
    const dispatch = vi.fn()

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(buildContextTurnsSpy).not.toHaveBeenCalled()
  })

  it('accepts a system message own-id anchor without building context turns', async () => {
    selectMessagesForTopic.mockReturnValue([system('system-1'), user('u1'), assistant('a1', 'u1')])
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('system-1') } })
    const dispatch = vi.fn()

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(buildContextTurnsSpy).not.toHaveBeenCalled()
  })

  it('accepts an orphan assistant own-id anchor without building context turns', async () => {
    selectMessagesForTopic.mockReturnValue([assistant('orphan-a1'), user('u1'), assistant('a1', 'u1')])
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('orphan-a1') } })
    const dispatch = vi.fn()

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(buildContextTurnsSpy).not.toHaveBeenCalled()
  })

  it('preserves user-id precedence when a key also appears as an assistant askId', async () => {
    selectMessagesForTopic.mockReturnValue([
      user('shared-key'),
      assistant('a1', 'shared-key'),
      user('u2'),
      assistant('retry-a1', 'shared-key')
    ])
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('shared-key') } })
    const dispatch = vi.fn()

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(buildContextTurnsSpy).not.toHaveBeenCalled()
  })

  it('repairs an unresolvable legacy anchor exactly once', async () => {
    selectMessagesForTopic.mockReturnValue([user('u1'), assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2')])
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('ghost') } })
    const dispatch = vi.fn()

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(buildContextTurnsSpy).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: {
        contextWindowAnchor: { [topicId]: g('u1') }
      }
    })
  })

  it('repairs a stale deleted askId anchor through the full path', async () => {
    selectMessagesForTopic.mockReturnValue([user('u1'), assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2')])
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('deleted-ask-id') } })
    const dispatch = vi.fn()

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(buildContextTurnsSpy).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: {
        contextWindowAnchor: { [topicId]: g('u1') }
      }
    })
  })

  it('repairs a non-active legacy anchor through the full path', async () => {
    selectMessagesForTopic.mockReturnValue([user('u1'), assistant('a1', 'u1')])
    const getState = makeGetState({
      contextWindowAnchor: { [topicId]: { kind: 'vacant' } as unknown as ContextWindowAnchor }
    })
    const dispatch = vi.fn()

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(buildContextTurnsSpy).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: {
        contextWindowAnchor: { [topicId]: g('u1') }
      }
    })
  })

  it('empty topic never receives an anchor (no dispatch)', async () => {
    selectMessagesForTopic.mockReturnValue([])
    const getState = makeGetState({})
    const dispatch = vi.fn()

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('unknown assistant id is a silent no-op', async () => {
    const getState = makeGetState({})
    const dispatch = vi.fn()

    await ensureTopicAnchorEstablished(dispatch, getState, 'missing-assistant', topicId)

    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  // --- R-06 regression: viewport truncation must not recompute valid early anchor ---
  it('preserves a valid early active anchor outside a 20-row viewport (authority success)', async () => {
    // Simulate 50-row topic, viewport is tail 20 (msg-00030..00049), early anchor msg-00000.
    const viewport: Message[] = []
    for (let i = 30; i < 50; i++) {
      const id = `msg-${String(i).padStart(5, '0')}`
      viewport.push(user(id))
      viewport.push(assistant(`a-${id}`, id))
    }
    selectMessagesForTopic.mockReturnValue(viewport)
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('msg-00000') } })
    const dispatch = vi.fn()
    fetchContextClosureMock.mockResolvedValueOnce({
      messages: [{ id: 'msg-00000' }],
      blocks: [],
      closure: { topicId, anchorGroupKey: 'msg-00000', completeness: 'context-closure' }
    } as any)

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(fetchContextClosureMock).toHaveBeenCalledWith({ topicId, anchorGroupKey: 'msg-00000' })
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('ghost active anchor outside viewport still repairs to deterministic default (authority NOT_FOUND)', async () => {
    const viewport: Message[] = []
    for (let i = 30; i < 50; i++) {
      const id = `msg-${String(i).padStart(5, '0')}`
      viewport.push(user(id))
    }
    // viewport has 20 user turns (30..49), contextCount=2 → default is msg-00048 (second-last)
    selectMessagesForTopic.mockReturnValue(viewport)
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('ghost-outside') } })
    const dispatch = vi.fn()
    fetchContextClosureMock.mockRejectedValueOnce(Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }))

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(fetchContextClosureMock).toHaveBeenCalledWith({ topicId, anchorGroupKey: 'ghost-outside' })
    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
    expect(buildContextTurnsSpy).toHaveBeenCalledTimes(1)
  })

  it('transport failure for active anchor outside viewport fails closed (no spurious repair)', async () => {
    const viewport: Message[] = [user('u20'), assistant('a20', 'u20'), user('u21')]
    selectMessagesForTopic.mockReturnValue(viewport)
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('msg-00000') } })
    const dispatch = vi.fn()
    fetchContextClosureMock.mockRejectedValueOnce(new Error('IPC fail'))

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(fetchContextClosureMock).toHaveBeenCalled()
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('missing anchor initializes once from viewport (no authority probe)', async () => {
    selectMessagesForTopic.mockReturnValue([user('u1'), assistant('a1', 'u1'), user('u2')])
    const getState = makeGetState({})
    const dispatch = vi.fn()
    fetchContextClosureMock.mockClear()

    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)

    expect(fetchContextClosureMock).not.toHaveBeenCalled()
    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
  })

  // --- R-06 stale-repair guard: post-await re-read and in-flight dedup ---
  it('ghost probe that resolves after a newer anchor update does not overwrite (stale post-await guard)', async () => {
    const viewport = [user('u1'), assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2'), user('u3')]
    selectMessagesForTopic.mockReturnValue(viewport)
    const ghostState = makeGetState({ contextWindowAnchor: { [topicId]: g('ghost') } })
    const updatedState = makeGetState({ contextWindowAnchor: { [topicId]: g('u2') } })
    let getStateCalls = 0
    const getState = vi.fn(() => {
      getStateCalls++
      return getStateCalls === 1 ? ghostState() : updatedState()
    })
    // Defer the authority probe so we can mutate state before it resolves.
    let rejectProbe!: (e: unknown) => void
    fetchContextClosureMock.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          rejectProbe = rej
        })
    )
    const dispatch = vi.fn()
    const p = ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    // Let the probe start.
    await Promise.resolve()
    expect(fetchContextClosureMock).toHaveBeenCalledWith({ topicId, anchorGroupKey: 'ghost' })
    // Simulate NOT_FOUND ghost result after concurrent anchor update.
    rejectProbe(Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }))
    await p
    // Fresh anchor is u2, differs from probed ghost → must not overwrite.
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('ghost probe that resolves after anchor becomes viewport-resolvable does not dispatch', async () => {
    // Initial viewport missing ghost, but after concurrent update the ghost becomes resolvable
    // via new messages (or anchor changed to a resolvable key). We simulate fresh anchor still ghost
    // but fresh messages now contain ghost (became resolvable).
    const initialViewport = [user('u1'), assistant('a1', 'u1'), user('u2')]
    const freshViewport = [user('u1'), assistant('a1', 'u1'), user('ghost'), assistant('a-ghost', 'ghost')]
    let selectCalls = 0
    selectMessagesForTopic.mockImplementation(() => {
      selectCalls++
      // First call in task (initial check) uses initialViewport; second call (fresh re-read) uses freshViewport
      return selectCalls === 1 ? initialViewport : freshViewport
    })
    const ghostState = makeGetState({ contextWindowAnchor: { [topicId]: g('ghost') } })
    const getState = vi.fn(() => ghostState())
    let rejectProbe!: (e: unknown) => void
    fetchContextClosureMock.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          rejectProbe = rej
        })
    )
    const dispatch = vi.fn()
    const p = ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    await Promise.resolve()
    rejectProbe(Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }))
    await p
    // Fresh messages now resolve ghost → repair must be suppressed.
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('two overlapping ghost establishment calls produce at most one repair dispatch (in-flight dedup)', async () => {
    const viewport = [user('u1'), assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2')]
    selectMessagesForTopic.mockReturnValue(viewport)
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('ghost') } })
    let rejectProbe!: (e: unknown) => void
    fetchContextClosureMock.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          rejectProbe = rej
        })
    )
    const dispatch = vi.fn()
    const p1 = ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    const p2 = ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    await Promise.resolve()
    // Only one authority probe should have been issued.
    expect(fetchContextClosureMock).toHaveBeenCalledTimes(1)
    rejectProbe(Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }))
    await Promise.all([p1, p2])
    // At most one repair dispatch across both callers (dedup or post-await no-op).
    expect(updateAssistantSettings.mock.calls.length).toBeLessThanOrEqual(1)
    expect(dispatch.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('sequential ghost repair is idempotent — second call after repair is no-op', async () => {
    const viewport = [user('u1'), assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2')]
    selectMessagesForTopic.mockReturnValue(viewport)
    const ghostState = makeGetState({ contextWindowAnchor: { [topicId]: g('ghost') } })
    const repairedState = makeGetState({ contextWindowAnchor: { [topicId]: g('u1') } })
    fetchContextClosureMock.mockRejectedValue(Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }))
    const dispatch = vi.fn()
    await ensureTopicAnchorEstablished(dispatch, ghostState, 'asst-1', topicId)
    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
    updateAssistantSettings.mockClear()
    dispatch.mockClear()
    // Second call with already-repaired anchor (u1 resolvable in same viewport) → no-op.
    await ensureTopicAnchorEstablished(dispatch, repairedState, 'asst-1', topicId)
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
})
