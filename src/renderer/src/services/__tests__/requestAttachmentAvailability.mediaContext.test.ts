/**
 * Focused tests for the media-context switch at the request-local attachment
 * view boundary.
 *
 * Verifies:
 *  - the switch is ON by default, including when the persisted settings object
 *    has no such key yet;
 *  - when OFF, historical image/audio/video attachments are excluded from the
 *    request while the triggering turn's media, text and non-media attachments
 *    (document/PDF/text) are kept;
 *  - a history message left with nothing is dropped instead of becoming an
 *    empty wire message;
 *  - a deliberate omission is decided without any payload probe and never
 *    counts as an unavailable attachment.
 */
import type { FileMetadata } from '@renderer/types'
import type { FileMessageBlock, ImageMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import {
  AssistantMessageStatus,
  MessageBlockStatus,
  MessageBlockType,
  UserMessageStatus
} from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { existsMock, settingsState } = vi.hoisted(() => ({
  existsMock: vi.fn(),
  settingsState: { injectContextTimestamp: false } as Record<string, unknown>
}))

vi.mock('@renderer/i18n', () => ({ default: { t: (k: string) => k } }))
vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      settings: settingsState,
      messageBlocks: { entities: {} },
      messages: { entities: {}, messageIdsByTopic: {} }
    }),
    dispatch: vi.fn()
  }
}))

import { resolveRequestAttachmentAvailability } from '../requestAttachmentAvailability'
import { buildBlockOverlay } from '../requestBlockOverlay'

const TS = '2026-01-01T00:00:00.000Z'
let seq = 0

function storedFile(overrides: Partial<FileMetadata> = {}): FileMetadata {
  const id = overrides.id ?? `file-${++seq}`
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

function mainTextBlock(messageId: string, content: string): MessageBlock {
  return {
    id: `text-${++seq}`,
    messageId,
    type: MessageBlockType.MAIN_TEXT,
    content,
    createdAt: TS,
    updatedAt: TS,
    status: MessageBlockStatus.SUCCESS
  } as unknown as MessageBlock
}

function imageBlock(messageId: string, file?: FileMetadata): ImageMessageBlock {
  return {
    id: `image-${++seq}`,
    messageId,
    type: MessageBlockType.IMAGE,
    createdAt: TS,
    updatedAt: TS,
    status: MessageBlockStatus.SUCCESS,
    ...(file ? { file } : {})
  } as unknown as ImageMessageBlock
}

function fileBlock(messageId: string, file: FileMetadata): FileMessageBlock {
  return {
    id: `file-block-${++seq}`,
    messageId,
    type: MessageBlockType.FILE,
    createdAt: TS,
    updatedAt: TS,
    status: MessageBlockStatus.SUCCESS,
    file
  } as unknown as FileMessageBlock
}

function message(id: string, role: Message['role'], blocks: MessageBlock[]): Message {
  return {
    id,
    role,
    assistantId: 'asst-1',
    topicId: 't1',
    createdAt: TS,
    updatedAt: TS,
    status: role === 'assistant' ? AssistantMessageStatus.SUCCESS : UserMessageStatus.SUCCESS,
    blocks: blocks.map((block) => block.id)
  } as unknown as Message
}

beforeEach(() => {
  vi.clearAllMocks()
  seq = 0
  for (const key of Object.keys(settingsState)) delete settingsState[key]
  settingsState.injectContextTimestamp = false
  ;(window as any).api = { file: { exists: existsMock } }
  existsMock.mockResolvedValue(true)
})

describe('resolveRequestAttachmentAvailability — media-context switch', () => {
  it('is ON when the persisted settings object has no such key (history media kept)', async () => {
    const historyText = mainTextBlock('u1', 'history')
    const historyImage = imageBlock('u1', storedFile({ id: 'history-image' }))
    const u1 = message('u1', 'user', [historyText, historyImage])
    const triggerText = mainTextBlock('u2', 'current')
    const u2 = message('u2', 'user', [triggerText])
    const overlay = buildBlockOverlay([historyText, historyImage, triggerText])

    const result = await resolveRequestAttachmentAvailability([u1, u2], overlay, 'u2')

    expect(result.filter.unavailableBlockIds.size).toBe(0)
    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'u2'])
  })

  it('is ON when explicitly persisted as true (history media kept)', async () => {
    settingsState.includeHistoryMediaContext = true
    const historyText = mainTextBlock('u1', 'history')
    const historyImage = imageBlock('u1', storedFile({ id: 'history-image' }))
    const u1 = message('u1', 'user', [historyText, historyImage])
    const triggerText = mainTextBlock('u2', 'current')
    const u2 = message('u2', 'user', [triggerText])
    const overlay = buildBlockOverlay([historyText, historyImage, triggerText])

    const result = await resolveRequestAttachmentAvailability([u1, u2], overlay, 'u2')

    expect(result.filter.unavailableBlockIds.size).toBe(0)
    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'u2'])
  })

  it('OFF excludes historical image/audio/video but keeps text, documents and the trigger turn media', async () => {
    settingsState.includeHistoryMediaContext = false
    const historyText = mainTextBlock('u1', 'history text')
    const historyImage = imageBlock('u1', storedFile({ id: 'history-image' }))
    const historyAudio = fileBlock('u1', storedFile({ id: 'history-audio', ext: '.mp3', type: 'audio' }))
    const historyVideo = fileBlock('u1', storedFile({ id: 'history-video', ext: '.mp4', type: 'video' }))
    const historyPdf = fileBlock('u1', storedFile({ id: 'history-pdf', ext: '.pdf', type: 'document' }))
    const historyTxt = fileBlock('u1', storedFile({ id: 'history-txt', ext: '.txt', type: 'text' }))
    const u1 = message('u1', 'user', [historyText, historyImage, historyAudio, historyVideo, historyPdf, historyTxt])

    const answerText = mainTextBlock('a1', 'history answer')
    const a1 = message('a1', 'assistant', [answerText])

    const triggerText = mainTextBlock('u2', 'current question')
    const triggerImage = imageBlock('u2', storedFile({ id: 'trigger-image' }))
    const triggerAudio = fileBlock('u2', storedFile({ id: 'trigger-audio', ext: '.mp3', type: 'audio' }))
    const u2 = message('u2', 'user', [triggerText, triggerImage, triggerAudio])

    const overlay = buildBlockOverlay([
      historyText,
      historyImage,
      historyAudio,
      historyVideo,
      historyPdf,
      historyTxt,
      answerText,
      triggerText,
      triggerImage,
      triggerAudio
    ])

    const result = await resolveRequestAttachmentAvailability([u1, a1, u2], overlay, 'u2')

    expect([...result.filter.unavailableBlockIds].sort()).toEqual(
      [historyImage.id, historyAudio.id, historyVideo.id].sort()
    )
    expect(result.filter.unavailableBlockIds.has(historyPdf.id)).toBe(false)
    expect(result.filter.unavailableBlockIds.has(historyTxt.id)).toBe(false)
    expect(result.filter.unavailableBlockIds.has(triggerImage.id)).toBe(false)
    expect(result.filter.unavailableBlockIds.has(triggerAudio.id)).toBe(false)
    // Nothing was pruned: the history message still carries text, and the
    // trigger message is never pruned.
    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
    // A deliberate omission is not an unavailable attachment: no notice, and no
    // payload probe was spent on the omitted history media.
    expect(result.triggerUnavailableAttachmentCount).toBe(0)
    expect(existsMock).not.toHaveBeenCalledWith('history-image.png')
    expect(existsMock).not.toHaveBeenCalledWith('history-audio.mp3')
    expect(existsMock).not.toHaveBeenCalledWith('history-video.mp4')
    // Non-media attachments keep their normal availability probe.
    expect(existsMock).toHaveBeenCalledWith('history-pdf.pdf')
    expect(existsMock).toHaveBeenCalledWith('history-txt.txt')
  })

  it('OFF drops a history message left with nothing instead of emitting an empty message', async () => {
    settingsState.includeHistoryMediaContext = false
    const mediaOnlyImage = imageBlock('u1', storedFile({ id: 'media-only-image' }))
    const u1 = message('u1', 'user', [mediaOnlyImage])
    const answerText = mainTextBlock('a1', 'history answer')
    const a1 = message('a1', 'assistant', [answerText])
    const triggerText = mainTextBlock('u2', 'current question')
    const u2 = message('u2', 'user', [triggerText])

    const result = await resolveRequestAttachmentAvailability(
      [u1, a1, u2],
      buildBlockOverlay([mediaOnlyImage, answerText, triggerText]),
      'u2'
    )

    expect(result.messages.map((m) => m.id)).toEqual(['a1', 'u2'])
    expect(result.triggerUnavailableAttachmentCount).toBe(0)
    expect(result.triggerHasSendableContent).toBe(true)
  })

  it('OFF keeps an image-only triggering message (its media belongs to the current turn)', async () => {
    settingsState.includeHistoryMediaContext = false
    const triggerImage = imageBlock('u2', storedFile({ id: 'trigger-image' }))
    const u2 = message('u2', 'user', [triggerImage])

    const result = await resolveRequestAttachmentAvailability([u2], buildBlockOverlay([triggerImage]), 'u2')

    expect(result.messages.map((m) => m.id)).toEqual(['u2'])
    expect(result.filter.unavailableBlockIds.size).toBe(0)
    expect(result.triggerHasSendableContent).toBe(true)
  })

  it('never omits anything without a stable trigger identity', async () => {
    settingsState.includeHistoryMediaContext = false
    const historyText = mainTextBlock('u1', 'history')
    const historyImage = imageBlock('u1', storedFile({ id: 'img-1' }))
    const u1 = message('u1', 'user', [historyText, historyImage])

    const result = await resolveRequestAttachmentAvailability([u1], buildBlockOverlay([historyText, historyImage]))

    expect(result.filter.unavailableBlockIds.size).toBe(0)
  })
})
