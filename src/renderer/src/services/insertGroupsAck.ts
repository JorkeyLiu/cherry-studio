import { loggerService } from '@logger'
import type { AppDispatch } from '@renderer/store'
import { withClosureTopics } from '@renderer/store/closureOwnership'
import { upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import { branchesReceived } from '@renderer/store/topicBranch'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import type { InsertMessageGroupsResponse } from '@shared/chatDb'

const logger = loggerService.withContext('insertGroupsAck')

/**
 * Publish a Main-issued batch insertion acknowledgment atomically.
 *
 * Single shared mechanism for all `insertMessageGroups` callsites (paste,
 * undo restore, redo paste, redo cut-paste): canonical Main wires plus
 * Main-produced capability in ONE Redux messages+capability action, plus the
 * complete branch catalog from the SAME transaction (no follow-up list).
 * Blocks for visible rows publish first (existing separate block-slice
 * convention).
 *
 * Route/topic mismatch fails closed with zero dispatch — the committed Main
 * rows stand and converge on the next window read. A stale echo or an invalid
 * catalog is a projection gap, never a mutation failure: this function
 * returns normally (history stays advanced) after a best-effort capability
 * invalidation. A missing/non-array catalog never clears the projection;
 * only a present array (possibly empty) replaces it. Capability is Main-only;
 * `visiblePerGroup` (caller-computed bounded intersection in authority order)
 * decides WHICH rows enter, never the capability.
 */
export function publishInsertMessageGroupsAck(
  dispatch: AppDispatch,
  topicId: string,
  route: string | null,
  response: InsertMessageGroupsResponse,
  visiblePerGroup: string[][]
): void {
  if ((response.topicId ?? null) !== topicId || (response.branchId ?? null) !== route) {
    logger.error('[publishInsertMessageGroupsAck] Stale route response; failing closed without publication.')
    try {
      dispatch(newMessagesActions.invalidateRouteMutability({ topicId }))
    } catch {
      // best-effort invalidation; the committed rows converge on next read
    }
    return
  }
  if (!Array.isArray(response.groups) || response.groups.length !== visiblePerGroup.length) {
    logger.error('[publishInsertMessageGroupsAck] Group count mismatch; failing closed without publication.')
    try {
      dispatch(newMessagesActions.invalidateRouteMutability({ topicId }))
    } catch {
      // best-effort invalidation; the committed rows converge on next read
    }
    return
  }
  const visibleSet = new Set<string>()
  for (const ids of visiblePerGroup) {
    for (const id of ids ?? []) {
      if (typeof id === 'string' && id.length > 0) visibleSet.add(id)
    }
  }
  const visibleBlocks = (response.insertedBlocks as unknown as MessageBlock[]).filter((b) =>
    visibleSet.has(b.messageId)
  )
  if (visibleBlocks.length > 0) {
    dispatch(withClosureTopics(upsertManyBlocks(visibleBlocks), topicId))
  }
  dispatch(
    newMessagesActions.applyInsertedMessageGroups({
      topicId,
      route,
      messages: response.insertedMessages as unknown as Message[],
      insertedMessageIds: response.insertedMessageIds,
      mutableMessageIds: response.mutableMessageIds,
      groups: response.groups.map((g, i) => ({
        insertedMessageIds: g.insertedMessageIds,
        beforeMessageId: g.beforeMessageId,
        nextMessageId: g.nextMessageId,
        visibleMessageIds: (visiblePerGroup[i] ?? []).filter((id) => g.insertedMessageIds.includes(id))
      }))
    })
  )
  // The branch catalog rode the same transaction: publish it as part of this
  // one acknowledgment instead of re-reading. A missing/non-array catalog is
  // never published (no silent clear, no fallback fetch); an entry from
  // another topic vetoes the whole catalog for the same reason.
  const catalog = (response as unknown as { branches?: unknown }).branches
  if (!Array.isArray(catalog)) {
    logger.error('[publishInsertMessageGroupsAck] Ack carries no branch catalog; keeping the projected catalog.')
    return
  }
  for (const entry of catalog) {
    const rec = entry as Record<string, unknown>
    if (rec === null || typeof rec !== 'object' || rec.topicId !== topicId) {
      logger.error('[publishInsertMessageGroupsAck] Ack catalog entry topic mismatch; keeping the projected catalog.')
      return
    }
  }
  dispatch(branchesReceived({ topicId, branches: catalog as never }))
}
