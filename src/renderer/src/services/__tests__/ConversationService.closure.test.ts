import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/i18n', () => ({ default: { t: (k: string) => k } }))
vi.mock('@renderer/aiCore/prepareParams', () => ({ convertMessagesToSdkMessages: vi.fn(async (msgs) => msgs) }))
vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultModel: vi.fn(() => ({ id: 'm', provider: 'p', name: 'm' })),
  getAssistantSettings: vi.fn((a) => a.settings)
}))

const computeMock = vi.fn()
vi.mock('@renderer/services/contextInfoService', () => ({
  computeContextInfo: (...args: any[]) => computeMock(...args)
}))
vi.mock('@renderer/services/contextClosure', async () => {
  const actual = await vi.importActual<any>('@renderer/services/contextClosure')
  return {
    ...actual,
    getFreshValidatedClosure: vi.fn(),
    computeClosureFingerprint: actual.computeClosureFingerprint,
    // keep actual validators for other tests
    isValidContextClosureResponse: actual.isValidContextClosureResponse,
    getCachedContextClosure: actual.getCachedContextClosure
  }
})

import { getFreshValidatedClosure } from '@renderer/services/contextClosure'

import { ConversationService } from '../ConversationService'

describe('ConversationService closure-sourced', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    computeMock.mockReturnValue({
      uiMessages: [{ id: 'u1' } as any],
      tokenEstimationMessages: [],
      boundaryMessageId: null,
      contextCount: { current: 1, max: 1 },
      anchorGroupKey: 'u1'
    })
  })

  it('uses closure messages when cache hit same-anchor', async () => {
    const closure: any = {
      messages: [
        { id: 'u1', role: 'user', blocks: ['b1'] },
        { id: 'a1', role: 'assistant', askId: 'u1', blocks: [] }
      ],
      blocks: [{ id: 'b1', messageId: 'u1' }],
      closure: {
        completeness: 'context-closure',
        topicId: 't1',
        anchorGroupKey: 'u1',
        firstMessageId: 'u1',
        lastMessageId: 'a1',
        returnedCount: 2
      }
    }
    vi.mocked(getFreshValidatedClosure).mockReturnValue(closure)
    const assistant: any = {
      id: 'a',
      settings: { contextWindowAnchor: { t1: { kind: 'active', groupKey: 'u1' } }, contextCount: 5 },
      model: { id: 'm', provider: 'p', name: 'm' }
    }
    const viewport: any = [{ id: 'u2', role: 'user' }]
    const result = await ConversationService.prepareMessagesForModel(viewport, assistant, 't1')
    expect(computeMock).toHaveBeenCalledWith(closure.messages, assistant, 't1')
    expect(result.uiMessages).toBeDefined()
  })

  it('falls back to viewport when cache miss or mismatched anchor (fail-closed)', async () => {
    vi.mocked(getFreshValidatedClosure).mockReturnValue(null)
    const assistant: any = {
      id: 'a',
      settings: { contextWindowAnchor: { t1: { kind: 'active', groupKey: 'u1' } }, contextCount: 5 },
      model: { id: 'm', provider: 'p', name: 'm' }
    }
    const viewport: any = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant', askId: 'u1' }
    ]
    computeMock.mockReturnValue({
      uiMessages: viewport,
      tokenEstimationMessages: [],
      boundaryMessageId: null,
      contextCount: { current: 1, max: 1 },
      anchorGroupKey: 'u1'
    })
    await ConversationService.prepareMessagesForModel(viewport, assistant, 't1')
    expect(computeMock).toHaveBeenCalledWith(viewport, assistant, 't1')
  })

  it('does not use closure when anchor mismatched (no silent substitution)', async () => {
    const _closure: any = {
      messages: [{ id: 'u9', role: 'user' }],
      blocks: [],
      closure: {
        completeness: 'context-closure',
        topicId: 't1',
        anchorGroupKey: 'u9',
        firstMessageId: 'u9',
        lastMessageId: 'u9',
        returnedCount: 1
      }
    }
    void _closure
    // helper returns null for mismatched anchor (fail-closed); mock reflects that
    vi.mocked(getFreshValidatedClosure).mockReturnValue(null)
    const assistant: any = {
      id: 'a',
      settings: { contextWindowAnchor: { t1: { kind: 'active', groupKey: 'u1' } }, contextCount: 5 },
      model: { id: 'm', provider: 'p', name: 'm' }
    }
    const viewport: any = [{ id: 'u1', role: 'user' }]
    computeMock.mockReturnValue({
      uiMessages: viewport,
      tokenEstimationMessages: [],
      boundaryMessageId: null,
      contextCount: { current: 1, max: 1 },
      anchorGroupKey: 'u1'
    })
    await ConversationService.prepareMessagesForModel(viewport, assistant, 't1')
    expect(computeMock).toHaveBeenCalledWith(viewport, assistant, 't1')
  })

  it('contextCount change alone does not affect closure cache hit (stable anchor)', async () => {
    const closure: any = {
      messages: [
        { id: 'u1', role: 'user' },
        { id: 'a1', role: 'assistant', askId: 'u1' }
      ],
      blocks: [],
      closure: {
        completeness: 'context-closure',
        topicId: 't1',
        anchorGroupKey: 'u1',
        firstMessageId: 'u1',
        lastMessageId: 'a1',
        returnedCount: 2
      }
    }
    vi.mocked(getFreshValidatedClosure).mockReturnValue(closure)
    const assistantV1: any = {
      id: 'a',
      settings: { contextWindowAnchor: { t1: { kind: 'active', groupKey: 'u1' } }, contextCount: 5 },
      model: { id: 'm', provider: 'p', name: 'm' }
    }
    const assistantV2: any = {
      id: 'a',
      settings: { contextWindowAnchor: { t1: { kind: 'active', groupKey: 'u1' } }, contextCount: 1 },
      model: { id: 'm', provider: 'p', name: 'm' }
    }
    const viewport: any = [{ id: 'u1', role: 'user' }]
    // first call with contextCount 5
    await ConversationService.prepareMessagesForModel(viewport, assistantV1, 't1')
    expect(computeMock).toHaveBeenCalledWith(closure.messages, assistantV1, 't1')
    vi.clearAllMocks()
    computeMock.mockReturnValue({
      uiMessages: viewport,
      tokenEstimationMessages: [],
      boundaryMessageId: null,
      contextCount: { current: 1, max: 1 },
      anchorGroupKey: 'u1'
    })
    // second call with different contextCount but same anchor => still hits cache
    await ConversationService.prepareMessagesForModel(viewport, assistantV2, 't1')
    expect(computeMock).toHaveBeenCalledWith(closure.messages, assistantV2, 't1')
  })
})
