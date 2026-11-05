import type { MainTextMessageBlock, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus } from '@renderer/types/newMessage'

import { isMainTextBlock } from './is'

/**
 * Store-free helpers for a message body that is stored as several
 * `main_text` blocks.
 *
 * A main-text run boundary is a streaming artifact, not authored structure:
 * the adapter emits `TEXT_START`/`TEXT_COMPLETE` per text run and the text
 * callbacks open a new block at every start, so one continuous body can be
 * persisted as two or more adjacent `main_text` blocks. Both consumers of that
 * fact — the edit surface (one editor per block) and stream finalize (one
 * persisted block per message body) — share the fold below, so the two can
 * never drift apart.
 *
 * This module deliberately has no store dependency: it imports only the block
 * types and the `is.ts` predicates, so the streaming finalize path can use it
 * without pulling the Redux projection in.
 */

/**
 * Joins main-text block contents with the canonical block separator.
 *
 * One logically-continuous message body may be stored as several `main_text`
 * blocks (streaming opens a new block at every text-start/text-end boundary).
 * This is the single join rule for such a body: every consumer — model input,
 * copy/export, token estimation, and the edit surface — must see the same text.
 * @param contents - Main-text block contents in message order.
 * @returns The joined content string (`''` when there is nothing to join).
 */
export const joinMainTextContents = (contents: string[]): string => contents.join('\n\n')

export interface CoalesceAdjacentMainTextOptions {
  /**
   * Carry run-level metadata onto the surviving block.
   *
   * When enabled the survivor also absorbs every folded-away block's
   * `citationReferences` (survivor's own entries first, deduplicated by
   * `citationBlockId`) and derives a `status` that reflects the whole run: if
   * any block of the run is non-terminal, the survivor is not marked terminal
   * either. Stream finalize opts in, because collapsing rows there is the
   * durable representation change. The edit surface does not: its draft must
   * keep the survivor's own metadata exactly as persisted, so folding for
   * display never rewrites citations or status.
   */
  preserveRunMetadata?: boolean
}

const TERMINAL_BLOCK_STATUSES: ReadonlySet<MessageBlockStatus> = new Set([
  MessageBlockStatus.SUCCESS,
  MessageBlockStatus.ERROR
])

const isTerminalStatus = (status: MessageBlockStatus): boolean => TERMINAL_BLOCK_STATUSES.has(status)

/**
 * A run's status is the status of its least-advanced member: one continuous
 * text is still streaming while any part of it is, so the survivor must never
 * claim a terminal state the run has not reached. All-terminal runs (the normal
 * finalize case) keep the survivor's own status untouched.
 */
const deriveRunStatus = (run: MainTextMessageBlock[]): MessageBlockStatus | undefined => {
  const nonTerminal = run.find((block) => !isTerminalStatus(block.status))
  return nonTerminal ? nonTerminal.status : undefined
}

/**
 * Concatenates a run's citation references, keeping the survivor's first.
 * Duplicate `citationBlockId` entries are dropped: they name the same citation
 * block, so a repeat carries no information and would only inflate the list
 * behind the first-wins read (`citationReferences[0].citationBlockId`).
 */
const mergeRunCitationReferences = (
  run: MainTextMessageBlock[]
): NonNullable<MainTextMessageBlock['citationReferences']> => {
  const merged: NonNullable<MainTextMessageBlock['citationReferences']> = []
  const seen = new Set<string>()
  for (const block of run) {
    for (const reference of block.citationReferences ?? []) {
      const key = reference.citationBlockId ?? ''
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      merged.push(reference)
    }
  }
  return merged
}

/**
 * Folds each maximal run of adjacent main-text blocks into the first block of
 * the run.
 *
 * The survivor keeps its own id and metadata (status, model, usage stay as
 * persisted) and takes the run's joined content, so every dropped block's text
 * survives inside the one block that remains. Callers are responsible for
 * deleting the folded-away rows; ids are never rewritten, so a call site that
 * persists blocks must pass the removed ids as its delete list.
 *
 * Non-main-text blocks keep their position and break adjacency: a thinking,
 * tool, file, or error block between two main-text blocks keeps them as two
 * separate runs. A message with zero or one main-text block is returned
 * unchanged, block-for-block and reference-for-reference.
 *
 * `sortOrder` is never touched: it is a caller/DB concern, and the database
 * re-normalizes density from the surviving order.
 */
export const coalesceAdjacentMainTextBlocks = (
  blocks: readonly MessageBlock[],
  options: CoalesceAdjacentMainTextOptions = {}
): MessageBlock[] => {
  const { preserveRunMetadata = false } = options
  const coalesced: MessageBlock[] = []
  let run: MainTextMessageBlock[] = []

  const flushRun = () => {
    if (run.length === 0) return
    const [first, ...rest] = run
    if (rest.length === 0) {
      coalesced.push(first)
      run = []
      return
    }
    const merged: MainTextMessageBlock = { ...first, content: joinMainTextContents(run.map((b) => b.content)) }
    if (preserveRunMetadata) {
      const citationReferences = mergeRunCitationReferences(run)
      if (citationReferences.length > 0) {
        merged.citationReferences = citationReferences
      }
      const runStatus = deriveRunStatus(run)
      if (runStatus) {
        merged.status = runStatus
      }
    }
    coalesced.push(merged)
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
