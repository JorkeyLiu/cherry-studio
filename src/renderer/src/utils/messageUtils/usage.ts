import { estimateUserPromptUsage } from '@renderer/services/TokenService'
import type { MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'

/**
 * Estimates usage for the complete editable user-message block set.
 * Attachment metadata is part of the prompt just like the main text.
 */
export async function estimateMessageBlocksUsage(blocks: MessageBlock[]) {
  const mainTextBlock = blocks.find((block) => block.type === MessageBlockType.MAIN_TEXT)
  if (!mainTextBlock) return undefined

  const files = blocks
    .filter((block) => block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE)
    .map((block) => block.file)
    .filter((file) => file !== undefined)

  return estimateUserPromptUsage({ content: mainTextBlock.content, files })
}
