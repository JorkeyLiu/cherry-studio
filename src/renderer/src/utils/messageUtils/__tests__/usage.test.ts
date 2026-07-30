import { estimateUserPromptUsage } from '@renderer/services/TokenService'
import type { FileMetadata } from '@renderer/types'
import type { MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { estimateMessageBlocksUsage } from '../usage'

vi.mock('@renderer/services/TokenService', () => ({
  estimateUserPromptUsage: vi.fn()
}))

const estimateMock = vi.mocked(estimateUserPromptUsage)

const file = { id: 'file-1', ext: '.txt', origin_name: 'notes.txt' } as FileMetadata

const textBlock = {
  id: 'text-1',
  messageId: 'message-1',
  type: MessageBlockType.MAIN_TEXT,
  content: 'edited prompt',
  status: MessageBlockStatus.SUCCESS,
  createdAt: '2026-01-01T00:00:00.000Z'
} as MessageBlock

describe('estimateMessageBlocksUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    estimateMock.mockResolvedValue({ prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 })
  })

  it('passes file and image metadata together with edited text', async () => {
    const blocks = [
      textBlock,
      {
        id: 'file-block',
        messageId: 'message-1',
        type: MessageBlockType.FILE,
        file,
        status: MessageBlockStatus.SUCCESS,
        createdAt: textBlock.createdAt
      },
      {
        id: 'image-block',
        messageId: 'message-1',
        type: MessageBlockType.IMAGE,
        file: { ...file, id: 'image-1', ext: '.png' },
        status: MessageBlockStatus.SUCCESS,
        createdAt: textBlock.createdAt
      }
    ] as MessageBlock[]

    await estimateMessageBlocksUsage(blocks)

    expect(estimateMock).toHaveBeenCalledWith({
      content: 'edited prompt',
      files: [file, { ...file, id: 'image-1', ext: '.png' }]
    })
  })

  it('returns undefined when the edited set has no main text block', async () => {
    await expect(
      estimateMessageBlocksUsage([
        {
          id: 'file-block',
          messageId: 'message-1',
          type: MessageBlockType.FILE,
          file,
          status: MessageBlockStatus.SUCCESS,
          createdAt: textBlock.createdAt
        } as MessageBlock
      ])
    ).resolves.toBeUndefined()
    expect(estimateMock).not.toHaveBeenCalled()
  })
})
