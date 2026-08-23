import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storeGetState: vi.fn(),
  dbFetchAnswerGroup: vi.fn(),
  merge: vi.fn((orig: any, fresh: any, _topicId: string) => ({
    ...orig,
    settings: fresh.settings,
    prompt: fresh.prompt
  }))
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      silly: vi.fn()
    })
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: mocks.storeGetState,
    dispatch: vi.fn()
  }
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  mergeRequestAssistantSnapshot: mocks.merge
}))

vi.mock('@renderer/services/db/DbService', () => ({
  dbService: {
    fetchAnswerGroup: mocks.dbFetchAnswerGroup
  }
}))

import {
  fetchAuthoritativeAnswerGroup,
  resolveAnswerGroup,
  resolveAssistantSnapshot,
  resolveAssistantSnapshotForMessage,
  resolveEditTarget,
  resolveMessageEntity,
  resolveRegenerateForAssistant,
  resolveResendForUser
} from '../messageActionController'

const makeModel = (id: string, provider = 'openai') => ({ id, provider, name: id, group: 'test' }) as any

const makeAssistant = (id: string, model: any, settings: any = { contextCount: 5, contextWindowAnchor: {} }) =>
  ({
    id,
    name: 'assistant',
    prompt: 'prompt',
    topics: [{ id: 'topic-1', assistantId: id } as any],
    type: 'assistant',
    model,
    settings
  }) as any

const makeMessage = (overrides: any) => ({
  id: 'msg-1',
  topicId: 'topic-1',
  assistantId: 'asst-1',
  role: 'assistant',
  blocks: [],
  status: 'success',
  ...overrides
})

describe('messageActionController — S3.4 event-time resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves latest message entity for explicit target (edit/resend)', () => {
    const latest = makeMessage({ id: 'msg-1', topicId: 'topic-1', content: 'latest' })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'msg-1': latest }, messageIdsByTopic: { 'topic-1': ['msg-1'] } },
      assistants: { assistants: [makeAssistant('asst-1', makeModel('m1'))] },
      messageBlocks: { entities: {} }
    })
    const resolved = resolveMessageEntity({ topicId: 'topic-1', messageId: 'msg-1' })
    expect(resolved).toBe(latest)
    expect(resolveEditTarget({ topicId: 'topic-1', messageId: 'msg-1' })).toBe(latest)
  })

  it('preserves explicit target — does not retarget to active topic (cross-topic null)', () => {
    const msg = makeMessage({ id: 'msg-1', topicId: 'topic-1' })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'msg-1': msg }, messageIdsByTopic: { 'topic-1': ['msg-1'], 'topic-2': [] } },
      assistants: { assistants: [] },
      messageBlocks: { entities: {} }
    })
    // explicit target is topic-2 but message belongs to topic-1 → must be null
    expect(resolveMessageEntity({ topicId: 'topic-2', messageId: 'msg-1' })).toBeNull()
    expect(resolveRegenerateForAssistant({ topicId: 'topic-2', messageId: 'msg-1' })).toBeNull()
    expect(resolveResendForUser({ topicId: 'topic-2', messageId: 'msg-1' })).toBeNull()
    expect(resolveAnswerGroup({ topicId: 'topic-2', messageId: 'msg-1' })).toBeNull()
  })

  it('invalid/missing targets preserve rejection (null, no dispatch)', () => {
    mocks.storeGetState.mockReturnValue({
      messages: { entities: {}, messageIdsByTopic: {} },
      assistants: { assistants: [] },
      messageBlocks: { entities: {} }
    })
    expect(resolveMessageEntity({ topicId: 'topic-1', messageId: 'missing' })).toBeNull()
    expect(resolveRegenerateForAssistant({ topicId: 'topic-1', messageId: 'missing' })).toBeNull()
    expect(resolveAnswerGroup({ topicId: 'topic-1', messageId: 'missing' })).toBeNull()
  })

  it('ambient Assistant change before click is observed (event-time fresh)', () => {
    const newModel = makeModel('new-model')
    const freshAssistant = makeAssistant('asst-1', newModel, { contextCount: 10, temperature: 0.5 })
    const msg = makeMessage({ id: 'msg-1', topicId: 'topic-1', role: 'assistant', assistantId: 'asst-1' })
    // no per-message model override
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'msg-1': msg }, messageIdsByTopic: { 'topic-1': ['msg-1'] } },
      assistants: { assistants: [freshAssistant] },
      messageBlocks: { entities: {} }
    })
    const resolved = resolveAssistantSnapshotForMessage(msg, 'topic-1')
    expect(resolved).not.toBeNull()
    expect(resolved!.snapshot.model?.id).toBe('new-model')
    expect(mocks.merge).toHaveBeenCalledWith(expect.objectContaining({ model: newModel }), freshAssistant, 'topic-1')
  })

  it('explicit per-message model override is preserved while refreshing ambient settings', () => {
    const ambientModel = makeModel('ambient-model')
    const overrideModel = makeModel('override-model')
    const freshAssistant = makeAssistant('asst-1', ambientModel, { contextCount: 20, temperature: 0.7 })
    const msg = makeMessage({
      id: 'msg-1',
      topicId: 'topic-1',
      role: 'assistant',
      assistantId: 'asst-1',
      modelId: 'override-model',
      model: overrideModel
    })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'msg-1': msg }, messageIdsByTopic: { 'topic-1': ['msg-1'] } },
      assistants: { assistants: [freshAssistant] },
      messageBlocks: { entities: {} }
    })
    const resolved = resolveAssistantSnapshotForMessage(msg, 'topic-1')
    expect(resolved).not.toBeNull()
    // explicit model must survive, settings must be fresh
    expect(resolved!.snapshot.model?.id).toBe('override-model')
    expect(resolved!.explicitModel?.id).toBe('override-model')
    expect(mocks.merge).toHaveBeenCalledWith(
      expect.objectContaining({ model: overrideModel }),
      freshAssistant,
      'topic-1'
    )
  })

  it('explicitModel param overrides ambient but settings remain fresh', () => {
    const ambient = makeModel('ambient')
    const explicit = makeModel('explicit')
    const fresh = makeAssistant('asst-1', ambient, { contextCount: 5 })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: {}, messageIdsByTopic: {} },
      assistants: { assistants: [fresh] },
      messageBlocks: { entities: {} }
    })
    const resolved = resolveAssistantSnapshot({ topicId: 'topic-1', assistantId: 'asst-1', explicitModel: explicit })
    expect(resolved!.snapshot.model?.id).toBe('explicit')
    expect(resolved!.fresh.settings?.contextCount).toBe(5)
  })

  it('answer-switch includes complete latest group after projection update', () => {
    const askId = 'user-1'
    const msg1 = makeMessage({ id: 'a-1', topicId: 'topic-1', role: 'assistant', askId, assistantId: 'asst-1' })
    const msg2 = makeMessage({ id: 'a-2', topicId: 'topic-1', role: 'assistant', askId, assistantId: 'asst-1' })
    const msg3 = makeMessage({ id: 'a-3', topicId: 'topic-1', role: 'assistant', askId, assistantId: 'asst-1' })
    // Projection has expanded to include a-3
    mocks.storeGetState.mockReturnValue({
      messages: {
        entities: { 'a-1': msg1, 'a-2': msg2, 'a-3': msg3 },
        messageIdsByTopic: { 'topic-1': ['user-1', 'a-1', 'a-2', 'a-3'] }
      },
      assistants: { assistants: [makeAssistant('asst-1', makeModel('m1'))] },
      messageBlocks: { entities: {} }
    })
    const resolved = resolveAnswerGroup({ topicId: 'topic-1', messageId: 'a-2' })
    expect(resolved).not.toBeNull()
    expect(resolved!.groupIds).toEqual(['a-1', 'a-2', 'a-3'])
  })

  it('answer-switch does not use stale captured array — derives from store', () => {
    const askId = 'ask-1'
    const msg1 = makeMessage({ id: 'a-1', topicId: 'topic-1', role: 'assistant', askId })
    const msg2 = makeMessage({ id: 'a-2', topicId: 'topic-1', role: 'assistant', askId })
    const msg3 = makeMessage({ id: 'a-3', topicId: 'topic-1', role: 'assistant', askId })
    mocks.storeGetState.mockReturnValueOnce({
      messages: {
        entities: { 'a-1': msg1, 'a-2': msg2 },
        messageIdsByTopic: { 'topic-1': ['a-1', 'a-2'] }
      },
      assistants: { assistants: [] },
      messageBlocks: { entities: {} }
    })
    mocks.storeGetState.mockReturnValue({
      messages: {
        entities: { 'a-1': msg1, 'a-2': msg2, 'a-3': msg3 },
        messageIdsByTopic: { 'topic-1': ['a-1', 'a-2', 'a-3'] }
      },
      assistants: { assistants: [] },
      messageBlocks: { entities: {} }
    })
    const first = resolveAnswerGroup({ topicId: 'topic-1', messageId: 'a-1' })
    expect(first!.groupIds).toEqual(['a-1', 'a-2'])
    const second = resolveAnswerGroup({ topicId: 'topic-1', messageId: 'a-1' })
    expect(second!.groupIds).toEqual(['a-1', 'a-2', 'a-3'])
  })

  it('resend for user resolves latest entity and fresh assistant', () => {
    const userMsg = makeMessage({ id: 'u-1', topicId: 'topic-1', role: 'user', assistantId: 'asst-1' })
    const fresh = makeAssistant('asst-1', makeModel('fresh'), { contextCount: 99 })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'u-1': userMsg }, messageIdsByTopic: { 'topic-1': ['u-1'] } },
      assistants: { assistants: [fresh] },
      messageBlocks: { entities: {} }
    })
    const resolved = resolveResendForUser({ topicId: 'topic-1', messageId: 'u-1' })
    expect(resolved!.message).toBe(userMsg)
    expect(resolved!.assistant.fresh).toBe(fresh)
  })

  it('happy path unchanged — valid targets resolve successfully', () => {
    const msg = makeMessage({
      id: 'msg-1',
      topicId: 'topic-1',
      role: 'assistant',
      assistantId: 'asst-1',
      askId: 'ask-1'
    })
    const fresh = makeAssistant('asst-1', makeModel('m1'))
    mocks.storeGetState.mockReturnValue({
      messages: {
        entities: { 'msg-1': msg },
        messageIdsByTopic: { 'topic-1': ['msg-1'] }
      },
      assistants: { assistants: [fresh] },
      messageBlocks: { entities: {} }
    })
    expect(resolveRegenerateForAssistant({ topicId: 'topic-1', messageId: 'msg-1' })).not.toBeNull()
    expect(resolveMessageEntity({ topicId: 'topic-1', messageId: 'msg-1' })).not.toBeNull()
  })

  it('rejects cross-topic answer-switch even if askId matches', () => {
    const askId = 'ask-1'
    const msg = makeMessage({ id: 'a-1', topicId: 'topic-1', role: 'assistant', askId })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'a-1': msg }, messageIdsByTopic: { 'topic-1': ['a-1'] } },
      assistants: { assistants: [] },
      messageBlocks: { entities: {} }
    })
    expect(resolveAnswerGroup({ topicId: 'topic-2', messageId: 'a-1' })).toBeNull()
  })

  it('override predicate aligns with thunk: modelId falsy => no explicit override even if model present', () => {
    const fresh = makeAssistant('asst-1', makeModel('fresh'))
    const msgWithModelOnly = makeMessage({
      id: 'msg-1',
      topicId: 'topic-1',
      role: 'assistant',
      assistantId: 'asst-1',
      model: makeModel('stale-model'),
      modelId: undefined
    })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'msg-1': msgWithModelOnly }, messageIdsByTopic: { 'topic-1': ['msg-1'] } },
      assistants: { assistants: [fresh] },
      messageBlocks: { entities: {} }
    })
    const resolved = resolveAssistantSnapshotForMessage(msgWithModelOnly, 'topic-1')
    // Should use fresh model, not stale, because modelId is missing (same as thunk)
    expect(resolved!.snapshot.model?.id).toBe('fresh')
    expect(resolved!.explicitModel).toBeUndefined()
  })

  it('override predicate: modelId present but model missing => no explicit model, uses fresh', () => {
    const fresh = makeAssistant('asst-1', makeModel('fresh'))
    const msgWithIdOnly = makeMessage({
      id: 'msg-1',
      topicId: 'topic-1',
      role: 'assistant',
      assistantId: 'asst-1',
      model: undefined,
      modelId: 'legacy-id'
    })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'msg-1': msgWithIdOnly }, messageIdsByTopic: { 'topic-1': ['msg-1'] } },
      assistants: { assistants: [fresh] },
      messageBlocks: { entities: {} }
    })
    const resolved = resolveAssistantSnapshotForMessage(msgWithIdOnly, 'topic-1')
    // Legacy partial: modelId without model keeps fresh (documents compatibility: no crash, no any)
    expect(resolved!.snapshot.model?.id).toBe('fresh')
    expect(resolved!.explicitModel).toBeUndefined()
  })

  it('folded navigation controller path uses explicit IDs only (no stale group array)', () => {
    const askId = 'ask-1'
    const msg = makeMessage({ id: 'a-2', topicId: 'topic-1', role: 'assistant', askId })
    const fresh = makeAssistant('asst-1', makeModel('m1'))
    // Store has expanded group; controller derives from store, not captured array
    mocks.storeGetState.mockReturnValue({
      messages: {
        entities: {
          'a-1': makeMessage({ id: 'a-1', topicId: 'topic-1', role: 'assistant', askId }),
          'a-2': msg,
          'a-3': makeMessage({ id: 'a-3', topicId: 'topic-1', role: 'assistant', askId })
        },
        messageIdsByTopic: { 'topic-1': ['a-1', 'a-2', 'a-3'] }
      },
      assistants: { assistants: [fresh] },
      messageBlocks: { entities: {} }
    })
    const group = resolveAnswerGroup({ topicId: 'topic-1', messageId: 'a-2' })
    expect(group!.groupIds).toEqual(['a-1', 'a-2', 'a-3'])
  })

  describe('fetchAuthoritativeAnswerGroup — S6.2b R-05 authoritative READ', () => {
    it('returns authoritative group even when renderer has only subset (partial window)', async () => {
      const askId = 'ask-1'
      const a2 = makeMessage({ id: 'a-2', topicId: 'topic-1', role: 'assistant', askId })
      // Renderer window has only a2 (partial), but Main will return full group [a1,a2,a3]
      mocks.storeGetState.mockReturnValue({
        messages: {
          entities: { 'a-2': a2 },
          messageIdsByTopic: { 'topic-1': ['a-2'] }
        },
        assistants: { assistants: [] },
        messageBlocks: { entities: {} }
      })
      mocks.dbFetchAnswerGroup.mockResolvedValue({
        completeness: 'answer-group' as const,
        topicId: 'topic-1',
        anchorMessageId: 'a-2',
        askId,
        messageIds: ['a-1', 'a-2', 'a-3']
      })
      const result = await fetchAuthoritativeAnswerGroup({ topicId: 'topic-1', messageId: 'a-2' })
      expect(result).not.toBeNull()
      expect(result!.groupIds).toEqual(['a-1', 'a-2', 'a-3'])
      expect(mocks.dbFetchAnswerGroup).toHaveBeenCalledWith('topic-1', 'a-2')
      // No fallback to partial renderer group — Main group is used even though renderer had only subset
      expect(result!.groupIds).not.toEqual(['a-2'])
    })

    it('returns null on NOT_FOUND and does not fallback to partial inference', async () => {
      mocks.storeGetState.mockReturnValue({
        messages: {
          entities: {
            'a-1': makeMessage({ id: 'a-1', topicId: 'topic-1', role: 'assistant', askId: 'ask-1' }),
            'a-2': makeMessage({ id: 'a-2', topicId: 'topic-1', role: 'assistant', askId: 'ask-1' })
          },
          messageIdsByTopic: { 'topic-1': ['a-1', 'a-2'] }
        },
        assistants: { assistants: [] },
        messageBlocks: { entities: {} }
      })
      mocks.dbFetchAnswerGroup.mockRejectedValue(new Error('NOT_FOUND: Anchor has no actionable group'))
      const result = await fetchAuthoritativeAnswerGroup({ topicId: 'topic-1', messageId: 'a-2' })
      expect(result).toBeNull()
      // Ensure no partial group is returned despite renderer having a partial group available
      expect(result).not.toEqual(expect.objectContaining({ groupIds: ['a-1', 'a-2'] }))
    })

    it('returns null on transport error without fallback', async () => {
      mocks.storeGetState.mockReturnValue({
        messages: { entities: {}, messageIdsByTopic: {} },
        assistants: { assistants: [] },
        messageBlocks: { entities: {} }
      })
      mocks.dbFetchAnswerGroup.mockRejectedValue(new Error('IPC transport failed'))
      const result = await fetchAuthoritativeAnswerGroup({ topicId: 'topic-1', messageId: 'a-2' })
      expect(result).toBeNull()
    })

    it('returns null on echo mismatch (topicId/anchorMessageId)', async () => {
      const a2 = makeMessage({ id: 'a-2', topicId: 'topic-1', role: 'assistant', askId: 'ask-1' })
      mocks.storeGetState.mockReturnValue({
        messages: { entities: { 'a-2': a2 }, messageIdsByTopic: { 'topic-1': ['a-2'] } },
        assistants: { assistants: [] },
        messageBlocks: { entities: {} }
      })
      mocks.dbFetchAnswerGroup.mockResolvedValue({
        completeness: 'answer-group' as const,
        topicId: 'topic-1',
        anchorMessageId: 'different-anchor',
        askId: 'ask-1',
        messageIds: ['a-1', 'a-2']
      })
      const result = await fetchAuthoritativeAnswerGroup({ topicId: 'topic-1', messageId: 'a-2' })
      expect(result).toBeNull()
    })

    it('synthesizes placeholder targetMessage when renderer window is partial and anchor missing locally', async () => {
      // Renderer window is empty (anchor not in projection), but Main will still return group
      mocks.storeGetState.mockReturnValue({
        messages: { entities: {}, messageIdsByTopic: { 'topic-1': [] } },
        assistants: { assistants: [] },
        messageBlocks: { entities: {} }
      })
      mocks.dbFetchAnswerGroup.mockResolvedValue({
        completeness: 'answer-group' as const,
        topicId: 'topic-1',
        anchorMessageId: 'a-2',
        askId: 'ask-1',
        messageIds: ['a-1', 'a-2', 'a-3']
      })
      const result = await fetchAuthoritativeAnswerGroup({ topicId: 'topic-1', messageId: 'a-2' })
      expect(result).not.toBeNull()
      expect(result!.targetMessage.id).toBe('a-2')
      expect(result!.groupIds).toEqual(['a-1', 'a-2', 'a-3'])
    })
  })
})
