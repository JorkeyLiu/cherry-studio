/**
 * Media-context switch on the dedicated image-generation path
 * (`transformMessagesAndFetch` → `fetchImageGeneration` → `collectImagesFromMessages`).
 *
 * That path reads image blocks straight from the prepared request view instead
 * of going through the SDK converter, so it must apply the very same
 * request-local attachment filter. Regression scope:
 *  - with the switch OFF, a historical assistant image (local file AND url-only)
 *    is omitted from the edit input and no historical file is read;
 *  - the current triggering turn's images are always collected;
 *  - with the switch ON, the historical assistant image is collected as before;
 *  - the filter resolved by request preparation reaches the dedicated send.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import type { RequestAttachmentFilter } from '@renderer/services/requestAttachmentAvailability'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import type { Assistant, FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { FileMessageBlock, ImageMessageBlock, Message } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Store (real message-block slice so findImageBlocks resolves blocks)
// ---------------------------------------------------------------------------
const reducer = combineReducers({
  messageBlocks: messageBlocksSlice.reducer
})

const createMockStore = () =>
  configureStore({
    reducer,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

let mockStore: ReturnType<typeof createMockStore>

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mockStore.getState(),
    dispatch: (action: unknown) => mockStore.dispatch(action as never)
  }
}))

vi.mock('@renderer/store/mcp', () => ({
  hubMCPServer: { id: 'hub', type: 'builtin', name: 'hub', baseUrl: '' }
}))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

/** Signature of the AiProvider.editImage call the dedicated path makes. */
type EditImageParams = { model: string; prompt: string; inputImages: string[]; imageSize: string }

const { isDedicatedImageGenerationModelMock, prepareMessagesMock, editImageMock, generateImageMock } = vi.hoisted(
  () => ({
    isDedicatedImageGenerationModelMock: vi.fn(() => false),
    prepareMessagesMock: vi.fn(),
    // Typed call signature with no unused parameter: the call arguments are
    // asserted through `editInputImages()` below.
    editImageMock: vi.fn<(...args: [EditImageParams]) => Promise<string[]>>(async () => [
      'data:image/png;base64,EDITED'
    ]),
    generateImageMock: vi.fn(async () => ['data:image/png;base64,GENERATED'])
  })
)

vi.mock('@renderer/config/models', () => ({
  isDedicatedImageGenerationModel: isDedicatedImageGenerationModelMock,
  isEmbeddingModel: vi.fn(() => false),
  isFunctionCallingModel: vi.fn(() => false)
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  getStoreSetting: vi.fn()
}))

vi.mock('@renderer/aiCore/prepareParams', () => ({
  buildStreamTextParams: vi.fn()
}))

vi.mock('@renderer/aiCore/utils/options', () => ({
  buildProviderOptions: vi.fn()
}))

vi.mock('@renderer/aiCore', () => ({
  AiProvider: class MockAiProvider {
    editImage = editImageMock
    generateImage = generateImageMock
    getActualProvider = () => ({ id: 'provider-1' })
  }
}))

const { getDefaultModelMock, getProviderByModelMock } = vi.hoisted(() => ({
  getDefaultModelMock: vi.fn(),
  getProviderByModelMock: vi.fn()
}))

vi.mock('@renderer/services/AssistantService', () => ({
  createEphemeralAssistant: vi.fn((init: unknown) => ({ id: 'ephemeral-test', settings: {}, ...(init as object) })),
  getDefaultModel: getDefaultModelMock,
  getProviderByModel: getProviderByModelMock,
  getQuickModel: vi.fn()
}))

vi.mock('@renderer/services/ConversationService', () => ({
  ConversationService: { prepareMessagesForModel: prepareMessagesMock }
}))

vi.mock('@renderer/services/KnowledgeService', () => ({
  injectUserMessageWithKnowledgeSearchPrompt: vi.fn()
}))

vi.mock('@renderer/services/ProviderService', () => ({
  getProviderById: vi.fn()
}))

import { collectImagesFromMessages, fetchImageGeneration, transformMessagesAndFetch } from '../ApiService'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const base64ImageMock = vi.fn()
const TS = '2026-01-01T00:00:00.000Z'
let seq = 0

const MODEL = { id: 'img-model', provider: 'provider-1', name: 'img', group: 'g' } as any
const PROVIDER = { id: 'provider-1', type: 'openai', apiKey: 'k' } as any

const createFile = (overrides: Partial<FileMetadata> = {}): FileMetadata => {
  const id = overrides.id ?? `file-${++seq}`
  const ext = overrides.ext ?? '.png'
  return {
    id,
    name: `${id}${ext}`,
    origin_name: `${id}${ext}`,
    path: `/managed/files/${id}${ext}`,
    size: 10,
    ext,
    type: FILE_TYPE.IMAGE,
    count: 1,
    created_at: TS,
    ...overrides
  } as FileMetadata
}

const makeImageBlock = (overrides: Partial<ImageMessageBlock> = {}): ImageMessageBlock =>
  ({
    id: `image-${++seq}`,
    messageId: 'message-1',
    type: MessageBlockType.IMAGE,
    status: MessageBlockStatus.SUCCESS,
    createdAt: TS,
    ...overrides
  }) as ImageMessageBlock

const makeTextBlock = (messageId: string, content: string) =>
  ({
    id: `text-${++seq}`,
    messageId,
    type: MessageBlockType.MAIN_TEXT,
    content,
    status: MessageBlockStatus.SUCCESS,
    createdAt: TS
  }) as unknown as FileMessageBlock

/** Registers blocks in the store and returns the message referencing them. */
const makeMessage = (id: string, blocks: Array<Record<string, any>>, role: 'user' | 'assistant' = 'user'): Message => {
  for (const block of blocks) {
    mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock({ ...block, messageId: id } as never))
  }
  return {
    id,
    role,
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: TS,
    status: UserMessageStatus.SUCCESS,
    blocks: blocks.map((b) => b.id as string)
  } as Message
}

/**
 * Request view: historical assistant message that mixes text with a LOCAL-FILE
 * generated image and a URL-only generated image, plus the current triggering
 * user message carrying its own local-file input image.
 */
function buildConversation() {
  const historyText = makeTextBlock('a1', 'here is your image')
  const historyFileImage = makeImageBlock({ file: createFile({ id: 'history-file-image' }) })
  const historyUrlImage = makeImageBlock({ url: 'https://example.com/history-generated.png' })
  const historyAssistant = makeMessage('a1', [historyText, historyFileImage, historyUrlImage], 'assistant')

  const triggerText = makeTextBlock('u2', 'make it blue')
  const triggerFileImage = makeImageBlock({ file: createFile({ id: 'trigger-image' }) })
  const triggerUser = makeMessage('u2', [triggerText, triggerFileImage], 'user')

  return { historyAssistant, historyFileImage, historyUrlImage, triggerUser, triggerFileImage }
}

const assistantWithModel = (): Assistant =>
  ({ id: 'asst-1', prompt: '', model: MODEL, settings: {} }) as unknown as Assistant

const filterWith = (excluded: string[]): RequestAttachmentFilter => ({
  unavailableBlockIds: new Set(excluded),
  urlFallbackBlockIds: new Set<string>()
})

const ON_FILTER = filterWith([])

/** `inputImages` of the most recent `editImage` call. */
const editInputImages = (): string[] => editImageMock.mock.calls.at(-1)?.[0].inputImages ?? []

beforeEach(() => {
  mockStore = createMockStore()
  seq = 0
  base64ImageMock.mockReset()
  isDedicatedImageGenerationModelMock.mockReset()
  isDedicatedImageGenerationModelMock.mockReturnValue(false)
  prepareMessagesMock.mockReset()
  editImageMock.mockClear()
  generateImageMock.mockClear()
  getDefaultModelMock.mockReturnValue(MODEL)
  getProviderByModelMock.mockReturnValue(PROVIDER)
  // Distinct payload per stored name identifies which block was read.
  base64ImageMock.mockImplementation(async (storedName: string) => ({ data: `DATA:${storedName}` }))
  vi.stubGlobal('api', { file: { base64Image: base64ImageMock } })
})

describe('collectImagesFromMessages — request-local attachment filter', () => {
  it('ON (empty filter) collects the historical assistant images and the current input image', async () => {
    const { historyAssistant, triggerUser } = buildConversation()

    const images = await collectImagesFromMessages(triggerUser, historyAssistant, ON_FILTER)

    expect(images).toEqual([
      'DATA:trigger-image.png',
      'DATA:history-file-image.png',
      'https://example.com/history-generated.png'
    ])
  })

  it('OFF omits the historical assistant images (local file not read, url not reused) and keeps the current input image', async () => {
    const { historyAssistant, historyFileImage, historyUrlImage, triggerUser } = buildConversation()

    const images = await collectImagesFromMessages(
      triggerUser,
      historyAssistant,
      filterWith([historyFileImage.id, historyUrlImage.id])
    )

    expect(images).toEqual(['DATA:trigger-image.png'])
    expect(base64ImageMock).toHaveBeenCalledTimes(1)
    expect(base64ImageMock).toHaveBeenCalledWith('trigger-image.png')
    expect(base64ImageMock).not.toHaveBeenCalledWith('history-file-image.png')
  })
})

describe('fetchImageGeneration — dedicated send honors the request filter', () => {
  it('ON passes the historical image and the current input image as edit input', async () => {
    const { historyAssistant, triggerUser } = buildConversation()

    await fetchImageGeneration({
      messages: [historyAssistant, triggerUser],
      assistant: assistantWithModel(),
      onChunkReceived: vi.fn(),
      attachmentFilter: ON_FILTER
    })

    expect(editImageMock).toHaveBeenCalledTimes(1)
    expect(editInputImages()).toEqual([
      'DATA:trigger-image.png',
      'DATA:history-file-image.png',
      'https://example.com/history-generated.png'
    ])
  })

  it('OFF sends only the current input image to editImage and reads no historical file', async () => {
    const { historyAssistant, historyFileImage, historyUrlImage, triggerUser } = buildConversation()

    await fetchImageGeneration({
      messages: [historyAssistant, triggerUser],
      assistant: assistantWithModel(),
      onChunkReceived: vi.fn(),
      attachmentFilter: filterWith([historyFileImage.id, historyUrlImage.id])
    })

    expect(editImageMock).toHaveBeenCalledTimes(1)
    expect(editInputImages()).toEqual(['DATA:trigger-image.png'])
    expect(base64ImageMock).toHaveBeenCalledTimes(1)
    expect(base64ImageMock).toHaveBeenCalledWith('trigger-image.png')
  })
})

describe('transformMessagesAndFetch — dedicated branch threading', () => {
  it('forwards the filter resolved by request preparation into the dedicated send', async () => {
    isDedicatedImageGenerationModelMock.mockReturnValue(true)
    const { historyAssistant, historyFileImage, historyUrlImage, triggerUser } = buildConversation()
    prepareMessagesMock.mockResolvedValue({
      modelMessages: [],
      uiMessages: [historyAssistant, triggerUser],
      attachmentFilter: filterWith([historyFileImage.id, historyUrlImage.id])
    })

    await transformMessagesAndFetch(
      {
        messages: [historyAssistant, triggerUser],
        assistant: assistantWithModel(),
        blockManager: {} as any,
        assistantMsgId: 'assistant-msg-1',
        callbacks: {} as any,
        topicId: 'topic-1',
        options: {}
      },
      vi.fn()
    )

    expect(editImageMock).toHaveBeenCalledTimes(1)
    expect(editInputImages()).toEqual(['DATA:trigger-image.png'])
    expect(base64ImageMock).not.toHaveBeenCalledWith('history-file-image.png')
  })

  it('keeps the dedicated send unchanged when preparation excludes nothing', async () => {
    isDedicatedImageGenerationModelMock.mockReturnValue(true)
    const { historyAssistant, triggerUser } = buildConversation()
    prepareMessagesMock.mockResolvedValue({
      modelMessages: [],
      uiMessages: [historyAssistant, triggerUser],
      attachmentFilter: ON_FILTER
    })

    await transformMessagesAndFetch(
      {
        messages: [historyAssistant, triggerUser],
        assistant: assistantWithModel(),
        blockManager: {} as any,
        assistantMsgId: 'assistant-msg-2',
        callbacks: {} as any,
        topicId: 'topic-1',
        options: {}
      },
      vi.fn()
    )

    expect(editInputImages()).toEqual([
      'DATA:trigger-image.png',
      'DATA:history-file-image.png',
      'https://example.com/history-generated.png'
    ])
  })
})
