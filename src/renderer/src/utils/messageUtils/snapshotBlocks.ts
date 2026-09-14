import { formatCitationsFromBlock } from '@renderer/store/messageBlock'
import type {
  CitationMessageBlock,
  FileMessageBlock,
  ImageMessageBlock,
  MainTextMessageBlock,
  Message,
  MessageBlock,
  ThinkingMessageBlock,
  TranslationMessageBlock
} from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'

/**
 * Snapshot-local block lookup/formatter seam for one-shot whole-topic jobs
 * (topic exports, knowledge analyze/process).
 *
 * Pure sibling helpers to the store-backed `find.ts` functions: they resolve
 * blocks from an explicit caller-local snapshot map instead of the loaded
 * Redux projection, so export/knowledge paths never rely on or mutate Redux.
 * The store-backed `findAllBlocks/getMainTextContent/...` remain for live UI
 * compatibility. Formatting semantics and per-message `message.blocks` order
 * match `find.ts` exactly.
 */

export type SnapshotBlockMap = Map<string, MessageBlock>

export const createSnapshotBlockMap = (blocks: MessageBlock[]): SnapshotBlockMap => {
  const map = new Map<string, MessageBlock>()
  for (const block of blocks) {
    if (block && typeof block.id === 'string') {
      map.set(block.id, block)
    }
  }
  return map
}

const resolveSnapshotBlock = (blocksById: SnapshotBlockMap, blockId: string): MessageBlock | undefined => {
  return blocksById.get(blockId)
}

export const findAllSnapshotBlocks = (message: Message, blocksById: SnapshotBlockMap): MessageBlock[] => {
  if (!message || !message.blocks || message.blocks.length === 0) {
    return []
  }
  const allBlocks: MessageBlock[] = []
  for (const blockId of message.blocks) {
    const block = resolveSnapshotBlock(blocksById, blockId)
    if (block) {
      allBlocks.push(block)
    }
  }
  return allBlocks
}

export const findMainTextSnapshotBlocks = (message: Message, blocksById: SnapshotBlockMap): MainTextMessageBlock[] => {
  if (!message || !message.blocks || message.blocks.length === 0) {
    return []
  }
  const textBlocks: MainTextMessageBlock[] = []
  for (const blockId of message.blocks) {
    const block = resolveSnapshotBlock(blocksById, blockId)
    if (block && block.type === MessageBlockType.MAIN_TEXT) {
      textBlocks.push(block)
    }
  }
  return textBlocks
}

export const findThinkingSnapshotBlocks = (message: Message, blocksById: SnapshotBlockMap): ThinkingMessageBlock[] => {
  if (!message || !message.blocks || message.blocks.length === 0) {
    return []
  }
  const thinkingBlocks: ThinkingMessageBlock[] = []
  for (const blockId of message.blocks) {
    const block = resolveSnapshotBlock(blocksById, blockId)
    if (block && block.type === MessageBlockType.THINKING) {
      thinkingBlocks.push(block)
    }
  }
  return thinkingBlocks
}

export const findImageSnapshotBlocks = (message: Message, blocksById: SnapshotBlockMap): ImageMessageBlock[] => {
  if (!message || !message.blocks || message.blocks.length === 0) {
    return []
  }
  const imageBlocks: ImageMessageBlock[] = []
  for (const blockId of message.blocks) {
    const block = resolveSnapshotBlock(blocksById, blockId)
    if (block && block.type === MessageBlockType.IMAGE) {
      imageBlocks.push(block)
    }
  }
  return imageBlocks
}

export const findFileSnapshotBlocks = (message: Message, blocksById: SnapshotBlockMap): FileMessageBlock[] => {
  if (!message || !message.blocks || message.blocks.length === 0) {
    return []
  }
  const fileBlocks: FileMessageBlock[] = []
  for (const blockId of message.blocks) {
    const block = resolveSnapshotBlock(blocksById, blockId)
    if (block && block.type === MessageBlockType.FILE) {
      fileBlocks.push(block)
    }
  }
  return fileBlocks
}

export const findCitationSnapshotBlocks = (message: Message, blocksById: SnapshotBlockMap): CitationMessageBlock[] => {
  if (!message || !message.blocks || message.blocks.length === 0) {
    return []
  }
  const citationBlocks: CitationMessageBlock[] = []
  for (const blockId of message.blocks) {
    const block = resolveSnapshotBlock(blocksById, blockId)
    if (block && block.type === MessageBlockType.CITATION) {
      citationBlocks.push(block)
    }
  }
  return citationBlocks
}

export const findTranslationSnapshotBlocks = (
  message: Message,
  blocksById: SnapshotBlockMap
): TranslationMessageBlock[] => {
  if (!message || !message.blocks || message.blocks.length === 0) {
    return []
  }
  const translationBlocks: TranslationMessageBlock[] = []
  for (const blockId of message.blocks) {
    const block = resolveSnapshotBlock(blocksById, blockId)
    if (block && block.type === MessageBlockType.TRANSLATION) {
      translationBlocks.push(block)
    }
  }
  return translationBlocks
}

export const getMainTextSnapshotContent = (message: Message, blocksById: SnapshotBlockMap): string => {
  const textBlocks = findMainTextSnapshotBlocks(message, blocksById)
  return textBlocks.map((block) => block.content).join('\n\n')
}

export const getThinkingSnapshotContent = (message: Message, blocksById: SnapshotBlockMap): string => {
  const thinkingBlocks = findThinkingSnapshotBlocks(message, blocksById)
  return thinkingBlocks.map((block) => block.content).join('\n\n')
}

export const getCitationSnapshotContent = (message: Message, blocksById: SnapshotBlockMap): string => {
  const citationBlocks = findCitationSnapshotBlocks(message, blocksById)
  return citationBlocks
    .map((block) => formatCitationsFromBlock(block))
    .flat()
    .map(
      (citation) =>
        `[${citation.number}] [${citation.title || citation.url.slice(0, 1999)}](${citation.url.slice(0, 1999)})`
    )
    .join('\n\n')
}
