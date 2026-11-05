import type { MainTextMessageBlock, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { joinMainTextContents } from '@renderer/utils/messageUtils/find'

const isMainTextBlock = (block: MessageBlock): block is MainTextMessageBlock =>
  block.type === MessageBlockType.MAIN_TEXT

/**
 * Folds each maximal run of adjacent main-text blocks into the first block of
 * the run.
 *
 * Stored block boundaries are a streaming artifact, not authored structure: a
 * single continuous text can arrive as several `main_text` blocks. The edit
 * surface renders one editor per text block, so without folding one body would
 * appear as several stacked editors, each carrying its own toolbar, with the
 * sentence split between them. Folding keeps the first block's id and metadata
 * (status, model, usage stay as persisted), joins the run's contents with the
 * canonical separator the read view and model input already use, and drops the
 * remaining blocks of the run; `editSave` deletes every original block id
 * missing from the saved draft, so those ids are removed rather than orphaned.
 *
 * Non-main-text blocks keep their position and break adjacency: a thinking,
 * tool, file, or error block between two main-text blocks keeps them as two
 * separate runs. A message with zero or one main-text block is returned
 * unchanged (each block keeps its identity).
 */
export const coalesceAdjacentMainTextBlocks = (blocks: MessageBlock[]): MessageBlock[] => {
  const coalesced: MessageBlock[] = []
  let run: MainTextMessageBlock[] = []

  const flushRun = () => {
    if (run.length === 0) return
    const [first, ...rest] = run
    coalesced.push(rest.length === 0 ? first : { ...first, content: joinMainTextContents(run.map((b) => b.content)) })
    run = []
  }

  for (const block of blocks) {
    if (!isMainTextBlock(block)) {
      flushRun()
      coalesced.push(block)
      continue
    }
    run.push(block)
  }
  flushRun()

  return coalesced
}
