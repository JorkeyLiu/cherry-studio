import { dbService } from '@renderer/services/db'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import type { FetchWholeTopicSnapshotResponse } from '@shared/chatDb'

import { createSnapshotBlockMap, type SnapshotBlockMap } from './messageUtils/snapshotBlocks'

/**
 * Centralized one-shot whole-topic snapshot loader for topic exports and
 * knowledge analyze/process jobs.
 *
 * Loads an explicit short-lived whole-topic snapshot from Main
 * (`chatdb:fetch-whole-topic-snapshot`) and never relies on or mutates the
 * loaded Redux projection. The returned value is caller-local only.
 */

export interface WholeTopicSnapshot {
  messages: Message[]
  blocks: MessageBlock[]
  blocksById: SnapshotBlockMap
  snapshot: FetchWholeTopicSnapshotResponse['snapshot']
}

export const loadWholeTopicSnapshot = async (
  topicId: string,
  branchId?: string | null
): Promise<WholeTopicSnapshot> => {
  const result = await dbService.fetchWholeTopicSnapshot(topicId, branchId)
  const messages = result.messages
  const blocks = result.blocks
  return {
    messages,
    blocks,
    blocksById: createSnapshotBlockMap(blocks),
    snapshot: result.snapshot
  }
}
