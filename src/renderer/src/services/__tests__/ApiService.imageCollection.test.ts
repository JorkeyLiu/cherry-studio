/**
 * ApiService image collection tests (LOCK-UI-2).
 *
 * Covers `collectImagesFromMessages` (the generation-input image collector):
 * - A degraded imported image block (l2AttachmentUnavailable === true) is
 *   SKIPPED before the file:base64Image IPC — no IPC attempt, no url reuse —
 *   and is therefore omitted from the generation input.
 * - Healthy file-backed and url-backed (generated) blocks keep their current
 *   behavior unchanged.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { ImageMessageBlock, Message } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks for ApiService's heavy module graph (only the default store is real,
// mirroring LocalTokenEstimator.test.ts so findImageBlocks resolves blocks).
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

vi.mock('@renderer/config/models', () => ({
  isDedicatedImageGenerationModel: vi.fn(() => false),
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
  AiProvider: class MockAiProvider {}
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultAssistant: vi.fn(),
  getDefaultModel: vi.fn(),
  getProviderByModel: vi.fn(),
  getQuickModel: vi.fn()
}))

vi.mock('@renderer/services/ConversationService', () => ({
  ConversationService: { prepareMessagesForModel: vi.fn() }
}))

vi.mock('@renderer/services/KnowledgeService', () => ({
  injectUserMessageWithKnowledgeSearchPrompt: vi.fn()
}))

// `@renderer/utils/analytics` imports the real ProviderService, which drags in
// the real useStore → config/providers → config/models chain; mock it so the
// (unused-in-this-test) provider lookups never load that graph.
vi.mock('@renderer/services/ProviderService', () => ({
  getProviderById: vi.fn()
}))

import { collectImagesFromMessages } from '../ApiService'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const base64ImageMock = vi.fn()

let blockCounter = 0

const createFile = (overrides: Partial<FileMetadata> = {}): FileMetadata =>
  ({
    id: `file-${++blockCounter}`,
    name: 'photo.png',
    origin_name: 'photo.png',
    path: '/storage/photo.png',
    size: 10,
    ext: '.png',
    type: FILE_TYPE.IMAGE,
    count: 1,
    created_at: '2026-07-30T00:00:00.000Z',
    ...overrides
  }) as FileMetadata

const makeImageBlock = (overrides: Partial<ImageMessageBlock> = {}): ImageMessageBlock =>
  ({
    id: `image-block-${++blockCounter}`,
    messageId: 'message-1',
    type: MessageBlockType.IMAGE,
    status: MessageBlockStatus.SUCCESS,
    createdAt: '2026-07-30T00:00:00.000Z',
    ...overrides
  }) as ImageMessageBlock

/** Builds a message and injects its blocks into the mock store */
const makeMessage = (
  id: string,
  blocks: Array<Record<string, unknown> | ImageMessageBlock>,
  role: 'user' | 'assistant' = 'user'
): Message => {
  for (const block of blocks) {
    mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock({ ...block, messageId: id } as never))
  }
  return {
    id,
    role,
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-07-30T00:00:00.000Z',
    status: UserMessageStatus.SUCCESS,
    blocks: blocks.map((b) => b.id as string)
  } as Message
}

beforeEach(() => {
  mockStore = createMockStore()
  blockCounter = 0
  base64ImageMock.mockReset()
  base64ImageMock.mockResolvedValue({ data: 'data:image/png;base64,HEALTHY' })
  vi.stubGlobal('api', {
    file: {
      base64Image: base64ImageMock
    }
  })
})

describe('collectImagesFromMessages — degraded imported images (LOCK-UI-2)', () => {
  it('omits a marked user image block and never calls file:base64Image for it', async () => {
    const markedFile = createFile({ id: 'degraded', name: 'missing.png', origin_name: 'missing.png' })
    const healthyFile = createFile({ id: 'healthy', name: 'ok.png', origin_name: 'ok.png' })
    const userMessage = makeMessage('m-user', [
      makeImageBlock({ id: 'b-marked', l2AttachmentUnavailable: true, file: markedFile }),
      makeImageBlock({ id: 'b-healthy', file: healthyFile })
    ])

    const images = await collectImagesFromMessages(userMessage)

    expect(images).toEqual(['data:image/png;base64,HEALTHY'])
    // Only the healthy block reached the base64Image IPC — the marked block
    // was skipped before any IPC attempt.
    expect(base64ImageMock).toHaveBeenCalledTimes(1)
    expect(base64ImageMock).toHaveBeenCalledWith('ok.png')
    expect(base64ImageMock).not.toHaveBeenCalledWith('missing.png')
  })

  it('omits marked assistant image blocks (file-backed AND url-backed) without IPC or url reuse', async () => {
    const markedFile = createFile({ id: 'degraded', name: 'missing.png', origin_name: 'missing.png' })
    const healthyFile = createFile({ id: 'healthy', name: 'ok.png', origin_name: 'ok.png' })
    const userMessage = makeMessage('m-user', [makeImageBlock({ id: 'b-empty' })])
    const assistantMessage = makeMessage(
      'm-assistant',
      [
        makeImageBlock({ id: 'b-marked-file', l2AttachmentUnavailable: true, file: markedFile }),
        makeImageBlock({ id: 'b-marked-url', l2AttachmentUnavailable: true, url: 'https://example.com/missing.png' }),
        makeImageBlock({ id: 'b-healthy-file', file: healthyFile }),
        makeImageBlock({ id: 'b-url', url: 'https://example.com/generated.png' })
      ],
      'assistant'
    )

    const images = await collectImagesFromMessages(userMessage, assistantMessage)

    // The healthy file data + the healthy url; the two marked blocks are gone.
    expect(images).toEqual(['data:image/png;base64,HEALTHY', 'https://example.com/generated.png'])
    expect(base64ImageMock).toHaveBeenCalledTimes(1)
    expect(base64ImageMock).toHaveBeenCalledWith('ok.png')
    expect(base64ImageMock).not.toHaveBeenCalledWith('missing.png')
  })

  it('keeps the healthy path unchanged when no marker is present', async () => {
    const firstFile = createFile({ id: 'f1', name: 'one.png', origin_name: 'one.png' })
    const secondFile = createFile({ id: 'f2', name: 'two.png', origin_name: 'two.png' })
    const userMessage = makeMessage('m-user', [
      makeImageBlock({ id: 'b-1', file: firstFile }),
      makeImageBlock({ id: 'b-2', file: secondFile })
    ])

    const images = await collectImagesFromMessages(userMessage)

    expect(images).toEqual(['data:image/png;base64,HEALTHY', 'data:image/png;base64,HEALTHY'])
    expect(base64ImageMock).toHaveBeenCalledTimes(2)
    expect(base64ImageMock).toHaveBeenNthCalledWith(1, 'one.png')
    expect(base64ImageMock).toHaveBeenNthCalledWith(2, 'two.png')
  })

  it('keeps the healthy path unchanged when the marker is explicitly false', async () => {
    const healthyFile = createFile({ id: 'healthy', name: 'ok.png', origin_name: 'ok.png' })
    const userMessage = makeMessage('m-user', [
      makeImageBlock({ id: 'b-false', l2AttachmentUnavailable: false, file: healthyFile })
    ])

    const images = await collectImagesFromMessages(userMessage)

    expect(images).toEqual(['data:image/png;base64,HEALTHY'])
    expect(base64ImageMock).toHaveBeenCalledTimes(1)
    expect(base64ImageMock).toHaveBeenCalledWith('ok.png')
  })

  it('returns an empty collection when every image block is marked (no IPC at all)', async () => {
    const markedFile = createFile({ id: 'degraded', name: 'missing.png', origin_name: 'missing.png' })
    const userMessage = makeMessage('m-user', [
      makeImageBlock({ id: 'b-marked', l2AttachmentUnavailable: true, file: markedFile })
    ])

    const images = await collectImagesFromMessages(userMessage)

    expect(images).toEqual([])
    expect(base64ImageMock).not.toHaveBeenCalled()
  })
})
