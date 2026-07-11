import { loggerService } from '@logger'
import { dbService } from '@renderer/services/db'
import type { AppDispatch, RootState } from '@renderer/store'
import { removeManyBlocks, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import { deleteMessagesFromDB, saveMessageAndBlocksToDB } from '@renderer/store/thunk/messageThunk'
import { prepareRedo, prepareUndo } from '@renderer/store/undoStack'
import type { UndoAction } from '@renderer/types/editMode'
import { MessageBlockType } from '@renderer/types/newMessage'

const logger = loggerService.withContext('UndoService')

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
async function undoDelete(dispatch: AppDispatch, _getState: () => RootState, action: UndoAction): Promise<void> {
  const {
    topicId,
    deletedMessagesSnapshot = [],
    deletedBlocksSnapshot = [],
    insertPositionIndex,
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

  // Insert messages back to Redux in order
  let index = insertPositionIndex
  for (const message of deletedMessagesSnapshot) {
    dispatch(
      newMessagesActions.insertMessageAtIndex({
        topicId,
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
    await saveMessageAndBlocksToDB(topicId, message, blocksForMessage, insertPositionIndex + i)
  }

  // Restore file reference counts (undo delete → need +1, deltas are -1 so use false to negate)
  if (fileReferenceDeltas.length > 0) {
    await updateFileReferenceCounts(fileReferenceDeltas, false)
  }

  logger.info(`[undoDelete] Restored ${deletedMessagesSnapshot.length} messages`)
}

/**
 * Undo paste = remove the pasted messages
 */
async function undoPaste(dispatch: AppDispatch, getState: () => RootState, action: UndoAction): Promise<void> {
  const { topicId, insertedMessageIds = [], fileReferenceDeltas = [] } = action

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
  dispatch(newMessagesActions.removeMessages({ topicId, messageIds: insertedMessageIds }))

  // Remove blocks from Redux
  if (blockIdsToRemove.length > 0) {
    dispatch(removeManyBlocks(blockIdsToRemove))
  }

  // Delete from DB
  await deleteMessagesFromDB(topicId, insertedMessageIds)

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
  const { deletedMessagesSnapshot = [], deletedBlocksSnapshot = [], deletedTopicId, insertPositionIndex } = action

  if (deletedMessagesSnapshot.length === 0) {
    logger.warn('[undoCutPaste] No source messages to restore')
    return
  }

  const sourceTopicId = deletedTopicId || action.topicId

  // Restore blocks to Redux
  if (deletedBlocksSnapshot.length > 0) {
    dispatch(upsertManyBlocks(deletedBlocksSnapshot))
  }

  // Insert source messages back to source topic
  let index = insertPositionIndex
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
    await saveMessageAndBlocksToDB(sourceTopicId, message, blocksForMessage, insertPositionIndex + i)
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
  const { topicId, insertedMessageIds = [], fileReferenceDeltas = [] } = action

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
  dispatch(newMessagesActions.removeMessages({ topicId, messageIds: insertedMessageIds }))

  // Remove blocks from Redux
  if (blockIdsToRemove.length > 0) {
    dispatch(removeManyBlocks(blockIdsToRemove))
  }

  // Delete from DB
  await deleteMessagesFromDB(topicId, insertedMessageIds)

  // Re-decrement file reference counts (redo delete → need -1, deltas are -1 so use true to keep -1)
  if (fileReferenceDeltas.length > 0) {
    await updateFileReferenceCounts(fileReferenceDeltas, true)
  }

  logger.info(`[redoDelete] Re-deleted ${insertedMessageIds.length} messages`)
}

/**
 * Redo paste = re-insert the pasted messages
 */
async function redoPaste(dispatch: AppDispatch, _getState: () => RootState, action: UndoAction): Promise<void> {
  // Redo paste = re-insert the messages (same as undo delete)
  const {
    topicId,
    deletedMessagesSnapshot = [],
    deletedBlocksSnapshot = [],
    insertPositionIndex,
    fileReferenceDeltas = []
  } = action

  if (deletedMessagesSnapshot.length === 0) {
    return
  }

  // Restore blocks to Redux
  if (deletedBlocksSnapshot.length > 0) {
    dispatch(upsertManyBlocks(deletedBlocksSnapshot))
  }

  // Insert messages back
  let index = insertPositionIndex
  for (const message of deletedMessagesSnapshot) {
    dispatch(
      newMessagesActions.insertMessageAtIndex({
        topicId,
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
    await saveMessageAndBlocksToDB(topicId, message, blocksForMessage, insertPositionIndex + i)
  }

  // Restore file reference counts
  if (fileReferenceDeltas.length > 0) {
    await updateFileReferenceCounts(fileReferenceDeltas, true)
  }

  logger.info(`[redoPaste] Re-inserted ${deletedMessagesSnapshot.length} messages`)
}

/**
 * Redo cut_paste = re-execute the cut+paste
 */
async function redoCutPaste(dispatch: AppDispatch, getState: () => RootState, action: UndoAction): Promise<void> {
  // Redo cut_paste: delete source messages + re-insert to target
  const {
    topicId,
    deletedMessagesSnapshot = [],
    deletedBlocksSnapshot = [],
    deletedTopicId,
    insertPositionIndex,
    fileReferenceDeltas = []
  } = action

  const sourceTopicId = deletedTopicId || action.topicId

  // Delete source messages from Redux
  const sourceMsgIds = deletedMessagesSnapshot.map((m) => m.id)
  if (sourceMsgIds.length > 0) {
    // Collect block IDs BEFORE dispatching removeMessages to avoid orphaning
    const stateBefore = getState()
    const blockIdsToRemove: string[] = []
    for (const msgId of sourceMsgIds) {
      const message = stateBefore.messages.entities[msgId]
      if (message?.blocks) {
        blockIdsToRemove.push(...message.blocks)
      }
    }

    dispatch(newMessagesActions.removeMessages({ topicId: sourceTopicId, messageIds: sourceMsgIds }))

    // Remove source blocks from Redux
    if (blockIdsToRemove.length > 0) {
      dispatch(removeManyBlocks(blockIdsToRemove))
    }

    // Delete source messages from DB
    await deleteMessagesFromDB(sourceTopicId, sourceMsgIds)

    // Decrement file reference counts for source message blocks
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
      await updateFileReferenceCounts(sourceFileDeltas, false)
    }
  }

  // Re-insert messages to target topic
  if (deletedMessagesSnapshot.length > 0) {
    // Restore blocks to Redux (re-use the snapshot)
    if (deletedBlocksSnapshot.length > 0) {
      dispatch(upsertManyBlocks(deletedBlocksSnapshot))
    }

    let index = insertPositionIndex
    for (const message of deletedMessagesSnapshot) {
      dispatch(
        newMessagesActions.insertMessageAtIndex({
          topicId,
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
      await saveMessageAndBlocksToDB(topicId, message, blocksForMessage, insertPositionIndex + i)
    }

    // Increment file reference counts for pasted blocks
    if (fileReferenceDeltas.length > 0) {
      await updateFileReferenceCounts(fileReferenceDeltas, true)
    }
  }

  logger.info(
    `[redoCutPaste] Re-executed cut+paste: ${sourceMsgIds.length} messages from ${sourceTopicId} to ${topicId}`
  )
}
