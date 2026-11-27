import { dbService } from '@renderer/services/db'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import type {
  ConversationNavigationSnapshotBlock,
  ConversationNavigationSnapshotMessage,
  FetchWholeTopicSnapshotResponse
} from '@shared/chatDb'

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

/**
 * Caller-local conversation-navigation snapshot for the chat outline.
 *
 * Asks Main for the explicit `'conversation-navigation'` projection of the ONE
 * whole-route read: the route stays complete (every effective-route message in
 * authority order), only each row is narrowed to the outline-consumed fields.
 * Main is the single serializer and the shared response contract strictly
 * validates that projection's key sets, so this loader trusts the validated
 * shape and never filters a full payload in the renderer. Nothing is written to
 * Redux.
 */
export interface ConversationNavigationSnapshot {
  messages: ConversationNavigationSnapshotMessage[]
  blocksById: ReadonlyMap<string, ConversationNavigationSnapshotBlock>
  snapshot: FetchWholeTopicSnapshotResponse['snapshot']
}

export const loadConversationNavigationSnapshot = async (
  topicId: string,
  branchId?: string | null
): Promise<ConversationNavigationSnapshot> => {
  const result = await dbService.fetchWholeTopicSnapshot(topicId, branchId, 'conversation-navigation')
  const blocksById = new Map<string, ConversationNavigationSnapshotBlock>()
  for (const block of result.blocks as unknown as ConversationNavigationSnapshotBlock[]) {
    if (block && typeof block.id === 'string') {
      blocksById.set(block.id, block)
    }
  }
  return {
    messages: result.messages as unknown as ConversationNavigationSnapshotMessage[],
    blocksById,
    snapshot: result.snapshot
  }
}
