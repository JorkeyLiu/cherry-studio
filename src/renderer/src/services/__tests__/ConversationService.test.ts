import type { Assistant, Model } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { NO_MODEL_ERROR_NAME } from '@renderer/utils/noModelError'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

vi.mock('@renderer/aiCore/prepareParams', () => ({
  convertMessagesToSdkMessages: vi.fn(async () => [])
}))

vi.mock('@renderer/services/contextInfoService', () => ({
  computeContextInfo: vi.fn(() => ({
    uiMessages: [],
    tokenEstimationMessages: [],
    boundaryMessageId: null,
    contextCount: { current: 0, max: null }
  }))
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultModel: vi.fn()
}))

import { convertMessagesToSdkMessages } from '@renderer/aiCore/prepareParams'
import { getDefaultModel } from '@renderer/services/AssistantService'
import { computeContextInfo } from '@renderer/services/contextInfoService'

import { ConversationService } from '../ConversationService'

const userMessage = { id: 'm-user', role: 'user', content: 'hello' } as unknown as Message
const assistant = { id: 'assistant-1', name: 'assistant', model: undefined } as unknown as Assistant

describe('ConversationService.prepareMessagesForModel — no-model branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getDefaultModel).mockReset()
    vi.mocked(getDefaultModel).mockReturnValue(undefined)
  })

  it('returns empty messages when there is no user message (baseline preserved)', async () => {
    const result = await ConversationService.prepareMessagesForModel([], assistant)
    expect(result).toEqual({ modelMessages: [], uiMessages: [] })
    expect(getDefaultModel).not.toHaveBeenCalled()
  })

  it('rejects with the stable NoModelError marker when no assistant model and no default model exist', async () => {
    const promise = ConversationService.prepareMessagesForModel([userMessage], assistant)
    await expect(promise).rejects.toMatchObject({ name: NO_MODEL_ERROR_NAME })
    // The failure must happen before any provider/API/serialization work.
    expect(convertMessagesToSdkMessages).not.toHaveBeenCalled()
  })

  it('rejects with the stable NoModelError marker even when computeContextInfo has already run', async () => {
    vi.mocked(computeContextInfo).mockReturnValue({
      uiMessages: [{ id: 'm-user', role: 'user', content: 'hello' } as unknown as Message],
      tokenEstimationMessages: [],
      boundaryMessageId: null,
      contextCount: { current: 0, max: null }
    })
    await expect(ConversationService.prepareMessagesForModel([userMessage], assistant)).rejects.toMatchObject({
      name: NO_MODEL_ERROR_NAME
    })
  })

  it('proceeds when the assistant selects a model', async () => {
    const selectedModel = { id: 'gpt-4', name: 'gpt-4', provider: 'openai' } as Model
    const assistantWithModel = { ...assistant, model: selectedModel } as unknown as Assistant

    const result = await ConversationService.prepareMessagesForModel([userMessage], assistantWithModel)

    expect(convertMessagesToSdkMessages).toHaveBeenCalledWith([userMessage], selectedModel)
    expect(result.uiMessages).toEqual([userMessage])
  })
})
