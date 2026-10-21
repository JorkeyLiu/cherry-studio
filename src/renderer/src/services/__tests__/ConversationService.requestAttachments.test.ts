import type { Assistant, FileMetadata } from '@renderer/types'
import type { FileMessageBlock, ImageMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import {
  AssistantMessageStatus,
  MessageBlockStatus,
  MessageBlockType,
  UserMessageStatus
} from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchClosureMock, getSettingsMock, getDefaultModelMock, blockEntities, existsMock, base64ImageMock } =
  vi.hoisted(() => ({
    fetchClosureMock: vi.fn(),
    getSettingsMock: vi.fn(),
    getDefaultModelMock: vi.fn(() => ({ id: 'm', provider: 'p', name: 'm', group: 'g' }) as any),
    blockEntities: {} as Record<string, any>,
    existsMock: vi.fn(),
    base64ImageMock: vi.fn()
  }))

vi.mock('@renderer/i18n', () => ({ default: { t: (k: string) => k } }))
vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      settings: { injectContextTimestamp: false },
      messageBlocks: { entities: blockEntities },
      messages: { entities: {}, messageIdsByTopic: {} }
    }),
    dispatch: vi.fn()
  }
}))
vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultModel: getDefaultModelMock,
  getAssistantSettings: (...args: any[]) => getSettingsMock(...args),
  getProviderByModel: () => ({ id: 'p', type: 'openai' }) as any
}))
vi.mock('@renderer/services/db', () => ({
  dbService: { fetchContextClosure: (...args: any[]) => fetchClosureMock(...args) }
}))

import { ConversationService } from '../ConversationService'

const TS = '2026-01-01T00:00:00.000Z'

let blockSeq = 0

function mainTextBlock(messageId: string, content: string): MessageBlock {
  const id = `text-${++blockSeq}`
  return {
    id,
    messageId,
    type: MessageBlockType.MAIN_TEXT,
    content,
    createdAt: TS,
    updatedAt: TS,
    status: MessageBlockStatus.SUCCESS
  } as unknown as MessageBlock
}

function storedFile(overrides: Partial<FileMetadata> = {}): FileMetadata {
  const id = overrides.id ?? `file-${++blockSeq}`
  const ext = overrides.ext ?? '.png'
  return {
    id,
    origin_name: overrides.origin_name ?? `${id}${ext}`,
    name: overrides.name ?? `${id}${ext}`,
    // Canonical managed identity: `path` ends with `id + ext`.
    path: overrides.path ?? `/managed/files/${id}${ext}`,
    created_at: TS,
    size: overrides.size ?? 1024,
    ext,
    type: overrides.type ?? 'image',
    count: 1,
    ...overrides
  } as unknown as FileMetadata
}

function imageBlock(
  messageId: string,
  file: FileMetadata | undefined,
  extra: Partial<ImageMessageBlock> = {}
): ImageMessageBlock {
  const id = extra.id ?? `image-${++blockSeq}`
  return {
    id,
    messageId,
    type: MessageBlockType.IMAGE,
    createdAt: TS,
    updatedAt: TS,
    status: MessageBlockStatus.SUCCESS,
    ...(file ? { file } : {}),
    ...extra
  } as unknown as ImageMessageBlock
}

function fileBlock(messageId: string, file: FileMetadata): FileMessageBlock {
  const id = `file-block-${++blockSeq}`
  return {
    id,
    messageId,
    type: MessageBlockType.FILE,
    createdAt: TS,
    updatedAt: TS,
    status: MessageBlockStatus.SUCCESS,
    file
  } as unknown as FileMessageBlock
}

function message(id: string, role: Message['role'], blocks: MessageBlock[], extra: Partial<Message> = {}): Message {
  return {
    id,
    role,
    assistantId: 'asst-1',
    topicId: 't1',
    createdAt: TS,
    updatedAt: TS,
    status: role === 'assistant' ? AssistantMessageStatus.SUCCESS : UserMessageStatus.SUCCESS,
    blocks: blocks.map((block) => block.id),
    ...extra
  } as unknown as Message
}

function closureResponse(messages: Message[], blocks: MessageBlock[], anchorGroupKey: string) {
  return {
    messages: messages as any,
    blocks: blocks as any,
    closure: {
      completeness: 'context-closure',
      topicId: 't1',
      anchorGroupKey,
      firstMessageId: messages[0].id,
      lastMessageId: messages[messages.length - 1].id,
      returnedCount: messages.length,
      totalTurnCount: 3,
      selectedTurnCount: 3,
      boundaryMessageId: null
    }
  }
}

function assistantWithAnchor(groupKey: string): Assistant {
  return {
    id: 'asst-1',
    settings: { contextCount: 5, contextWindowAnchor: { t1: { kind: 'active', groupKey } } },
    model: { id: 'm', provider: 'p', name: 'm', group: 'g' }
  } as unknown as Assistant
}

function sdkTexts(modelMessages: any[], role: string): string[] {
  return modelMessages
    .filter((m) => m?.role === role)
    .map((m) => {
      const content = m?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content
          .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n')
      }
      return ''
    })
}

function sdkPartsOfType(modelMessages: any[], role: string, type: string): any[] {
  const parts: any[] = []
  for (const message of modelMessages) {
    if (message?.role !== role || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part?.type === type) parts.push(part)
    }
  }
  return parts
}

describe('ConversationService request-local attachment availability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    blockSeq = 0
    for (const key of Object.keys(blockEntities)) delete blockEntities[key]
    getDefaultModelMock.mockReturnValue({ id: 'm', provider: 'p', name: 'm', group: 'g' } as any)
    getSettingsMock.mockReturnValue({
      contextCount: 5,
      contextWindowAnchor: { t1: { kind: 'active', groupKey: 'u1' } }
    })
    ;(window as any).toast = { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
    ;(window as any).api = {
      file: { exists: existsMock, base64Image: base64ImageMock }
    }
    existsMock.mockResolvedValue(true)
    base64ImageMock.mockResolvedValue({
      mime: 'image/png',
      base64: 'AVAILABLE',
      data: 'data:image/png;base64,AVAILABLE'
    })
  })

  it('history missing (marked + unmarked) attachments are skipped while text and available attachments are sent', async () => {
    const historyText = mainTextBlock('u1', 'history text')
    const markedImage = imageBlock('u1', storedFile({ id: 'marked-image' }), { l2AttachmentUnavailable: true })
    const missingFile = fileBlock('u1', storedFile({ id: 'missing-doc', ext: '.txt', type: 'text' }))
    const availableImage = imageBlock('u1', storedFile({ id: 'available-image' }))
    const u1 = message('u1', 'user', [historyText, markedImage, missingFile, availableImage])

    const answerText = mainTextBlock('a1', 'history answer')
    const a1 = message('a1', 'assistant', [answerText])

    const triggerText = mainTextBlock('u2', 'current question')
    const u2 = message('u2', 'user', [triggerText])

    const blocks = [historyText, markedImage, missingFile, availableImage, answerText, triggerText]
    fetchClosureMock.mockResolvedValue(closureResponse([u1, a1, u2], blocks, 'u1'))

    // Only the available attachment's payload exists on this device.
    existsMock.mockImplementation(async (storedName: string) => storedName.startsWith('available-image'))

    const result = await ConversationService.prepareMessagesForModel(
      [u2],
      assistantWithAnchor('u1'),
      't1',
      undefined,
      null
    )

    expect(sdkTexts(result.modelMessages, 'user')).toEqual(['history text', 'current question'])
    expect(sdkTexts(result.modelMessages, 'assistant')).toEqual(['history answer'])
    // Available attachment kept, missing ones never encoded.
    expect(sdkPartsOfType(result.modelMessages, 'user', 'image')).toEqual([
      { type: 'image', image: 'AVAILABLE', mediaType: 'image/png' }
    ])
    expect(base64ImageMock).toHaveBeenCalledTimes(1)
    expect(base64ImageMock).toHaveBeenCalledWith('available-image.png')
    // History references never notify.
    expect((window as any).toast.error).not.toHaveBeenCalled()
  })

  it('current-message missing attachment notifies once and the send continues with text and usable attachments', async () => {
    const historyText = mainTextBlock('u1', 'history text')
    const u1 = message('u1', 'user', [historyText])
    const answerText = mainTextBlock('a1', 'history answer')
    const a1 = message('a1', 'assistant', [answerText])

    const triggerText = mainTextBlock('u2', 'question with attachments')
    const missingImage = imageBlock('u2', storedFile({ id: 'missing-image' }))
    const usableImage = imageBlock('u2', storedFile({ id: 'usable-image' }))
    const missingDoc = fileBlock('u2', storedFile({ id: 'missing-doc', ext: '.txt', type: 'text' }))
    const u2 = message('u2', 'user', [triggerText, missingImage, usableImage, missingDoc])

    const blocks = [historyText, answerText, triggerText, missingImage, usableImage, missingDoc]
    fetchClosureMock.mockResolvedValue(closureResponse([u1, a1, u2], blocks, 'u1'))
    existsMock.mockImplementation(async (storedName: string) => storedName.startsWith('usable-image'))

    const result = await ConversationService.prepareMessagesForModel(
      [u2],
      assistantWithAnchor('u1'),
      't1',
      undefined,
      null
    )

    // Send succeeded with the surrounding text and the usable attachment.
    expect(sdkTexts(result.modelMessages, 'user')).toEqual(['history text', 'question with attachments'])
    expect(sdkPartsOfType(result.modelMessages, 'user', 'image')).toEqual([
      { type: 'image', image: 'AVAILABLE', mediaType: 'image/png' }
    ])
    // One aggregated notice for the two skipped current-message attachments.
    expect((window as any).toast.error).toHaveBeenCalledTimes(1)
    expect((window as any).toast.error).toHaveBeenCalledWith('message.error.attachment.unavailable_skipped')
  })

  it('current message left with only unavailable attachments ends as a clean no-op request', async () => {
    const historyText = mainTextBlock('u1', 'history text')
    const u1 = message('u1', 'user', [historyText])
    const answerText = mainTextBlock('a1', 'history answer')
    const a1 = message('a1', 'assistant', [answerText])

    const missingImage = imageBlock('u2', storedFile({ id: 'only-image' }))
    const missingDoc = fileBlock('u2', storedFile({ id: 'only-doc', ext: '.txt', type: 'text' }))
    const u2 = message('u2', 'user', [missingImage, missingDoc])

    const blocks = [historyText, answerText, missingImage, missingDoc]
    fetchClosureMock.mockResolvedValue(closureResponse([u1, a1, u2], blocks, 'u1'))
    existsMock.mockResolvedValue(false)

    // Report, never throw: a throw here travels the request-error channel and
    // renders an inline failed answer.
    const result = await ConversationService.prepareMessagesForModel(
      [u2],
      assistantWithAnchor('u1'),
      't1',
      undefined,
      null
    )

    expect(result.nothingSendable).toBe(true)
    expect(result.modelMessages).toEqual([])
    // No payload read of any kind is attempted for an unavailable attachment.
    expect(base64ImageMock).not.toHaveBeenCalled()
    // One aggregated top notice for the two skipped attachments.
    expect((window as any).toast.error).toHaveBeenCalledTimes(1)
    expect((window as any).toast.error).toHaveBeenCalledWith('message.error.attachment.unavailable_skipped')
  })

  it('nonmissing attachment read failures still abort the request', async () => {
    const historyText = mainTextBlock('u1', 'history text')
    const u1 = message('u1', 'user', [historyText])
    const answerText = mainTextBlock('a1', 'history answer')
    const a1 = message('a1', 'assistant', [answerText])

    const triggerText = mainTextBlock('u2', 'read this')
    const blockedImage = imageBlock('u2', storedFile({ id: 'unreadable-image' }))
    const u2 = message('u2', 'user', [triggerText, blockedImage])

    const blocks = [historyText, answerText, triggerText, blockedImage]
    fetchClosureMock.mockResolvedValue(closureResponse([u1, a1, u2], blocks, 'u1'))
    // Payload exists, but reading it fails (permission/IO): must stay an error.
    existsMock.mockResolvedValue(true)
    base64ImageMock.mockRejectedValue(new Error('EACCES: permission denied'))

    await expect(
      ConversationService.prepareMessagesForModel([u2], assistantWithAnchor('u1'), 't1', undefined, null)
    ).rejects.toThrow(/Failed to attach/)
    expect((window as any).toast.error).not.toHaveBeenCalled()
  })
})
