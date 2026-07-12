import { loggerService } from '@logger'
import { dbService } from '@renderer/services/db'
import type { AppDispatch, RootState } from '@renderer/store'
import { removeManyBlocks, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import { deleteMessagesFromDB, saveMessageAndBlocksToDB } from '@renderer/store/thunk/messageThunk'
import { prepareRedo, prepareUndo } from '@renderer/store/undoStack'
import type { UndoAction } from '@renderer/types/editMode'
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
async function undoDelete(dispatch: AppDispatch, getState: () => RootState, action: UndoAction): Promise<void> {
  const {
    targetTopicId,
    sourceMessagesSnapshot: deletedMessagesSnapshot = [],
    sourceBlocksSnapshot: deletedBlocksSnapshot = [],
    targetInsertPositionIndex: insertPositionIndex,
    targetAnchorMessageId: anchorMessageId,
    fileReferenceDeltas = []
  } = action

  if (deletedMessagesSnapshot.length === 0) {
    logger.warn('[undoDelete] No messages in snapshot to restore')
    return
  }

  // Restore blocks to Redux
  if (deletedBlocksSnapshot.length > 0) {
    dispatch(upsertManyBlocks(deletedBlocksSnapshot))
  }

  // Resolve insertion position from anchor
  const resolvedIndex = resolveAnchorIndex(getState, targetTopicId, anchorMessageId, insertPositionIndex)

  // Insert messages back to Redux in order
  let index = resolvedIndex
  for (const message of deletedMessagesSnapshot) {
    dispatch(
      newMessagesActions.insertMessageAtIndex({
        topicId: targetTopicId,
        message,
        index
      })
    )
    index++
  }

  // Persist to DB
  for (let i = 0; i < deletedMessagesSnapshot.length; i++) {
    const message = deletedMessagesSnapshot[i]
    const blocksForMessage = deletedBlocksSnapshot.filter((b) => b.messageId === message.id)
    await saveMessageAndBlocksToDB(targetTopicId, message, blocksForMessage, resolvedIndex + i)
  }

  // Restore file reference counts (undo delete → need +1, deltas are -1 so use false to negate)
  if (fileReferenceDeltas.length > 0) {
    await updateFileReferenceCounts(fileReferenceDeltas, false)
  }

  logger.info(`[undoDelete] Restored ${deletedMessagesSnapshot.length} messages at resolved index ${resolvedIndex}`)
}

/**
 * Undo paste = remove the pasted messages
 */
async function undoPaste(dispatch: AppDispatch, getState: () => RootState, action: UndoAction): Promise<void> {
  const { targetTopicId, insertedMessageIds = [], fileReferenceDeltas = [] } = action

  if (insertedMessageIds.length === 0) {
    logger.warn('[undoPaste] No message IDs to remove')
    return
  }

  // Collect block IDs BEFORE dispatching removeMessages to avoid orphaning
  const stateBefore = getState()
  const blockIdsToRemove: string[] = []
  for (const msgId of insertedMessageIds) {
    const message = stateBefore.messages.entities[msgId]
    if (message?.blocks) {
      blockIdsToRemove.push(...message.blocks)
    }
  }

  // Remove messages from Redux
  dispatch(newMessagesActions.removeMessages({ topicId: targetTopicId, messageIds: insertedMessageIds }))

  // Remove blocks from Redux
  if (blockIdsToRemove.length > 0) {
    dispatch(removeManyBlocks(blockIdsToRemove))
  }

  // Delete from DB
  await deleteMessagesFromDB(targetTopicId, insertedMessageIds)

  // Decrement file reference counts
  if (fileReferenceDeltas.length > 0) {
    await updateFileReferenceCounts(fileReferenceDeltas, false)
  }

  logger.info(`[undoPaste] Removed ${insertedMessageIds.length} pasted messages`)
}

/**
 * Undo cut_paste = remove pasted messages + restore source messages
 */
async function undoCutPaste(dispatch: AppDispatch, getState: () => RootState, action: UndoAction): Promise<void> {
  // First: undo the paste part (remove pasted messages from target topic)
  await undoPaste(dispatch, getState, action)

  // Second: restore the deleted source messages (the ones that were cut)
  const {
    sourceMessagesSnapshot: deletedMessagesSnapshot = [],
    sourceBlocksSnapshot: deletedBlocksSnapshot = [],
    sourceTopicId: actionSourceTopicId,
    sourceInsertPositionIndex,
    sourceAnchorMessageId
  } = action

  if (deletedMessagesSnapshot.length === 0) {
    logger.warn('[undoCutPaste] No source messages to restore')
    return
  }

  const sourceTopicId = actionSourceTopicId || action.targetTopicId

  // Restore blocks to Redux
  if (deletedBlocksSnapshot.length > 0) {
    dispatch(upsertManyBlocks(deletedBlocksSnapshot))
  }

  // Resolve insertion position from source anchor
  const resolvedIndex = resolveAnchorIndex(
    getState,
    sourceTopicId,
    sourceAnchorMessageId,
    sourceInsertPositionIndex ?? 0
  )

  // Insert source messages back to source topic
  let index = resolvedIndex
  for (const message of deletedMessagesSnapshot) {
    dispatch(
      newMessagesActions.insertMessageAtIndex({
        topicId: sourceTopicId,
        message,
        index
      })
    )
    index++
  }

  // Persist source messages to DB
  for (let i = 0; i < deletedMessagesSnapshot.length; i++) {
    const message = deletedMessagesSnapshot[i]
    const blocksForMessage = deletedBlocksSnapshot.filter((b) => b.messageId === message.id)
    await saveMessageAndBlocksToDB(sourceTopicId, message, blocksForMessage, resolvedIndex + i)
  }

  // Restore file reference counts for source message blocks
  const sourceFileDeltas: Array<{ fileId: string; delta: number }> = []
  for (const block of deletedBlocksSnapshot) {
    if (block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE) {
      const file = (block as any).file
      if (file) {
        sourceFileDeltas.push({ fileId: file.id, delta: 1 })
      }
    }
  }
  if (sourceFileDeltas.length > 0) {
    await updateFileReferenceCounts(sourceFileDeltas, true)
  }

  logger.info(`[undoCutPaste] Restored ${deletedMessagesSnapshot.length} source messages to ${sourceTopicId}`)
}

// ==================== Redo Implementations ====================

/**
 * Redo delete = re-delete the messages again
 */
async function redoDelete(dispatch: AppDispatch, getState: () => RootState, action: UndoAction): Promise<void> {
  const { targetTopicId, insertedMessageIds = [], fileReferenceDeltas = [] } = action

  if (insertedMessageIds.length === 0) {
    return
  }

  // Collect block IDs BEFORE dispatching removeMessages to avoid orphaning
  const stateBefore = getState()
  const blockIdsToRemove: string[] = []
  for (const msgId of insertedMessageIds) {
    const message = stateBefore.messages.entities[msgId]
    if (message?.blocks) {
      blockIdsToRemove.push(...message.blocks)
    }
  }

  // Remove messages from Redux
  dispatch(newMessagesActions.removeMessages({ topicId: targetTopicId, messageIds: insertedMessageIds }))

  // Remove blocks from Redux
  if (blockIdsToRemove.length > 0) {
    dispatch(removeManyBlocks(blockIdsToRemove))
  }

  // Delete from DB
  await deleteMessagesFromDB(targetTopicId, insertedMessageIds)

  // Re-decrement file reference counts (redo delete → need -1, deltas are -1 so use true to keep -1)
  if (fileReferenceDeltas.length > 0) {
    await updateFileReferenceCounts(fileReferenceDeltas, true)
  }

  logger.info(`[redoDelete] Re-deleted ${insertedMessageIds.length} messages`)
}

/**
 * Redo paste = re-insert the pasted messages using after snapshots (new IDs)
 */
async function redoPaste(dispatch: AppDispatch, getState: () => RootState, action: UndoAction): Promise<void> {
  const {
    targetTopicId,
    pastedMessagesSnapshot = [],
    pastedBlocksSnapshot = [],
    targetInsertPositionIndex: insertPositionIndex,
    targetAnchorMessageId: anchorMessageId,
    fileReferenceDeltas = []
  } = action

  if (pastedMessagesSnapshot.length === 0) {
    logger.warn('[redoPaste] No pasted messages snapshot to restore')
    return
  }

  // Restore blocks to Redux
  if (pastedBlocksSnapshot.length > 0) {
    dispatch(upsertManyBlocks(pastedBlocksSnapshot))
  }

  // Resolve insertion position from anchor
  const resolvedIndex = resolveAnchorIndex(getState, targetTopicId, anchorMessageId, insertPositionIndex)

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

  // Persist to DB
  for (let i = 0; i < pastedMessagesSnapshot.length; i++) {
    const message = pastedMessagesSnapshot[i]
    const blocksForMessage = pastedBlocksSnapshot.filter((b) => b.messageId === message.id)
    await saveMessageAndBlocksToDB(targetTopicId, message, blocksForMessage, resolvedIndex + i)
  }

  // Re-increment file reference counts
  if (fileReferenceDeltas.length > 0) {
    await updateFileReferenceCounts(fileReferenceDeltas, true)
  }

  logger.info(
    `[redoPaste] Re-inserted ${pastedMessagesSnapshot.length} pasted messages at resolved index ${resolvedIndex}`
  )
}

/**
 * Redo cut_paste = re-execute the cut+paste using snapshots
 */
async function redoCutPaste(dispatch: AppDispatch, getState: () => RootState, action: UndoAction): Promise<void> {
  const {
    targetTopicId,
    pastedMessagesSnapshot = [],
    pastedBlocksSnapshot = [],
    sourceMessagesSnapshot: deletedMessagesSnapshot = [],
    sourceBlocksSnapshot: deletedBlocksSnapshot = [],
    sourceTopicId: actionSourceTopicId,
    targetInsertPositionIndex: insertPositionIndex,
    targetAnchorMessageId: anchorMessageId,
    fileReferenceDeltas = []
  } = action

  const sourceTopicId = actionSourceTopicId || action.targetTopicId

  // Step 1: Delete source messages (using ORIGINAL IDs from deletedMessagesSnapshot)
  if (deletedMessagesSnapshot.length > 0) {
    const sourceMsgIds = deletedMessagesSnapshot.map((m) => m.id)
    const stateBefore = getState()
    const blockIdsToRemove: string[] = []
    for (const msgId of sourceMsgIds) {
      const message = stateBefore.messages.entities[msgId]
      if (message?.blocks) {
        blockIdsToRemove.push(...message.blocks)
      }
    }

    dispatch(newMessagesActions.removeMessages({ topicId: sourceTopicId, messageIds: sourceMsgIds }))
    if (blockIdsToRemove.length > 0) {
      dispatch(removeManyBlocks(blockIdsToRemove))
    }
    await deleteMessagesFromDB(sourceTopicId, sourceMsgIds)

    // Decrement file reference counts for source blocks
    const sourceFileDeltas: Array<{ fileId: string; delta: number }> = []
    for (const block of deletedBlocksSnapshot) {
      if (block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE) {
        const file = (block as any).file
        if (file) {
          sourceFileDeltas.push({ fileId: file.id, delta: -1 })
        }
      }
    }
    if (sourceFileDeltas.length > 0) {
      await updateFileReferenceCounts(sourceFileDeltas, true)
    }
  }

  // Step 2: Re-insert pasted messages to target topic (using NEW IDs from pastedMessagesSnapshot)
  if (pastedMessagesSnapshot.length > 0) {
    if (pastedBlocksSnapshot.length > 0) {
      dispatch(upsertManyBlocks(pastedBlocksSnapshot))
    }

    // Resolve insertion position from anchor
    const resolvedIndex = resolveAnchorIndex(getState, targetTopicId, anchorMessageId, insertPositionIndex)

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

    for (let i = 0; i < pastedMessagesSnapshot.length; i++) {
      const message = pastedMessagesSnapshot[i]
      const blocksForMessage = pastedBlocksSnapshot.filter((b) => b.messageId === message.id)
      await saveMessageAndBlocksToDB(targetTopicId, message, blocksForMessage, resolvedIndex + i)
    }

    // Re-increment file reference counts for pasted blocks
    if (fileReferenceDeltas.length > 0) {
      await updateFileReferenceCounts(fileReferenceDeltas, true)
    }
  }

  logger.info(
    `[redoCutPaste] Re-executed cut+paste: ${deletedMessagesSnapshot.length} source messages deleted, ${pastedMessagesSnapshot.length} messages re-inserted`
  )
}
