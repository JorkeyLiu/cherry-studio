import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    resendUserMessages: vi.fn(),
    regenerateAssistantMessage: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    transformMessagesAndFetch: vi.fn(),
    selectMessagesForTopic: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    resendUserMessages: mocks.resendUserMessages,
    regenerateAssistantMessage: mocks.regenerateAssistantMessage
  }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))
vi.mock('@renderer/store/assistants', () => ({ updateTopicUpdatedAt: vi.fn() }))
vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: () => ({ add: (t: () => Promise<unknown>) => t() }),
  waitForTopicQueue: vi.fn()
}))
vi.mock('@renderer/utils/abortController', () => ({ addAbortController: vi.fn() }))
vi.mock('swr', () => ({ mutate: vi.fn() }))
vi.mock('i18next', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k },
  t: (k: string) => k
}))
vi.mock('@renderer/services/ApiService', () => ({ transformMessagesAndFetch: mocks.transformMessagesAndFetch }))

const msg = (o: Partial<Message> = {}): Message =>
  ({
    id: 'm-1',
    role: 'assistant',
    assistantId: 'as-1',
    topicId: 't-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: AssistantMessageStatus.PENDING,
    blocks: [],
    ...o
  }) as unknown as Message
const user = (o: Partial<Message> = {}): Message =>
  msg({ id: 'u-1', role: 'user', status: 'success' as never, blocks: ['bu-1'], ...o })

const FULL_MODEL = { id: 'm1', provider: 'p', name: 'n', group: 'g' } as const
const fullModel = () => ({ ...FULL_MODEL })
interface S {
  messages: { entities: Record<string, Message>; messageIdsByTopic: Record<string, string[]> }
  messageBlocks: { entities: Record<string, unknown> }
  assistants: { assistants: Array<{ id: string }> }
}
let st: S
vi.mock('@renderer/store', () => ({ default: { dispatch: vi.fn(), getState: () => st } }))
vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    addMessage: (p: unknown) => ({ type: 'add', p }),
    updateMessage: (p: unknown) => ({ type: 'update', p }),
    setTopicLoading: (p: unknown) => ({ type: 'loading', p }),
    setTopicFulfilled: (p: unknown) => ({ type: 'fulfilled', p })
  },
  selectMessagesForTopic: mocks.selectMessagesForTopic
}))
vi.mock('@renderer/store/messageBlock', () => ({
  removeManyBlocks: (p: unknown) => ({ type: 'removeBlocks', p }),
  updateOneBlock: vi.fn(),
  upsertManyBlocks: vi.fn(),
  upsertOneBlock: vi.fn(),
  messageBlocksSelectors: { selectById: (s: any, id: string) => s?.messageBlocks?.entities?.[id] }
}))

describe('semantic resend/regenerate renderer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    st = {
      messages: { entities: {}, messageIdsByTopic: {} },
      messageBlocks: { entities: {} },
      assistants: { assistants: [] }
    }
    mocks.transformMessagesAndFetch.mockResolvedValue(undefined)
    mocks.selectMessagesForTopic.mockReturnValue([])
  })

  it('resend uses stable IDs only, converges loaded intersection without injecting window-outside members', async () => {
    const { resendMessageThunk } = await import('../messageThunk')
    const u = user()
    const a1 = msg({ id: 'a-1', askId: 'u-1', blocks: ['b-old-1'] })
    // Loaded has user + a1 only; a2 is window-outside in authority.
    st.messages.entities = { 'u-1': u, 'a-1': a1 }
    st.messages.messageIdsByTopic = { 't-1': ['u-1', 'a-1'] }
    st.messageBlocks.entities = { 'b-old-1': { id: 'b-old-1' } }
    const a2 = msg({ id: 'a-2', askId: 'u-1', blocks: [] })
    mocks.resendUserMessages.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      topicId: 't-1',
      askId: 'u-1',
      userMessage: u,
      userBlocks: [{ id: 'bu-1', messageId: 'u-1', type: 'main_text', content: 'hi' }],
      executionMessages: [
        { message: a1, blocks: [] },
        { message: a2, blocks: [] }
      ],
      removedBlockIds: ['b-old-1', 'b-old-2'],
      createdMessageIds: [],
      attempts: [
        { messageId: 'a-1', attemptId: 'att-1' },
        { messageId: 'a-2', attemptId: 'att-2' }
      ]
    })
    const dispatch = vi.fn()
    await resendMessageThunk('t-1', u, { id: 'as-1', model: fullModel(), topics: [], settings: {} } as never)(
      dispatch,
      () => st as never
    )
    expect(mocks.resendUserMessages).toHaveBeenCalledWith({
      topicId: 't-1',
      userMessageId: 'u-1',
      assistantId: 'as-1',
      currentModel: { ...FULL_MODEL }
    })
    // a1 updated (loaded), a2 NOT injected (existing window-outside, not created)
    const types = dispatch.mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types).toContain('update')
    expect(types).not.toContain('add')
    // Only loaded block intersection removed
    const removals = dispatch.mock.calls.filter((c) => (c[0] as { type: string }).type === 'removeBlocks')
    expect(removals).toHaveLength(1)
    expect((removals[0][0] as { p: string[] }).p).toEqual(['b-old-1'])
    // Both executions queued with matching attempts + authority snapshot
    expect(mocks.transformMessagesAndFetch).toHaveBeenCalledTimes(2)
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledTimes(1)
  })

  it('created member injected only when authority user currently loaded', async () => {
    const { resendMessageThunk } = await import('../messageThunk')
    const u = user()
    st.messages.entities = { 'u-1': u }
    st.messages.messageIdsByTopic = { 't-1': ['u-1'] }
    const created = msg({ id: 'a-new', askId: 'u-1' })
    mocks.resendUserMessages.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      topicId: 't-1',
      askId: 'u-1',
      userMessage: u,
      userBlocks: [],
      executionMessages: [{ message: created, blocks: [] }],
      removedBlockIds: [],
      createdMessageIds: ['a-new'],
      attempts: [{ messageId: 'a-new', attemptId: 'att-n' }]
    })
    const dispatch = vi.fn()
    await resendMessageThunk('t-1', u, { id: 'as-1', model: fullModel(), topics: [], settings: {} } as never)(
      dispatch,
      () => st as never
    )
    expect(dispatch.mock.calls.some((c) => (c[0] as { type: string }).type === 'add')).toBe(true)
  })

  it('regenerate passes authority snapshot to converter and toasts NOT_FOUND', async () => {
    const { regenerateAssistantResponseThunk } = await import('../messageThunk')
    const a1 = msg({ id: 'a-1', askId: 'u-1' })
    // User missing from Redux (window-outside), assistant loaded.
    st.messages.entities = { 'a-1': a1 }
    st.messages.messageIdsByTopic = { 't-1': ['a-1'] }
    const au = user()
    mocks.regenerateAssistantMessage.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      topicId: 't-1',
      askId: 'u-1',
      userMessage: au,
      userBlocks: [{ id: 'bu-1', messageId: 'u-1', type: 'main_text', content: 'authority hi' }],
      executionMessages: [{ message: a1, blocks: [] }],
      removedBlockIds: [],
      createdMessageIds: [],
      attempts: [{ messageId: 'a-1', attemptId: 'att-1' }]
    })
    const dispatch = vi.fn()
    await regenerateAssistantResponseThunk('t-1', a1, {
      id: 'as-1',
      model: fullModel(),
      topics: [],
      settings: {}
    } as never)(dispatch, () => st as never)
    expect(mocks.transformMessagesAndFetch).toHaveBeenCalledTimes(1)
    const fetchArg = mocks.transformMessagesAndFetch.mock.calls[0][0] as { authorityUser?: { message: Message } }
    expect(fetchArg.authorityUser?.message.id).toBe('u-1')
    // User still not injected into Redux
    expect(st.messages.entities['u-1']).toBeUndefined()
  })

  it('regenerate self-modelId without assistant model omits currentModel and still executes', async () => {
    const { regenerateAssistantResponseThunk } = await import('../messageThunk')
    // Selected carries truthy modelId; assistant config model missing.
    const a1 = msg({ id: 'a-1', askId: 'u-1', modelId: 'self-model', model: { id: 'self-model' } as never })
    st.messages.entities = { 'a-1': a1 }
    st.messages.messageIdsByTopic = { 't-1': ['a-1'] }
    const au = user()
    mocks.regenerateAssistantMessage.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      topicId: 't-1',
      askId: 'u-1',
      userMessage: au,
      userBlocks: [],
      executionMessages: [{ message: a1, blocks: [] }],
      removedBlockIds: [],
      createdMessageIds: [],
      attempts: [{ messageId: 'a-1', attemptId: 'att-1' }]
    })
    const dispatch = vi.fn()
    await regenerateAssistantResponseThunk('t-1', a1, {
      id: 'as-1',
      model: undefined,
      topics: [],
      settings: {}
    } as never)(dispatch, () => st as never)
    expect(mocks.regenerateAssistantMessage).toHaveBeenCalledTimes(1)
    const req = mocks.regenerateAssistantMessage.mock.calls[0][0] as Record<string, unknown>
    expect(req.topicId).toBe('t-1')
    expect(req.assistantMessageId).toBe('a-1')
    expect('currentModel' in req).toBe(false)
    expect(mocks.transformMessagesAndFetch).toHaveBeenCalledTimes(1)
  })

  it('regenerate without self modelId and without assistant model keeps fail behavior (no call)', async () => {
    const { regenerateAssistantResponseThunk } = await import('../messageThunk')
    const a1 = msg({ id: 'a-1', askId: 'u-1', modelId: '' })
    st.messages.entities = { 'a-1': a1 }
    st.messages.messageIdsByTopic = { 't-1': ['a-1'] }
    const dispatch = vi.fn()
    await regenerateAssistantResponseThunk('t-1', a1, {
      id: 'as-1',
      model: undefined,
      topics: [],
      settings: {}
    } as never)(dispatch, () => st as never)
    expect(mocks.regenerateAssistantMessage).not.toHaveBeenCalled()
    expect(mocks.transformMessagesAndFetch).not.toHaveBeenCalled()
  })

  it('DB failure dispatches nothing and rethrows (resend)', async () => {
    const { resendMessageThunk } = await import('../messageThunk')
    const u = user()
    st.messages.entities = { 'u-1': u }
    st.messages.messageIdsByTopic = { 't-1': ['u-1'] }
    mocks.resendUserMessages.mockRejectedValue(new Error('db down'))
    const dispatch = vi.fn()
    await expect(
      resendMessageThunk('t-1', u, { id: 'as-1', model: fullModel(), topics: [], settings: {} } as never)(
        dispatch,
        () => st as never
      )
    ).rejects.toThrow('db down')
    expect(
      dispatch.mock.calls.filter((c) => ['add', 'update', 'removeBlocks'].includes((c[0] as { type: string }).type))
    ).toHaveLength(0)
    expect(mocks.transformMessagesAndFetch).not.toHaveBeenCalled()
    expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
  })

  it('resend id-only model fails closed without DB call (no forgery)', async () => {
    const { resendMessageThunk, toSemanticModelSnapshot } = await import('../messageThunk')
    expect(toSemanticModelSnapshot({ id: 'm1' })).toBeNull()
    expect(toSemanticModelSnapshot({ id: 'm1', provider: 'p', name: 'n', group: '' })).toBeNull()
    const u = user()
    st.messages.entities = { 'u-1': u }
    st.messages.messageIdsByTopic = { 't-1': ['u-1'] }
    const dispatch = vi.fn()
    await expect(
      resendMessageThunk('t-1', u, { id: 'as-1', model: { id: 'm1' }, topics: [], settings: {} } as never)(
        dispatch,
        () => st as never
      )
    ).rejects.toThrow('not configured for resend')
    expect(mocks.resendUserMessages).not.toHaveBeenCalled()
    expect(mocks.transformMessagesAndFetch).not.toHaveBeenCalled()
  })

  it('resend passes full+extra snapshot verbatim without forging', async () => {
    const { resendMessageThunk, toSemanticModelSnapshot } = await import('../messageThunk')
    const extra = { ...fullModel(), capabilities: [{ type: 'vision' }], pricing: { input: 1 } }
    expect(toSemanticModelSnapshot(extra)).toEqual(extra)
    const u = user()
    st.messages.entities = { 'u-1': u }
    st.messages.messageIdsByTopic = { 't-1': ['u-1'] }
    const created = msg({ id: 'a-new', askId: 'u-1' })
    mocks.resendUserMessages.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      topicId: 't-1',
      askId: 'u-1',
      userMessage: u,
      userBlocks: [],
      executionMessages: [{ message: created, blocks: [] }],
      removedBlockIds: [],
      createdMessageIds: ['a-new'],
      attempts: [{ messageId: 'a-new', attemptId: 'att-n' }]
    })
    const dispatch = vi.fn()
    await resendMessageThunk('t-1', u, { id: 'as-1', model: extra, topics: [], settings: {} } as never)(
      dispatch,
      () => st as never
    )
    expect(mocks.resendUserMessages).toHaveBeenCalledWith({
      topicId: 't-1',
      userMessageId: 'u-1',
      assistantId: 'as-1',
      currentModel: extra
    })
  })

  it('regenerate partial model without self modelId fails closed (no call, no forgery)', async () => {
    const { regenerateAssistantResponseThunk } = await import('../messageThunk')
    const a1 = msg({ id: 'a-1', askId: 'u-1', modelId: '' })
    st.messages.entities = { 'a-1': a1 }
    st.messages.messageIdsByTopic = { 't-1': ['a-1'] }
    const dispatch = vi.fn()
    await regenerateAssistantResponseThunk('t-1', a1, {
      id: 'as-1',
      model: { id: 'm1' },
      topics: [],
      settings: {}
    } as never)(dispatch, () => st as never)
    expect(mocks.regenerateAssistantMessage).not.toHaveBeenCalled()
    expect(mocks.transformMessagesAndFetch).not.toHaveBeenCalled()
  })

  it('regenerate partial model with self modelId omits currentModel (self-model path, no forgery)', async () => {
    const { regenerateAssistantResponseThunk } = await import('../messageThunk')
    const a1 = msg({ id: 'a-1', askId: 'u-1', modelId: 'self-model', model: { id: 'self-model' } as never })
    st.messages.entities = { 'a-1': a1 }
    st.messages.messageIdsByTopic = { 't-1': ['a-1'] }
    const au = user()
    mocks.regenerateAssistantMessage.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      topicId: 't-1',
      askId: 'u-1',
      userMessage: au,
      userBlocks: [],
      executionMessages: [{ message: a1, blocks: [] }],
      removedBlockIds: [],
      createdMessageIds: [],
      attempts: [{ messageId: 'a-1', attemptId: 'att-1' }]
    })
    const dispatch = vi.fn()
    await regenerateAssistantResponseThunk('t-1', a1, {
      id: 'as-1',
      model: { id: 'partial-only' },
      topics: [],
      settings: {}
    } as never)(dispatch, () => st as never)
    expect(mocks.regenerateAssistantMessage).toHaveBeenCalledTimes(1)
    const req = mocks.regenerateAssistantMessage.mock.calls[0][0] as Record<string, unknown>
    expect('currentModel' in req).toBe(false)
  })

  it('regenerate passes full snapshot when configured', async () => {
    const { regenerateAssistantResponseThunk } = await import('../messageThunk')
    const a1 = msg({ id: 'a-1', askId: 'u-1', modelId: '' })
    st.messages.entities = { 'a-1': a1 }
    st.messages.messageIdsByTopic = { 't-1': ['a-1'] }
    const au = user()
    mocks.regenerateAssistantMessage.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      topicId: 't-1',
      askId: 'u-1',
      userMessage: au,
      userBlocks: [],
      executionMessages: [{ message: a1, blocks: [] }],
      removedBlockIds: [],
      createdMessageIds: [],
      attempts: [{ messageId: 'a-1', attemptId: 'att-1' }]
    })
    const dispatch = vi.fn()
    await regenerateAssistantResponseThunk('t-1', a1, {
      id: 'as-1',
      model: fullModel(),
      topics: [],
      settings: {}
    } as never)(dispatch, () => st as never)
    expect(mocks.regenerateAssistantMessage).toHaveBeenCalledWith({
      topicId: 't-1',
      assistantMessageId: 'a-1',
      assistantId: 'as-1',
      currentModel: { ...FULL_MODEL }
    })
  })
})
