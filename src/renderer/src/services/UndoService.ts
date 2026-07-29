import { loggerService } from '@logger'
import { dbService } from '@renderer/services/db'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import type { AppDispatch, RootState } from '@renderer/store'
import { removeManyBlocks, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import { deleteMessagesFromDB, saveMessageAndBlocksToDB } from '@renderer/store/thunk/messageThunk'
import {
  deleteSegmentsBySnapshots,
  restoreSegmentsAfterUndo,
  restoreTargetSegments,
  syncSegmentsAfterMessageDeletion
} from '@renderer/store/thunk/topicSegmentThunk'
import { prepareRedo, prepareUndo } from '@renderer/store/undoStack'
import type {
  CutPasteUndoAction,
  DeleteUndoAction,
  GroupAnchor,
  PasteUndoAction,
  UndoAction
} from '@renderer/types/editMode'
import type { MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'

const logger = loggerService.withContext('UndoService')

/**
 * Resolve anchor message ID to a current insertion index.
 * If anchor exists, insert before it. Otherwise append at end.
 */
function resolveAnchorIndex(
  getState: () => RootState,
  topicId: string,
  anchorMessageId: string | null | undefined,
  fallbackIndex: number
): number {
  if (!anchorMessageId) return fallbackIndex
  const messages = selectMessagesForTopic(getState(), topicId)
  const anchorIdx = messages.findIndex((m) => m.id === anchorMessageId)
  if (anchorIdx >= 0) return anchorIdx
  return messages.length // 锚点不存在，追加到末尾
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
 * Restore groups using per-group anchors.
 * Inserts in reverse position order so earlier positions aren't shifted.
 */
async function restoreGroupsByAnchors(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  groupAnchors: GroupAnchor[],
  allBlocks: MessageBlock[]
): Promise<void> {
  // Sort by position descending so we insert from the end first
  const sorted = [...groupAnchors].sort((a, b) => b.positionIndex - a.positionIndex)

  // Phase 1: DB operations (before any Redux dispatches)
  // Resolve insertion indices based on current Redux state (unchanged at this point)
  const resolvedGroups: Array<{ anchor: GroupAnchor; insertIdx: number }> = []
  for (const anchor of sorted) {
    let insertIdx: number
    if (anchor.anchorMessageId) {
      const messages = selectMessagesForTopic(getState(), topicId)
      const anchorIdx = messages.findIndex((m) => m.id === anchor.anchorMessageId)
      insertIdx = anchorIdx >= 0 ? anchorIdx : messages.length
    } else {
      insertIdx = Math.min(anchor.positionIndex, selectMessagesForTopic(getState(), topicId).length)
    }
    resolvedGroups.push({ anchor, insertIdx })

    // Persist to DB
    for (let i = 0; i < anchor.messages.length; i++) {
      const message = anchor.messages[i]
      const blocksForMessage = allBlocks.filter((b) => b.messageId === message.id)
      await saveMessageAndBlocksToDB(topicId, message, blocksForMessage, insertIdx + i)
    }
  }

  // Phase 2: Redux dispatches (after all DB operations succeed)
  for (const { anchor, insertIdx } of resolvedGroups) {
    // Restore blocks
    if (anchor.blocks.length > 0) {
      dispatch(upsertManyBlocks(anchor.blocks))
    }

    // Insert messages
    for (let i = 0; i < anchor.messages.length; i++) {
      dispatch(
        newMessagesActions.insertMessageAtIndex({
          topicId,
          message: anchor.messages[i],
          index: insertIdx + i
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

  // Restore groups using per-group anchors
  const allBlocks = groupAnchors.flatMap((a) => a.blocks)
  await restoreGroupsByAnchors(dispatch, getState, targetTopicId, groupAnchors, allBlocks)

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

  // DB-first: delete from DB before dispatching to Redux (LOCK-001)
  let cleanup
  try {
    cleanup = await deleteMessagesFromDB(targetTopicId, insertedMessageIds)
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
    dispatch(removeManyBlocks(blockIdsToRemove))
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
 * Undo cut_paste = remove pasted messages + restore source messages
 */
async function undoCutPaste(
  dispatch: AppDispatch,
  getState: () => RootState,
  action: CutPasteUndoAction
): Promise<void> {
  // First: undo the paste part (remove pasted messages from target topic)
  await undoPaste(dispatch, getState, action)

  // Second: restore the deleted source messages using per-group anchors
  const { sourceTopicId, sourceGroupAnchors, sourceSegmentSnapshots = [] } = action

  if (sourceGroupAnchors.length === 0) {
    logger.warn('[undoCutPaste] No source group anchors to restore')
    return
  }

  // Restore file reference counts for source blocks
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

  // Restore groups using per-group anchors
  const allSourceBlocks = sourceGroupAnchors.flatMap((a) => a.blocks)
  await restoreGroupsByAnchors(dispatch, getState, sourceTopicId, sourceGroupAnchors, allSourceBlocks)

  // Restore source segment membership
  await restoreSegmentsAfterUndo(dispatch, getState, sourceSegmentSnapshots)

  const totalMessages = sourceGroupAnchors.reduce((sum, a) => sum + a.messages.length, 0)
  logger.info(`[undoCutPaste] Restored ${totalMessages} source messages to ${sourceTopicId}`)
}

// ==================== Redo Implementations ====================

/**
 * Redo delete = re-delete the messages again
 */
async function redoDelete(dispatch: AppDispatch, getState: () => RootState, action: DeleteUndoAction): Promise<void> {
  const { targetTopicId, insertedMessageIds = [] } = action

  if (insertedMessageIds.length === 0) {
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

  // DB-first: delete from DB before dispatching to Redux (LOCK-001)
  let cleanup
  try {
    cleanup = await deleteMessagesFromDB(targetTopicId, insertedMessageIds)
  } catch (error) {
    logger.error('[redoDelete] Failed to delete from DB', error as Error)
    throw error
  }

  // Consume file cleanup exactly once after commit
  await consumeFileCleanupResult(cleanup)

  // Remove messages from Redux only after DB delete succeeds
  dispatch(newMessagesActions.removeMessages({ topicId: targetTopicId, messageIds: insertedMessageIds }))

  // Remove blocks from Redux
  if (blockIdsToRemove.length > 0) {
    dispatch(removeManyBlocks(blockIdsToRemove))
  }

  // Sync segments after message deletion
  await syncSegmentsAfterMessageDeletion(dispatch, getState, targetTopicId, insertedMessageIds)

  // LOCK-P5.3-1: No separate updateFileReferenceCounts here.
  // consumeFileCleanupResult above already handled physical file cleanup
  // via FileManager.deleteFile which decrements Dexie files.count.

  logger.info(`[redoDelete] Re-deleted ${insertedMessageIds.length} messages`)
}

/**
 * Redo paste = re-insert the pasted messages using after snapshots (new IDs)
 */
async function redoPaste(dispatch: AppDispatch, getState: () => RootState, action: PasteUndoAction): Promise<void> {
  const {
    targetTopicId,
    pastedMessagesSnapshot = [],
    pastedBlocksSnapshot = [],
    targetInsertPositionIndex: insertPositionIndex,
    targetAnchorMessageId: anchorMessageId,
    fileReferenceDeltas = [],
    targetSegmentSnapshots = []
  } = action

  if (pastedMessagesSnapshot.length === 0) {
    logger.warn('[redoPaste] No pasted messages snapshot to restore')
    return
  }

  // Resolve insertion position from anchor (before any changes)
  const resolvedIndex = resolveAnchorIndex(getState, targetTopicId, anchorMessageId, insertPositionIndex)

  // DB-first: Persist to DB before dispatching to Redux
  try {
    for (let i = 0; i < pastedMessagesSnapshot.length; i++) {
      const message = pastedMessagesSnapshot[i]
      const blocksForMessage = pastedBlocksSnapshot.filter((b) => b.messageId === message.id)
      await saveMessageAndBlocksToDB(targetTopicId, message, blocksForMessage, resolvedIndex + i)
    }
  } catch (error) {
    logger.error('[redoPaste] Failed to save to DB', error as Error)
    throw error
  }

  // Restore blocks to Redux only after DB write succeeds
  if (pastedBlocksSnapshot.length > 0) {
    dispatch(upsertManyBlocks(pastedBlocksSnapshot))
  }

  // Insert pasted messages back (with their NEW IDs)
  let index = resolvedIndex
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

  // Re-increment file reference counts
  if (fileReferenceDeltas.length > 0) {
    await updateFileReferenceCounts(fileReferenceDeltas, true)
  }

  // Restore target segments that were created during original paste
  if (targetSegmentSnapshots.length > 0) {
    await restoreTargetSegments(dispatch, targetSegmentSnapshots)
  }

  logger.info(
    `[redoPaste] Re-inserted ${pastedMessagesSnapshot.length} pasted messages at resolved index ${resolvedIndex}, ${targetSegmentSnapshots.length} target segments`
  )
}

/**
 * Redo cut_paste = re-execute the cut+paste using snapshots
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
    targetInsertPositionIndex: insertPositionIndex,
    targetAnchorMessageId: anchorMessageId,
    fileReferenceDeltas = [],
    targetSegmentSnapshots = []
  } = action

  // Step 1: Delete source messages (DB-first)
  if (sourceGroupAnchors.length > 0) {
    const sourceMsgIds = sourceGroupAnchors.flatMap((a) => a.messages.map((m) => m.id))
    const stateBefore = getState()
    const blockIdsToRemove: string[] = []
    for (const msgId of sourceMsgIds) {
      const message = stateBefore.messages.entities[msgId]
      if (message?.blocks) {
        blockIdsToRemove.push(...message.blocks)
      }
    }

    // DB-first: delete from DB before dispatching to Redux (LOCK-001)
    let cleanup
    try {
      cleanup = await deleteMessagesFromDB(sourceTopicId, sourceMsgIds)
    } catch (error) {
      logger.error('[redoCutPaste] Failed to delete source messages from DB', error as Error)
      throw error
    }

    // Consume file cleanup exactly once after commit
    await consumeFileCleanupResult(cleanup)

    dispatch(newMessagesActions.removeMessages({ topicId: sourceTopicId, messageIds: sourceMsgIds }))
    if (blockIdsToRemove.length > 0) {
      dispatch(removeManyBlocks(blockIdsToRemove))
    }

    // Sync segments after source message deletion
    await syncSegmentsAfterMessageDeletion(dispatch, getState, sourceTopicId, sourceMsgIds)

    // LOCK-P5.3-1: No separate updateFileReferenceCounts for source blocks here.
    // consumeFileCleanupResult above already handled physical file cleanup
    // via FileManager.deleteFile which decrements Dexie files.count.
  }

  // Step 2: Re-insert pasted messages to target topic (DB-first)
  if (pastedMessagesSnapshot.length > 0) {
    // Resolve insertion position from anchor (before any changes)
    const resolvedIndex = resolveAnchorIndex(getState, targetTopicId, anchorMessageId, insertPositionIndex)

    // DB-first: Persist to DB before dispatching to Redux
    try {
      for (let i = 0; i < pastedMessagesSnapshot.length; i++) {
        const message = pastedMessagesSnapshot[i]
        const blocksForMessage = pastedBlocksSnapshot.filter((b) => b.messageId === message.id)
        await saveMessageAndBlocksToDB(targetTopicId, message, blocksForMessage, resolvedIndex + i)
      }
    } catch (error) {
      logger.error('[redoCutPaste] Failed to save pasted messages to DB', error as Error)
      throw error
    }

    // Redux dispatches only after DB write succeeds
    if (pastedBlocksSnapshot.length > 0) {
      dispatch(upsertManyBlocks(pastedBlocksSnapshot))
    }

    let index = resolvedIndex
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
