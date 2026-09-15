import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storeGetState: vi.fn(),
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

import {
  findAssistantById,
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
  })

  it('invalid/missing targets preserve rejection (null, no dispatch)', () => {
    mocks.storeGetState.mockReturnValue({
      messages: { entities: {}, messageIdsByTopic: {} },
      assistants: { assistants: [] },
      messageBlocks: { entities: {} }
    })
    expect(resolveMessageEntity({ topicId: 'topic-1', messageId: 'missing' })).toBeNull()
    expect(resolveRegenerateForAssistant({ topicId: 'topic-1', messageId: 'missing' })).toBeNull()
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

  it('unified lookup: empty array falls back to defaultAssistant id (user resend still resolves)', () => {
    const fallback = makeAssistant('default', makeModel('fallback-model'))
    const userMsg = makeMessage({ id: 'u-1', topicId: 'topic-1', role: 'user', assistantId: 'default' })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'u-1': userMsg }, messageIdsByTopic: { 'topic-1': ['u-1'] } },
      assistants: { assistants: [], defaultAssistant: fallback },
      messageBlocks: { entities: {} }
    })
    expect(findAssistantById(mocks.storeGetState() as never, 'default')).toBe(fallback)
    const resolved = resolveAssistantSnapshot({ topicId: 'topic-1', assistantId: 'default' })
    expect(resolved).not.toBeNull()
    expect(resolved!.fresh).toBe(fallback)
    const resend = resolveResendForUser({ topicId: 'topic-1', messageId: 'u-1' })
    expect(resend).not.toBeNull()
    expect(resend!.assistant.fresh).toBe(fallback)
  })

  it('unified lookup: array match wins over defaultAssistant; unknown id stays null (fail-closed)', () => {
    const inList = makeAssistant('asst-1', makeModel('list-model'))
    const fallback = makeAssistant('asst-1', makeModel('fallback-model'))
    mocks.storeGetState.mockReturnValue({
      messages: { entities: {}, messageIdsByTopic: {} },
      assistants: { assistants: [inList], defaultAssistant: fallback },
      messageBlocks: { entities: {} }
    })
    expect(findAssistantById(mocks.storeGetState() as never, 'asst-1')).toBe(inList)
    mocks.storeGetState.mockReturnValue({
      messages: { entities: {}, messageIdsByTopic: {} },
      assistants: { assistants: [], defaultAssistant: fallback },
      messageBlocks: { entities: {} }
    })
    expect(resolveAssistantSnapshot({ topicId: 'topic-1', assistantId: 'unknown' })).toBeNull()
    expect(findAssistantById(mocks.storeGetState() as never, 'unknown')).toBeUndefined()
  })

  it('resolveEffectiveModel priority: explicit > own > defaultModel > global', async () => {
    const { resolveEffectiveModel } = await import('../messageActionController')
    const global = makeModel('global')
    const state = { llm: { defaultModel: global } } as never
    const full = { id: 'a', model: makeModel('own'), defaultModel: makeModel('dflt') } as never
    expect(resolveEffectiveModel(state, full, makeModel('explicit'))?.id).toBe('explicit')
    expect(resolveEffectiveModel(state, full)?.id).toBe('own')
    expect(resolveEffectiveModel(state, { id: 'a', defaultModel: makeModel('dflt') } as never)?.id).toBe('dflt')
    expect(resolveEffectiveModel(state, { id: 'a' } as never)?.id).toBe('global')
    expect(resolveEffectiveModel({ llm: {} } as never, { id: 'a' } as never)).toBeUndefined()
  })

  it('user resend with model-less assistant falls back to global llm.defaultModel', () => {
    const global = makeModel('mock-model')
    const bare = makeAssistant('asst-1', undefined)
    delete bare.model
    const userMsg = makeMessage({ id: 'u-1', topicId: 'topic-1', role: 'user', assistantId: 'asst-1' })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'u-1': userMsg }, messageIdsByTopic: { 'topic-1': ['u-1'] } },
      assistants: { assistants: [bare] },
      llm: { defaultModel: global },
      messageBlocks: { entities: {} }
    })
    const resolved = resolveResendForUser({ topicId: 'topic-1', messageId: 'u-1' })
    expect(resolved).not.toBeNull()
    expect(resolved!.assistant.snapshot.model?.id).toBe('mock-model')
  })

  it('assistant own model wins over assistant.defaultModel and global', () => {
    const bare = { ...makeAssistant('asst-1', makeModel('own')), defaultModel: makeModel('dflt') }
    const userMsg = makeMessage({ id: 'u-1', topicId: 'topic-1', role: 'user', assistantId: 'asst-1' })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'u-1': userMsg }, messageIdsByTopic: { 'topic-1': ['u-1'] } },
      assistants: { assistants: [bare] },
      llm: { defaultModel: makeModel('global') },
      messageBlocks: { entities: {} }
    })
    expect(resolveResendForUser({ topicId: 'topic-1', messageId: 'u-1' })!.assistant.snapshot.model?.id).toBe('own')
  })

  it('assistant.defaultModel wins over global when own model is absent', () => {
    const bare = { ...makeAssistant('asst-1', undefined), defaultModel: makeModel('dflt') }
    delete bare.model
    const userMsg = makeMessage({ id: 'u-1', topicId: 'topic-1', role: 'user', assistantId: 'asst-1' })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'u-1': userMsg }, messageIdsByTopic: { 'topic-1': ['u-1'] } },
      assistants: { assistants: [bare] },
      llm: { defaultModel: makeModel('global') },
      messageBlocks: { entities: {} }
    })
    expect(resolveResendForUser({ topicId: 'topic-1', messageId: 'u-1' })!.assistant.snapshot.model?.id).toBe('dflt')
  })

  it('explicit model wins over every fallback slot', () => {
    const bare = { ...makeAssistant('asst-1', makeModel('own')), defaultModel: makeModel('dflt') }
    mocks.storeGetState.mockReturnValue({
      messages: { entities: {}, messageIdsByTopic: {} },
      assistants: { assistants: [bare] },
      llm: { defaultModel: makeModel('global') },
      messageBlocks: { entities: {} }
    })
    const resolved = resolveAssistantSnapshot({
      topicId: 'topic-1',
      assistantId: 'asst-1',
      explicitModel: makeModel('explicit')
    })
    expect(resolved!.snapshot.model?.id).toBe('explicit')
    expect(resolved!.explicitModel?.id).toBe('explicit')
  })

  it('all model slots empty: snapshot stays model-less so the thunk fails closed', () => {
    const bare = makeAssistant('asst-1', undefined)
    delete bare.model
    const userMsg = makeMessage({ id: 'u-1', topicId: 'topic-1', role: 'user', assistantId: 'asst-1' })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'u-1': userMsg }, messageIdsByTopic: { 'topic-1': ['u-1'] } },
      assistants: { assistants: [bare] },
      llm: {},
      messageBlocks: { entities: {} }
    })
    const resolved = resolveResendForUser({ topicId: 'topic-1', messageId: 'u-1' })
    // Resolution itself stays non-null (target + assistant are valid); the
    // missing model fails closed downstream in resendMessageThunk's guard.
    expect(resolved).not.toBeNull()
    expect(resolved!.assistant.snapshot.model).toBeUndefined()
  })

  it('regenerate without per-message override also receives the global fallback', () => {
    const global = makeModel('mock-model')
    const bare = makeAssistant('asst-1', undefined)
    delete bare.model
    const msg = makeMessage({
      id: 'a-1',
      topicId: 'topic-1',
      role: 'assistant',
      assistantId: 'asst-1',
      askId: 'u-1'
    })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'a-1': msg }, messageIdsByTopic: { 'topic-1': ['a-1'] } },
      assistants: { assistants: [bare] },
      llm: { defaultModel: global },
      messageBlocks: { entities: {} }
    })
    const resolved = resolveRegenerateForAssistant({ topicId: 'topic-1', messageId: 'a-1' })
    expect(resolved).not.toBeNull()
    expect(resolved!.assistant.snapshot.model?.id).toBe('mock-model')
  })

  it('unified lookup: regenerate path resolves via defaultAssistant without regression', () => {
    const fallback = makeAssistant('default', makeModel('fallback-model'))
    const msg = makeMessage({
      id: 'a-1',
      topicId: 'topic-1',
      role: 'assistant',
      assistantId: 'default',
      askId: 'u-1'
    })
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { 'a-1': msg }, messageIdsByTopic: { 'topic-1': ['a-1'] } },
      assistants: { assistants: [], defaultAssistant: fallback },
      messageBlocks: { entities: {} }
    })
    const resolved = resolveRegenerateForAssistant({ topicId: 'topic-1', messageId: 'a-1' })
    expect(resolved).not.toBeNull()
    expect(resolved!.assistant.fresh).toBe(fallback)
    expect(resolved!.message).toBe(msg)
  })
})
