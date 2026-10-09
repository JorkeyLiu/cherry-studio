import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storeGetState: vi.fn(),
  merge: vi.fn((orig: any, fresh: any) => ({ ...orig, settings: fresh.settings, prompt: fresh.prompt }))
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/store', () => ({
  default: { getState: mocks.storeGetState, dispatch: vi.fn() }
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  mergeRequestAssistantSnapshot: mocks.merge
}))

import { resolveAssistantSnapshot, resolveEffectiveModel } from '../messageActionController'

const makeModel = (id: unknown, provider: unknown = 'openai') => ({ id, provider, name: id, group: 'g' }) as never

describe('resolveEffectiveModel malformed persisted selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('absent slots stay unconfigured (undefined)', () => {
    expect(resolveEffectiveModel({ llm: {} } as never, { id: 'a' } as never)).toBeUndefined()
    expect(resolveEffectiveModel({ llm: { defaultModel: undefined } } as never, { id: 'a' } as never)).toBeUndefined()
  })

  it('present-but-malformed assistant.model does not fall through to valid defaults', () => {
    const state = { llm: { defaultModel: makeModel('global') } } as never
    const malformedForms: never[] = [
      {} as never,
      makeModel(undefined),
      makeModel(null),
      makeModel(''),
      makeModel('   '),
      makeModel(123),
      { id: 'm1' } as never,
      { id: 'm1', provider: '' } as never
    ]
    for (const malformed of malformedForms) {
      const fresh = { id: 'a', model: malformed, defaultModel: makeModel('assistant-default') } as never
      expect(resolveEffectiveModel(state, fresh)).toBeUndefined()
    }
  })

  it('present-but-malformed explicit model does not use valid assistant/global defaults', () => {
    const state = { llm: { defaultModel: makeModel('global') } } as never
    const fresh = { id: 'a', model: makeModel('own'), defaultModel: makeModel('dflt') } as never
    expect(resolveEffectiveModel(state, fresh, {} as never)).toBeUndefined()
    expect(resolveEffectiveModel(state, fresh, makeModel(undefined))).toBeUndefined()
    expect(resolveEffectiveModel(state, fresh, makeModel('', 'openai'))).toBeUndefined()
  })

  it('valid serving model with missing display/group metadata remains accepted with identity preserved', () => {
    const state = { llm: { defaultModel: makeModel('global') } } as never
    const minimal = { id: 'custom-id-xyz', provider: 'custom-conn' } as never
    const fresh = { id: 'a', model: minimal } as never
    expect(resolveEffectiveModel(state, fresh)).toBe(minimal)
    const arbitrary = { id: 'DeepSeek/DeepSeek-V4-FLASH', provider: 'deepseek' } as never
    expect(resolveEffectiveModel(state, { id: 'a' } as never, arbitrary)).toBe(arbitrary)
  })

  it('snapshot stays model-less for malformed persisted choice so callers fail closed', () => {
    const bare = {
      id: 'asst-1',
      name: 'a',
      prompt: '',
      topics: [],
      type: 'assistant',
      model: {},
      settings: {}
    } as never
    mocks.storeGetState.mockReturnValue({
      messages: { entities: {}, messageIdsByTopic: {} },
      assistants: { assistants: [bare] },
      llm: { defaultModel: makeModel('global') },
      messageBlocks: { entities: {} }
    })
    const resolved = resolveAssistantSnapshot({ topicId: 't', assistantId: 'asst-1' })
    expect(resolved).not.toBeNull()
    expect(resolved!.snapshot.model).toBeUndefined()
  })
})
