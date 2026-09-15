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
  transferAnchorsAfterDeletion,
  transferAnchorsWithAuthorityGroupKeys
} from '../anchorService'
import * as contextTurnService from '../contextTurnService'

const { mocks: anchorMocks } = vi.hoisted(() => ({
  mocks: {
    updateAssistantSettings: vi.fn(),
    selectLoadedMessagesForTopic: vi.fn(),
    getAssistantSettings: vi.fn(),
    resolveContextClosure: vi.fn()
  }
}))
const updateAssistantSettings = anchorMocks.updateAssistantSettings
const selectLoadedMessagesForTopic = anchorMocks.selectLoadedMessagesForTopic
const getAssistantSettings = anchorMocks.getAssistantSettings
const resolveContextClosureMock = anchorMocks.resolveContextClosure
const buildContextTurnsSpy = vi.spyOn(contextTurnService, 'buildContextTurns')

vi.mock('@renderer/store/assistants', () => ({
  default: (state: unknown = {}) => state,
  updateAssistantSettings: (...args: unknown[]) => anchorMocks.updateAssistantSettings(...args),
  updateTopicUpdatedAt: (...args: unknown[]) => ({ type: 'updateTopicUpdatedAt', payload: args[0] })
}))

vi.mock('@renderer/store/newMessage', () => ({
  default: (state: unknown = {}) => state,
  selectLoadedMessagesForTopic: (...args: unknown[]) => anchorMocks.selectLoadedMessagesForTopic(...args),
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
    fetchContextClosure: vi.fn(),
    resolveContextClosure: (...args: unknown[]) => anchorMocks.resolveContextClosure(...args)
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
  selectLoadedMessagesForTopic.mockReset()
  getAssistantSettings.mockReset()
  buildContextTurnsSpy.mockClear()
  resolveContextClosureMock.mockReset()
  getAssistantSettings.mockImplementation((assistant: { settings: { contextWindowAnchor?: unknown } }) => ({
    contextCount: 2,
    contextWindowAnchor: (assistant.settings?.contextWindowAnchor ?? {}) as Record<string, unknown>
  }))
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
    const oldList = ['u0', 'u1', 'u2', 'u3', 'u4']
    const newList = ['u0', 'u1', 'u3', 'u4']
    expect(transferAnchorOnDeletion(g('u2'), oldList, newList)).toEqual(g('u1'))
  })

  it('delete last group (5→4, anchor index 4) → active(newGroupList[3])', () => {
    const oldList = ['u0', 'u1', 'u2', 'u3', 'u4']
    const newList = ['u0', 'u1', 'u2', 'u3']
    expect(transferAnchorOnDeletion(g('u4'), oldList, newList)).toEqual(g('u3'))
  })

  it('delete first group (5→4, anchor index 0) → active(newGroupList[0])', () => {
    const oldList = ['u0', 'u1', 'u2', 'u3', 'u4']
    const newList = ['u1', 'u2', 'u3', 'u4']
    expect(transferAnchorOnDeletion(g('u0'), oldList, newList)).toEqual(g('u1'))
  })

  it('delete first of two (2→1, anchor index 0) → active(newGroupList[0])', () => {
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

describe('transferAnchorsWithAuthorityGroupKeys', () => {
  const g = (key: string): ContextWindowAnchor => ({ kind: 'active', groupKey: key })
  const topicId = 'topic-1'
  const makeGetState = (settings: { contextWindowAnchor?: Record<string, ContextWindowAnchor | undefined> }) => () =>
    ({
      assistants: {
        assistants: [{ id: 'asst-1', settings }]
      }
    }) as any

  it('transfers directly from authority group keys without entity lookup', () => {
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('u2') } })
    const dispatch = vi.fn()
    transferAnchorsWithAuthorityGroupKeys(dispatch, getState, topicId, ['u1', 'u2', 'u3'], ['u1', 'u3'])
    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: { contextWindowAnchor: { [topicId]: g('u1') } }
    })
  })

  it('leaves a surviving anchor untouched', () => {
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('u1') } })
    const dispatch = vi.fn()
    transferAnchorsWithAuthorityGroupKeys(dispatch, getState, topicId, ['u1', 'u2'], ['u1'])
    expect(dispatch).not.toHaveBeenCalled()
  })
})

// --- inheritAnchorForBranch (branch anchor inheritance) ---

describe('inheritAnchorForBranch', () => {
  const g = (key: string): ContextWindowAnchor => ({ kind: 'active', groupKey: key })

  it('maps an in-range parent anchor into the branch by index', () => {
    const source = ['u0', 'u1', 'u2', 'u3']
    const branch = ['b0', 'b1', 'b2', 'b3']
    expect(inheritAnchorForBranch(g('u2'), source, branch)).toEqual(g('b2'))
  })

  it('clamps an out-of-range parent position to the branch LAST group (nearest predecessor)', () => {
    const source = ['u0', 'u1', 'u2', 'u3']
    const branch = ['b0']
    expect(inheritAnchorForBranch(g('u2'), source, branch)).toEqual(g('b0'))
  })

  it('clamps an out-of-range parent position to the branch last group (multi-group prefix)', () => {
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
    const source = ['u0', 'u1', 'u2', 'u3', 'u4', 'u5']
    const branch = ['b0', 'b1', 'b2']
    expect(inheritAnchorForBranch(g('u1'), source, branch)).toEqual(g('b1'))
  })
})

// --- ensureTopicAnchorEstablished (authority resolver glue) ---

describe('ensureTopicAnchorEstablished', () => {
  const g = (key: string): ContextWindowAnchor => ({ kind: 'active', groupKey: key })
  const topicId = 'topic-1'

  const makeGetState = (settings: { contextWindowAnchor?: Record<string, ContextWindowAnchor | undefined> }) => () =>
    ({
      assistants: {
        assistants: [{ id: 'asst-1', settings }]
      }
    }) as any

  const resolverSuccess = (resolvedAnchorGroupKey: string | null) =>
    ({
      messages: [],
      blocks: [],
      closure: {
        completeness: 'context-closure',
        topicId,
        anchorGroupKey: resolvedAnchorGroupKey,
        firstMessageId: resolvedAnchorGroupKey ? 'm1' : null,
        lastMessageId: resolvedAnchorGroupKey ? 'm1' : null,
        returnedCount: resolvedAnchorGroupKey ? 1 : 0,
        totalTurnCount: resolvedAnchorGroupKey ? 1 : 0,
        selectedTurnCount: resolvedAnchorGroupKey ? 1 : 0,
        boundaryMessageId: null
      },
      resolvedAnchorGroupKey,
      changed: true
    }) as any

  it('establishes the resolver anchor for a topic with no anchor', async () => {
    resolveContextClosureMock.mockResolvedValueOnce(resolverSuccess('u2'))
    const getState = makeGetState({})
    const dispatch = vi.fn()
    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    expect(resolveContextClosureMock).toHaveBeenCalledWith({
      topicId,
      intent: 'establish',
      contextCount: 2,
      currentAnchorGroupKey: null
    })
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: { contextWindowAnchor: { [topicId]: g('u2') } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(selectLoadedMessagesForTopic).not.toHaveBeenCalled()
    expect(buildContextTurnsSpy).not.toHaveBeenCalled()
  })

  it('preserves a valid persisted anchor without dispatch (resolver echo)', async () => {
    resolveContextClosureMock.mockResolvedValueOnce(resolverSuccess('u1'))
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('u1') } })
    const dispatch = vi.fn()
    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    expect(resolveContextClosureMock).toHaveBeenCalledWith({
      topicId,
      intent: 'establish',
      contextCount: 2,
      currentAnchorGroupKey: 'u1'
    })
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(selectLoadedMessagesForTopic).not.toHaveBeenCalled()
    expect(buildContextTurnsSpy).not.toHaveBeenCalled()
  })

  it('repairs a ghost anchor to the resolver default', async () => {
    resolveContextClosureMock.mockResolvedValueOnce(resolverSuccess('u1'))
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('ghost') } })
    const dispatch = vi.fn()
    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: { contextWindowAnchor: { [topicId]: g('u1') } }
    })
    expect(selectLoadedMessagesForTopic).not.toHaveBeenCalled()
    expect(buildContextTurnsSpy).not.toHaveBeenCalled()
  })

  it('removes the key when the resolver reports an empty target', async () => {
    resolveContextClosureMock.mockResolvedValueOnce(resolverSuccess(null))
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('u1') } })
    const dispatch = vi.fn()
    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: { contextWindowAnchor: {} }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('empty target with no persisted anchor is a no-op', async () => {
    resolveContextClosureMock.mockResolvedValueOnce(resolverSuccess(null))
    const getState = makeGetState({})
    const dispatch = vi.fn()
    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('transport failure preserves settings (no dispatch)', async () => {
    resolveContextClosureMock.mockRejectedValueOnce(new Error('IPC fail'))
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('u1') } })
    const dispatch = vi.fn()
    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('missing topic (NOT_FOUND) preserves settings', async () => {
    resolveContextClosureMock.mockRejectedValueOnce(Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }))
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('ghost') } })
    const dispatch = vi.fn()
    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('unknown assistant id is a silent no-op without resolver call', async () => {
    const getState = makeGetState({})
    const dispatch = vi.fn()
    await ensureTopicAnchorEstablished(dispatch, getState, 'missing-assistant', topicId)
    expect(resolveContextClosureMock).not.toHaveBeenCalled()
    expect(updateAssistantSettings).not.toHaveBeenCalled()
  })

  it('stale result after concurrent anchor change does not overwrite', async () => {
    const ghostState = makeGetState({ contextWindowAnchor: { [topicId]: g('ghost') } })
    const updatedState = makeGetState({ contextWindowAnchor: { [topicId]: g('u2') } })
    let calls = 0
    const getState = vi.fn(() => {
      calls++
      return calls === 1 ? ghostState() : updatedState()
    })
    let resolve!: (v: unknown) => void
    resolveContextClosureMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolve = res
        })
    )
    const dispatch = vi.fn()
    const p = ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    await Promise.resolve()
    expect(resolveContextClosureMock).toHaveBeenCalledTimes(1)
    resolve(resolverSuccess('u1'))
    await p
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('two overlapping calls produce one resolver call and at most one dispatch (in-flight dedup)', async () => {
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('ghost') } })
    let resolve!: (v: unknown) => void
    resolveContextClosureMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolve = res
        })
    )
    const dispatch = vi.fn()
    const p1 = ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    const p2 = ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    await Promise.resolve()
    expect(resolveContextClosureMock).toHaveBeenCalledTimes(1)
    resolve(resolverSuccess('u1'))
    await Promise.all([p1, p2])
    expect(updateAssistantSettings.mock.calls.length).toBeLessThanOrEqual(1)
    expect(dispatch.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('persisted anchor outside viewport is never treated invalid (no viewport reads)', async () => {
    resolveContextClosureMock.mockResolvedValueOnce(resolverSuccess('msg-00000'))
    const getState = makeGetState({ contextWindowAnchor: { [topicId]: g('msg-00000') } })
    const dispatch = vi.fn()
    await ensureTopicAnchorEstablished(dispatch, getState, 'asst-1', topicId)
    expect(resolveContextClosureMock).toHaveBeenCalledWith({
      topicId,
      intent: 'establish',
      contextCount: 2,
      currentAnchorGroupKey: 'msg-00000'
    })
    expect(selectLoadedMessagesForTopic).not.toHaveBeenCalled()
    expect(buildContextTurnsSpy).not.toHaveBeenCalled()
    expect(updateAssistantSettings).not.toHaveBeenCalled()
  })
})
