import { loggerService } from '@logger'
import { dbService } from '@renderer/services/db'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import type { AppDispatch, RootState } from '@renderer/store'
import { withClosureTopics } from '@renderer/store/closureOwnership'
import { removeManyBlocks, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectLoadedMessagesForTopic } from '@renderer/store/newMessage'
import { deleteMessagesFromDB, executeDeleteMessagesWithDependents } from '@renderer/store/thunk/messageThunk'
import {
  deleteSegmentsBySnapshots,
  restoreSegmentsAfterUndo,
  restoreTargetSegments,
  syncSegmentsAfterMessageDeletion
} from '@renderer/store/thunk/topicSegmentThunk'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import { replaceSegmentsForTopic } from '@renderer/store/topicSegment'
import { prepareRedo, prepareUndo } from '@renderer/store/undoStack'
import type {
  CutPasteUndoAction,
  DeleteUndoAction,
  GroupAnchor,
  PasteUndoAction,
  UndoAction
} from '@renderer/types/editMode'
import type { Message } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import type { InsertMessageGroup, InsertMessageGroupIntent, MessageBlockEntry } from '@shared/chatDb'

const logger = loggerService.withContext('UndoService')

/**
 * Local-projection-only anchor resolution.
 * Returns the loaded index before the anchor, the loaded end for a tail, or
 * null when the anchor is outside the loaded projection (caller must not
 * inject). Never used as persistence authority.
 */
function resolveLocalBeforeIndex(loadedMessages: Message[], anchorMessageId: string | null | undefined): number | null {
  if (!anchorMessageId) return loadedMessages.length
  const idx = loadedMessages.findIndex((m) => m.id === anchorMessageId)
  return idx >= 0 ? idx : null
}

/**
 * Local-projection-only after-group-tail index.
 * Returns the loaded group tail when any member is loaded, otherwise null.
 */
function resolveLocalAfterGroupTailIndex(loadedMessages: Message[], targetMessageId: string): number | null {
  const targetIndex = loadedMessages.findIndex((m) => m.id === targetMessageId || m.askId === targetMessageId)
  if (targetIndex === -1) return null
  const targetMessage = loadedMessages[targetIndex]
  let insertIndex = targetIndex + 1
  const groupKey = targetMessage.role === 'user' ? targetMessage.id : targetMessage.askId
  if (groupKey) {
    // Match Main after-group-tail authority: scan the entire loaded
    // projection after the anchor and track the last loaded assistant with
    // the same group key (including non-contiguous members). Never stop at
    // intervening rows.
    for (let i = targetIndex + 1; i < loadedMessages.length; i++) {
      if (loadedMessages[i].role === 'assistant' && loadedMessages[i].askId === groupKey) {
        insertIndex = i + 1
      }
    }
  }
  return insertIndex
}

/**
 * Resolve the stable redo intent for paste/cut-paste.
 * New actions carry the original stable intent; legacy in-memory actions fall
 * back to the stable after-region anchor (before-message) or topic-tail.
 * Never a numeric index.
 */
function resolveRedoIntent(action: PasteUndoAction | CutPasteUndoAction): InsertMessageGroupIntent {
  if (action.targetInsertIntent) return action.targetInsertIntent
  if (action.targetAnchorMessageId) return { kind: 'before-message', messageId: action.targetAnchorMessageId }
  return { kind: 'topic-tail' }
}

/**
 * Build stable restore groups from authority snapshots.
 * anchorMessageId != null → before-message; null → topic-tail. No renderer
 * authority index is consulted.
 */
function buildRestoreGroups(groupAnchors: GroupAnchor[]): InsertMessageGroup[] {
  return groupAnchors.map((anchor) => {
    const entries: MessageBlockEntry[] = anchor.messages.map((message) => ({
      message: message as unknown as MessageBlockEntry['message'],
      blocks: anchor.blocks.filter((b) => b.messageId === message.id) as unknown as MessageBlockEntry['blocks']
    }))
    const intent: InsertMessageGroupIntent =
      anchor.anchorMessageId != null
        ? { kind: 'before-message', messageId: anchor.anchorMessageId }
        : { kind: 'topic-tail' }
    return { entries, intent }
  })
}

/**
 * Update file reference counts in DB
 */
async function updateFileReferenceCounts(
  deltas: Array<{ fileId: string; delta: number }>,
  increment: boolean
): Promise<void> {
  for (const { fileId, delta } of deltas) {
    const actualDelta = increment ? delta : -delta
    await dbService.updateFileCount(fileId, actualDelta, false)
  }
}

/**
 * Restore groups with one atomic stable command.
 * Sends all Main-produced full restore groups in request order with
 * before-message/topic-tail intents (no numeric index). Local projection is
 * bounded by each group's pre-delete loaded intersection: only messages whose
 * IDs are in `loadedMessageIds` enter Redux (with only their blocks); an empty
 * intersection injects nothing even for topic-tail. Outside-loaded anchors
 * inject nothing.
 */
async function restoreGroupsByStableAnchors(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  groupAnchors: GroupAnchor[]
): Promise<void> {
  if (groupAnchors.length === 0) return
  const groups = buildRestoreGroups(groupAnchors)

  // DB-first: one atomic multi-group restore with FULL entries. Missing/
  // cross-topic anchors fail the whole transaction with no partial writes and
  // no Redux changes.
  try {
    await dbService.insertMessageGroups(topicId, groups, selectActiveBranchId(getState(), topicId))
  } catch (error) {
    logger.error('[restoreGroupsByStableAnchors] Failed to restore groups to DB', error as Error)
    throw error
  }

  // Bounded local projection: evolve a loaded copy so later groups account
  // for earlier visible inserts without assuming whole-topic order.
  const evolving = [...((selectLoadedMessagesForTopic(getState(), topicId) ?? []) as Message[])]
  for (const anchor of groupAnchors) {
    // Fail-closed for legacy actions lacking the field: empty set injects nothing.
    const allowed = new Set(anchor.loadedMessageIds ?? [])
    const visibleMessages = anchor.messages.filter((m) => allowed.has(m.id))
    if (visibleMessages.length === 0) continue
    let localIdx: number | null
    if (anchor.anchorMessageId != null) {
      localIdx = resolveLocalBeforeIndex(evolving, anchor.anchorMessageId)
    } else {
      localIdx = evolving.length
    }
    if (localIdx === null) continue
    const visibleBlocks = anchor.blocks.filter((b) => allowed.has(b.messageId))
    if (visibleBlocks.length > 0) {
      dispatch(withClosureTopics(upsertManyBlocks(visibleBlocks), topicId))
    }
    for (let i = 0; i < visibleMessages.length; i++) {
      const message = visibleMessages[i]
      evolving.splice(localIdx + i, 0, message)
      dispatch(
        newMessagesActions.insertMessageAtIndex({
          topicId,
          message,
          index: localIdx + i
        })
      )
    }
  }
}

/**
 * Execute undo operation based on the top action in undoStack.
 * Returns the undone action for toast display, or null if nothing to undo.
 */
export async function executeUndo(dispatch: AppDispatch, getState: () => RootState): Promise<UndoAction | null> {
  const state = getState()
  const { undoStack } = state.undoStack

  if (undoStack.length === 0) {
    logger.info('[undo] Stack is empty')
    return null
  }

  const action = undoStack[undoStack.length - 1]

  // Move from undo to redo stack
  dispatch(prepareUndo())

  try {
    switch (action.type) {
      case 'delete':
        await undoDelete(dispatch, getState, action)
        break
      case 'paste':
        await undoPaste(dispatch, getState, action)
        break
      case 'cut_paste':
        await undoCutPaste(dispatch, getState, action)
        break
      default: {
        const _exhaustive: never = action
        throw new Error(`[executeUndo] Unknown action type: ${(_exhaustive as any).type}`)
      }
    }
  } catch (error) {
    logger.error('[undo] Failed:', error as Error)
    // Move back from redo to undo on failure
    dispatch(prepareRedo())
    return null
  }

  return action
}

/**
 * Execute redo operation.
 * Returns the redone action for toast display, or null if nothing to redo.
 */
export async function executeRedo(dispatch: AppDispatch, getState: () => RootState): Promise<UndoAction | null> {
  const state = getState()
  const { redoStack } = state.undoStack

  if (redoStack.length === 0) {
    return null
  }

  const action = redoStack[redoStack.length - 1]

  // Move from redo to undo stack
  dispatch(prepareRedo())

  try {
    switch (action.type) {
      case 'delete':
        await redoDelete(dispatch, getState, action)
        break
      case 'paste':
        await redoPaste(dispatch, getState, action)
        break
      case 'cut_paste':
        await redoCutPaste(dispatch, getState, action)
        break
      default: {
        const _exhaustive: never = action
        throw new Error(`[executeRedo] Unknown action type: ${(_exhaustive as any).type}`)
      }
    }
  } catch (error) {
    logger.error('[redo] Failed:', error as Error)
    // Move back from undo to redo on failure
    dispatch(prepareUndo())
    return null
  }

  return action
}

// ==================== Undo Implementations ====================

/**
 * Undo delete = re-insert deleted messages and blocks
 */
async function undoDelete(dispatch: AppDispatch, getState: () => RootState, action: DeleteUndoAction): Promise<void> {
  const { targetTopicId, groupAnchors, fileReferenceDeltas = [], segmentSnapshots = [] } = action

  if (groupAnchors.length === 0) {
    logger.warn('[undoDelete] No group anchors to restore')
    return
  }

  // Restore file references
  if (fileReferenceDeltas.length > 0) {
    await updateFileReferenceCounts(fileReferenceDeltas, false)
  }

  // Restore groups with one atomic stable command (no numeric index)
  await restoreGroupsByStableAnchors(dispatch, getState, targetTopicId, groupAnchors)

  // Restore segment membership
  await restoreSegmentsAfterUndo(dispatch, getState, segmentSnapshots)

  const totalMessages = groupAnchors.reduce((sum, a) => sum + a.messages.length, 0)
  logger.info(`[undoDelete] Restored ${totalMessages} messages from ${groupAnchors.length} groups`)
}

/**
 * Undo paste = remove the pasted messages
 */
async function undoPaste(
  dispatch: AppDispatch,
  getState: () => RootState,
  action: PasteUndoAction | CutPasteUndoAction
): Promise<void> {
  const { targetTopicId, insertedMessageIds = [], targetSegmentSnapshots = [] } = action

  if (insertedMessageIds.length === 0) {
    logger.warn('[undoPaste] No message IDs to remove')
    return
  }

  // Collect block IDs BEFORE any changes
  const stateBefore = getState()
  const blockIdsToRemove: string[] = []
  for (const msgId of insertedMessageIds) {
    const message = stateBefore.messages.entities[msgId]
    if (message?.blocks) {
      blockIdsToRemove.push(...message.blocks)
    }
  }

  // DB-first: delete from DB before dispatching to Redux (LOCK-001).
  // Branch-aware: pasted copies live in the topic's active route.
  let cleanup
  try {
    cleanup = await deleteMessagesFromDB(
      targetTopicId,
      insertedMessageIds,
      selectActiveBranchId(getState(), targetTopicId)
    )
  } catch (error) {
    logger.error('[undoPaste] Failed to delete from DB', error as Error)
    throw error
  }

  // Consume file cleanup exactly once after commit
  await consumeFileCleanupResult(cleanup)

  // Remove messages from Redux only after DB delete succeeds
  dispatch(newMessagesActions.removeMessages({ topicId: targetTopicId, messageIds: insertedMessageIds }))

  // Remove blocks from Redux
  if (blockIdsToRemove.length > 0) {
    dispatch(withClosureTopics(removeManyBlocks(blockIdsToRemove), targetTopicId))
  }

  // Delete target segments that were created during paste BEFORE syncing,
  // so syncSegmentsAfterMessageDeletion won't find (and double-delete) them.
  if (targetSegmentSnapshots.length > 0) {
    await deleteSegmentsBySnapshots(dispatch, targetSegmentSnapshots)
  }

  // Sync segments after message deletion (only non-target segments remain)
  await syncSegmentsAfterMessageDeletion(dispatch, getState, targetTopicId, insertedMessageIds)

  // LOCK-P5.3-1: No separate updateFileReferenceCounts here.
  // consumeFileCleanupResult above already handled physical file cleanup
  // via FileManager.deleteFile which decrements Dexie files.count. A second
  // dbService.updateFileCount would double-decrement the same references.

  logger.info(
    `[undoPaste] Removed ${insertedMessageIds.length} pasted messages, ${targetSegmentSnapshots.length} target segments`
  )
}

/**
 * Undo cut_paste = restore source messages + remove pasted copies.
 *
 * Same-topic hazard: source restore anchors are authority-generated AFTER
 * the paste insertion, so an anchor may reference an inserted copy. Deleting
 * the copies first would make that anchor missing and lose the source.
 * Restoring the source FIRST keeps every inserted anchor present, so the
 * stable restore transaction succeeds; the copies are deleted afterwards.
 * Cross-topic anchors never reference target copies, so restore-first is
 * equally correct there (behavior preserved).
 *
 * Failure semantics (explicit, no data loss):
 * - source restore failure → throw BEFORE touching paste copies; the copies
 *   remain and history does not advance (executeUndo moves the action back).
 * - paste-copy removal failure AFTER a successful source restore → throw and
 *   retain the duplicate (restored source + remaining copies) rather than
 *   losing the source. History likewise does not advance.
 */
async function undoCutPaste(
  dispatch: AppDispatch,
  getState: () => RootState,
  action: CutPasteUndoAction
): Promise<void> {
  const { sourceTopicId, sourceGroupAnchors, sourceSegmentSnapshots = [] } = action

  if (sourceGroupAnchors.length === 0) {
    // Nothing was deleted at paste time (e.g. paste source-delete failure):
    // only the pasted copies need removal.
    await undoPaste(dispatch, getState, action)
    logger.warn('[undoCutPaste] No source group anchors to restore')
    return
  }

  // Phase 1: restore the deleted source messages using the stable restore
  // groups. Any throw leaves the pasted copies untouched (no data loss).
  const sourceFileDeltas: Array<{ fileId: string; delta: number }> = []
  for (const anchor of sourceGroupAnchors) {
    for (const block of anchor.blocks) {
      if (block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE) {
        const file = (block as any).file
        if (file) {
          sourceFileDeltas.push({ fileId: file.id, delta: 1 })
        }
      }
    }
  }
  if (sourceFileDeltas.length > 0) {
    await updateFileReferenceCounts(sourceFileDeltas, true)
  }

  // Stable restore: one atomic command with before-message/topic-tail intents
  // (no numeric index). Throws on missing/cross-topic anchors with no partial
  // writes and no Redux changes — the copies below are then never touched.
  await restoreGroupsByStableAnchors(dispatch, getState, sourceTopicId, sourceGroupAnchors)

  // Restore source segment membership before removing the copies.
  await restoreSegmentsAfterUndo(dispatch, getState, sourceSegmentSnapshots)

  const totalMessages = sourceGroupAnchors.reduce((sum, a) => sum + a.messages.length, 0)
  logger.info(`[undoCutPaste] Restored ${totalMessages} source messages to ${sourceTopicId}`)

  // Phase 2: remove the pasted copies from the target topic (plus the target
  // segments created at paste time). A throw here retains the duplicate
  // (restored source + remaining copies) rather than losing the source.
  await undoPaste(dispatch, getState, action)
}

// ==================== Redo Implementations ====================

/**
 * Redo delete = re-delete the messages again.
 *
 * Semantically-correct roots: the original stable root IDs (Main re-expands
 * user dependents and dedupes overlapping expansions to the same set).
 * Legacy actions without roots fall back to the expanded set, which Main
 * handles as unique roots. Converges from the authority response (exact
 * expanded IDs/blocks + full segment catalog) — no loaded-projection reads.
 *
 * Branch-aware: re-deletes in the topic's active route (null = main route).
 */
async function redoDelete(dispatch: AppDispatch, getState: () => RootState, action: DeleteUndoAction): Promise<void> {
  const { targetTopicId, insertedMessageIds = [], rootMessageIds } = action
  const roots = rootMessageIds && rootMessageIds.length > 0 ? rootMessageIds : insertedMessageIds

  if (roots.length === 0) {
    return
  }

  // DB-first via the unified semantic command (LOCK-001)
  let response: Awaited<ReturnType<typeof dbService.deleteMessagesWithDependents>>
  try {
    response = await dbService.deleteMessagesWithDependents(
      targetTopicId,
      roots,
      selectActiveBranchId(getState(), targetTopicId)
    )
  } catch (error) {
    logger.error('[redoDelete] Failed to delete from DB', error as Error)
    throw error
  }

  // Consume file cleanup exactly once after commit
  await consumeFileCleanupResult(response)

  // Remove messages from Redux only after DB delete succeeds (authority-expanded set)
  dispatch(newMessagesActions.removeMessages({ topicId: targetTopicId, messageIds: response.deletedMessageIds }))

  // Remove blocks from Redux (authority-owned set, no loaded lookup)
  if (response.deletedBlockIds.length > 0) {
    dispatch(withClosureTopics(removeManyBlocks(response.deletedBlockIds), targetTopicId))
  }

  // Converge segments from the authority post-delete catalog (no loaded sync read)
  dispatch(
    replaceSegmentsForTopic({
      topicId: targetTopicId,
      segments: response.segments as unknown as Parameters<typeof replaceSegmentsForTopic>[0]['segments']
    })
  )

  // LOCK-P5.3-1: No separate updateFileReferenceCounts here.
  // consumeFileCleanupResult above already handled physical file cleanup
  // via FileManager.deleteFile which decrements Dexie files.count.

  logger.info(`[redoDelete] Re-deleted ${response.deletedMessageIds.length} messages`)
}

/**
 * Redo paste = re-insert the pasted messages with the stored stable intent.
 * No loaded numeric index is used for persistence; the stored original intent
 * (or a stable before-message/topic-tail fallback for legacy actions) drives
 * the single atomic Main command. Local projection stays bounded.
 */
async function redoPaste(dispatch: AppDispatch, getState: () => RootState, action: PasteUndoAction): Promise<void> {
  const {
    targetTopicId,
    pastedMessagesSnapshot = [],
    pastedBlocksSnapshot = [],
    fileReferenceDeltas = [],
    targetSegmentSnapshots = []
  } = action

  if (pastedMessagesSnapshot.length === 0) {
    logger.warn('[redoPaste] No pasted messages snapshot to restore')
    return
  }

  const intent = resolveRedoIntent(action)
  const entries: MessageBlockEntry[] = pastedMessagesSnapshot.map((message) => ({
    message: message as unknown as MessageBlockEntry['message'],
    blocks: pastedBlocksSnapshot.filter((b) => b.messageId === message.id) as unknown as MessageBlockEntry['blocks']
  }))

  // DB-first: one atomic stable re-insert before any Redux commit.
  try {
    await dbService.insertMessageGroups(
      targetTopicId,
      [{ entries, intent }],
      selectActiveBranchId(getState(), targetTopicId)
    )
  } catch (error) {
    logger.error('[redoPaste] Failed to save to DB', error as Error)
    throw error
  }

  // Bounded local projection only when the stable target is locally visible.
  const loaded = (selectLoadedMessagesForTopic(getState(), targetTopicId) ?? []) as Message[]
  let localIdx: number | null = null
  if (intent.kind === 'topic-tail') {
    localIdx = loaded.length
  } else if (intent.kind === 'before-message') {
    localIdx = resolveLocalBeforeIndex(loaded, intent.messageId)
  } else {
    localIdx = resolveLocalAfterGroupTailIndex(loaded, intent.messageId)
  }
  if (localIdx !== null) {
    if (pastedBlocksSnapshot.length > 0) {
      dispatch(withClosureTopics(upsertManyBlocks(pastedBlocksSnapshot), targetTopicId))
    }
    let index = localIdx
    for (const message of pastedMessagesSnapshot) {
      dispatch(
        newMessagesActions.insertMessageAtIndex({
          topicId: targetTopicId,
          message,
          index
        })
      )
      index++
    }
  }

  // Re-increment file reference counts
  if (fileReferenceDeltas.length > 0) {
    await updateFileReferenceCounts(fileReferenceDeltas, true)
  }

  // Restore target segments that were created during original paste
  if (targetSegmentSnapshots.length > 0) {
    await restoreTargetSegments(dispatch, targetSegmentSnapshots)
  }

  logger.info(
    `[redoPaste] Re-inserted ${pastedMessagesSnapshot.length} pasted messages with stable intent ${intent.kind}, ${targetSegmentSnapshots.length} target segments`
  )
}

/**
 * Redo cut_paste = re-execute the cut+paste using snapshots.
 *
 * Source deletion uses the SAME semantic plural delete helper as the initial
 * cut-paste (`executeDeleteMessagesWithDependents` with the stored stable
 * member roots). The helper owns Main segment catalog convergence, authority
 * anchor transfer, file cleanup, and loaded-intersection projection, so no
 * legacy `deleteMessagesFromDB` + local block/segment sync lives here.
 * Fail-closed: a source restore that needs roots but lacks `sourceRootIds`
 * (legacy in-memory action) throws before any DB mutation rather than
 * issuing a numeric/plain-delete authority mutation.
 */
async function redoCutPaste(
  dispatch: AppDispatch,
  getState: () => RootState,
  action: CutPasteUndoAction
): Promise<void> {
  const {
    targetTopicId,
    pastedMessagesSnapshot = [],
    pastedBlocksSnapshot = [],
    sourceTopicId,
    sourceGroupAnchors,
    fileReferenceDeltas = [],
    targetSegmentSnapshots = []
  } = action

  // Step 1: Re-delete the source via the semantic plural helper.
  if (sourceGroupAnchors.length > 0) {
    const roots = Array.isArray(action.sourceRootIds)
      ? [...new Set(action.sourceRootIds.filter((id) => typeof id === 'string' && id.length > 0))]
      : []
    if (roots.length === 0) {
      logger.error('[redoCutPaste] Missing sourceRootIds for legacy action; refusing plain delete')
      throw new Error('[redoCutPaste] Missing sourceRootIds; cannot safely re-delete source')
    }

    try {
      await executeDeleteMessagesWithDependents(dispatch, getState, sourceTopicId, roots)
    } catch (error) {
      logger.error('[redoCutPaste] Failed to delete source messages (semantic redo delete)', error as Error)
      throw error
    }

    // LOCK-P5.3-1: No separate updateFileReferenceCounts / segment sync here.
    // The helper already consumed file cleanup, converged the authority
    // segment catalog, transferred anchors, and removed only the loaded
    // intersection.
  }

  // Step 2: Re-insert pasted messages to target topic with the stored stable
  // intent (DB-first, one atomic command, no numeric index).
  if (pastedMessagesSnapshot.length > 0) {
    const intent = resolveRedoIntent(action)
    const entries: MessageBlockEntry[] = pastedMessagesSnapshot.map((message) => ({
      message: message as unknown as MessageBlockEntry['message'],
      blocks: pastedBlocksSnapshot.filter((b) => b.messageId === message.id) as unknown as MessageBlockEntry['blocks']
    }))

    try {
      await dbService.insertMessageGroups(
        targetTopicId,
        [{ entries, intent }],
        selectActiveBranchId(getState(), targetTopicId)
      )
    } catch (error) {
      logger.error('[redoCutPaste] Failed to save pasted messages to DB', error as Error)
      throw error
    }

    const loaded = (selectLoadedMessagesForTopic(getState(), targetTopicId) ?? []) as Message[]
    let localIdx: number | null = null
    if (intent.kind === 'topic-tail') {
      localIdx = loaded.length
    } else if (intent.kind === 'before-message') {
      localIdx = resolveLocalBeforeIndex(loaded, intent.messageId)
    } else {
      localIdx = resolveLocalAfterGroupTailIndex(loaded, intent.messageId)
    }
    if (localIdx !== null) {
      if (pastedBlocksSnapshot.length > 0) {
        dispatch(withClosureTopics(upsertManyBlocks(pastedBlocksSnapshot), targetTopicId))
      }
      let index = localIdx
      for (const message of pastedMessagesSnapshot) {
        dispatch(
          newMessagesActions.insertMessageAtIndex({
            topicId: targetTopicId,
            message,
            index
          })
        )
        index++
      }
    }

    // Re-increment file reference counts for pasted blocks
    if (fileReferenceDeltas.length > 0) {
      await updateFileReferenceCounts(fileReferenceDeltas, true)
    }
  }

  // Step 3: Restore target segments that were created during original paste
  if (targetSegmentSnapshots.length > 0) {
    await restoreTargetSegments(dispatch, targetSegmentSnapshots)
  }

  const sourceCount = sourceGroupAnchors.reduce((sum, a) => sum + a.messages.length, 0)
  logger.info(
    `[redoCutPaste] Re-executed cut+paste: ${sourceCount} source messages deleted, ${pastedMessagesSnapshot.length} messages re-inserted, ${targetSegmentSnapshots.length} target segments restored`
  )
}
