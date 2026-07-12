import { loggerService } from '@logger'
import { dbService } from '@renderer/services/db'
import type { AppDispatch, RootState } from '@renderer/store'
import { clearClipboard, setClipboard } from '@renderer/store/clipboard'
import { removeManyBlocks, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import { deleteMessagesFromDB, saveMessageAndBlocksToDB } from '@renderer/store/thunk/messageThunk'
import { pushUndoAction } from '@renderer/store/undoStack'
import type { ClipboardItem, UndoAction } from '@renderer/types/editMode'
import type { FileMessageBlock, ImageMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { v4 as uuidv4 } from 'uuid'

const logger = loggerService.withContext('ClipboardService')

/**
 * Calculate the insertion index after a target message, accounting for multi-model groups.
 * If the target message is part of an assistant group, insert after the last message in the group.
 */
function calculateInsertIndex(messages: Message[], targetMessageId: string): number {
  const targetIndex = messages.findIndex((m) => m.id === targetMessageId || m.askId === targetMessageId)
  if (targetIndex === -1) return messages.length

  const targetMessage = messages[targetIndex]
  let insertIndex = targetIndex + 1

  // Determine the group key: user message uses its own ID, assistant uses askId
  const groupKey = targetMessage.role === 'user' ? targetMessage.id : targetMessage.askId

  if (groupKey) {
    // Skip past all messages in the same group
    for (let i = targetIndex + 1; i < messages.length; i++) {
      if (messages[i].role === 'assistant' && messages[i].askId === groupKey) {
        insertIndex = i + 1
      } else {
        break
      }
    }
  }

  return insertIndex
}

/**
 * Sort group IDs by the position of their first message in the messages array.
 */
function sortGroupIdsByPosition(messages: Message[], groupIds: string[]): string[] {
  return [...groupIds].sort((a, b) => {
    const aMessages = messages.filter((m) => m.askId === a || m.id === a)
    const bMessages = messages.filter((m) => m.askId === b || m.id === b)
    const aIndex = aMessages.length > 0 ? messages.findIndex((m) => m.id === aMessages[0].id) : -1
    const bIndex = bMessages.length > 0 ? messages.findIndex((m) => m.id === bMessages[0].id) : -1
    return aIndex - bIndex
  })
}

/**
 * Find the first message after `positionIndex` whose ID is not in `excludedIds`.
 * Returns the message ID, or null if no such message exists.
 */
function findAnchorAfterPosition(messages: Message[], positionIndex: number, excludedIds: Set<string>): string | null {
  for (let i = positionIndex; i < messages.length; i++) {
    if (!excludedIds.has(messages[i].id)) {
      return messages[i].id
    }
  }
  return null
}

/**
 * Copy selected message groups to clipboard.
 * Returns the number of item groups copied.
 */
export function copyMessages(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  selectedGroupIds: string[]
): number {
  const state = getState()
  const messages = selectMessagesForTopic(state, topicId)

  if (messages.length === 0 || selectedGroupIds.length === 0) {
    return 0
  }

  // Sort selected groups by their position in the source topic to preserve original order
  const sortedGroupIds = sortGroupIdsByPosition(messages, selectedGroupIds)

  const items: ClipboardItem[] = []

  for (const askId of sortedGroupIds) {
    const groupMessages = messages.filter((m) => m.askId === askId || m.id === askId)

    if (groupMessages.length === 0) continue

    // Deep clone messages and blocks
    const clonedMessages: Message[] = structuredClone(groupMessages)
    const clonedBlocks: MessageBlock[] = []

    for (const msg of groupMessages) {
      for (const blockId of msg.blocks || []) {
        const block = state.messageBlocks.entities[blockId]
        if (block) {
          clonedBlocks.push(structuredClone(block))
        }
      }
    }

    // Calculate position: use the first message's position
    const positionIndex = messages.findIndex((m) => m.id === groupMessages[0].id)

    items.push({
      originalAskId: askId,
      messages: clonedMessages,
      blocks: clonedBlocks,
      positionIndex: positionIndex >= 0 ? positionIndex : 0
    })
  }

  if (items.length > 0) {
    dispatch(setClipboard({ mode: 'copy', items, sourceTopicId: topicId }))
  }

  const totalCount = items.reduce((sum, item) => sum + item.messages.length, 0)
  logger.info(`[copyMessages] Copied ${totalCount} messages from ${items.length} groups`)
  return totalCount
}

/**
 * Cut selected message groups to clipboard.
 * Returns the number of item groups cut.
 */
export function cutMessages(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  selectedGroupIds: string[]
): number {
  const state = getState()
  const messages = selectMessagesForTopic(state, topicId)

  if (messages.length === 0 || selectedGroupIds.length === 0) {
    return 0
  }

  // Sort selected groups by their position in the source topic to preserve original order
  const sortedGroupIds = sortGroupIdsByPosition(messages, selectedGroupIds)

  const items: ClipboardItem[] = []

  for (const askId of sortedGroupIds) {
    const groupMessages = messages.filter((m) => m.askId === askId || m.id === askId)

    if (groupMessages.length === 0) continue

    // Deep clone messages and blocks
    const clonedMessages: Message[] = structuredClone(groupMessages)
    const clonedBlocks: MessageBlock[] = []

    for (const msg of groupMessages) {
      for (const blockId of msg.blocks || []) {
        const block = state.messageBlocks.entities[blockId]
        if (block) {
          clonedBlocks.push(structuredClone(block))
        }
      }
    }

    const positionIndex = messages.findIndex((m) => m.id === groupMessages[0].id)

    items.push({
      originalAskId: askId,
      messages: clonedMessages,
      blocks: clonedBlocks,
      positionIndex: positionIndex >= 0 ? positionIndex : 0
    })
  }

  if (items.length > 0) {
    dispatch(setClipboard({ mode: 'cut', items, sourceTopicId: topicId }))
  }

  const totalCount = items.reduce((sum, item) => sum + item.messages.length, 0)
  logger.info(`[cutMessages] Cut ${totalCount} messages from ${items.length} groups`)
  return totalCount
}

/**
 * Paste clipboard content into the target topic at the position after targetMessageId.
 * Returns the number of message groups pasted.
 */
export async function pasteMessages(
  dispatch: AppDispatch,
  getState: () => RootState,
  targetTopicId: string,
  targetMessageId: string
): Promise<number> {
  const state = getState()
  const { items: rawItems, mode, sourceTopicId } = state.clipboard

  if (rawItems.length === 0) {
    logger.warn('[pasteMessages] Clipboard is empty')
    return 0
  }

  // Sort items by their original position to preserve document order
  const items = [...rawItems].sort((a, b) => a.positionIndex - b.positionIndex)

  const targetMessages = selectMessagesForTopic(state, targetTopicId)

  // Calculate insertion position
  let insertIndex = targetMessages.length
  if (targetMessageId) {
    insertIndex = calculateInsertIndex(targetMessages, targetMessageId)
  }

  // Track file reference deltas for undo
  const fileReferenceDeltas: Array<{ fileId: string; delta: number }> = []
  const insertedMessageIds: string[] = []
  const allInsertedMessages: Message[] = []
  const allInsertedBlocks: MessageBlock[] = []

  // ID mapping: original message ID → new message ID
  const idMapping = new Map<string, string>()

  for (const item of items) {
    // First pass: generate new IDs for all messages in the group
    for (const originalMsg of item.messages) {
      idMapping.set(originalMsg.id, uuidv4())
    }

    // Second pass: create new messages and blocks with mapped IDs
    for (const originalMsg of item.messages) {
      const newMsgId = idMapping.get(originalMsg.id)!
      const clonedBlocksForMsg: MessageBlock[] = []

      // Create new block IDs and update references
      const newBlockIds: string[] = []
      for (const originalBlock of item.blocks) {
        if (originalBlock.messageId === originalMsg.id) {
          const newBlockId = uuidv4()
          const clonedBlock = {
            ...structuredClone(originalBlock),
            id: newBlockId,
            messageId: newMsgId
          }
          clonedBlocksForMsg.push(clonedBlock)
          newBlockIds.push(newBlockId)

          // Track file reference deltas
          if (clonedBlock.type === MessageBlockType.FILE || clonedBlock.type === MessageBlockType.IMAGE) {
            const file = (clonedBlock as FileMessageBlock | ImageMessageBlock).file
            if (file) {
              fileReferenceDeltas.push({ fileId: file.id, delta: 1 })
            }
          }
        }
      }

      // Create new message with updated IDs
      const newMessage: Message = {
        ...structuredClone(originalMsg),
        id: newMsgId,
        topicId: targetTopicId,
        blocks: newBlockIds
      }

      // Update askId for assistant messages
      if (newMessage.role === 'assistant' && originalMsg.askId) {
        const mappedAskId = idMapping.get(originalMsg.askId)
        if (mappedAskId) {
          newMessage.askId = mappedAskId
        } else {
          // Fallback: use the first message in this item as the group key
          const firstMsgInItem = item.messages[0]
          const mappedFirstId = idMapping.get(firstMsgInItem.id)
          newMessage.askId = mappedFirstId || newMsgId
        }
      }

      // Dispatch to Redux
      dispatch(
        newMessagesActions.insertMessageAtIndex({
          topicId: targetTopicId,
          message: newMessage,
          index: insertIndex
        })
      )

      // Persist to DB
      await saveMessageAndBlocksToDB(targetTopicId, newMessage, clonedBlocksForMsg, insertIndex)

      // Upsert blocks to Redux
      if (clonedBlocksForMsg.length > 0) {
        dispatch(upsertManyBlocks(clonedBlocksForMsg))
      }

      allInsertedMessages.push(newMessage)
      allInsertedBlocks.push(...clonedBlocksForMsg)
      insertedMessageIds.push(newMsgId)

      insertIndex++
    }
  }

  // Increment file reference counts for pasted content
  if (fileReferenceDeltas.length > 0) {
    for (const { fileId, delta } of fileReferenceDeltas) {
      await dbService.updateFileCount(fileId, delta, false)
    }
  }

  // If cut mode: remove source messages
  let sourceAnchorMessageId: string | null = null
  let sourceMinIndex = 0
  if (mode === 'cut' && sourceTopicId) {
    const sourceState = getState()
    const sourceMessages = selectMessagesForTopic(sourceState, sourceTopicId)
    const sourceMessageIdsToDelete: string[] = []
    const sourceBlockIdsToDelete: string[] = []

    for (const item of items) {
      const groupMessages = sourceMessages.filter((m) => m.askId === item.originalAskId || m.id === item.originalAskId)
      for (const msg of groupMessages) {
        sourceMessageIdsToDelete.push(msg.id)
        sourceBlockIdsToDelete.push(...(msg.blocks || []))
      }
    }

    if (sourceMessageIdsToDelete.length > 0) {
      // 计算 sourceTopic 的 anchor：被删区域之后的第一条未删除消息
      const sourceDeletedIdSet = new Set(sourceMessageIdsToDelete)
      let sourceMaxDeletedIndex = -1
      for (let i = sourceMessages.length - 1; i >= 0; i--) {
        if (sourceDeletedIdSet.has(sourceMessages[i].id)) {
          sourceMaxDeletedIndex = i
          break
        }
      }
      sourceAnchorMessageId =
        sourceMaxDeletedIndex >= 0
          ? findAnchorAfterPosition(sourceMessages, sourceMaxDeletedIndex + 1, sourceDeletedIdSet)
          : null
      sourceMinIndex = sourceMaxDeletedIndex >= 0 ? sourceMaxDeletedIndex + 1 : 0

      dispatch(newMessagesActions.removeMessages({ topicId: sourceTopicId, messageIds: sourceMessageIdsToDelete }))
    }
    if (sourceBlockIdsToDelete.length > 0) {
      dispatch(removeManyBlocks(sourceBlockIdsToDelete))
    }

    await deleteMessagesFromDB(sourceTopicId, sourceMessageIdsToDelete)

    // Decrement file references for source blocks
    for (const { fileId, delta } of fileReferenceDeltas) {
      await dbService.updateFileCount(fileId, -delta, false)
    }

    dispatch(clearClipboard())
  }

  // Create undo action
  // Calculate anchor: first non-pasted message after the paste region
  const finalTargetMessages = selectMessagesForTopic(getState(), targetTopicId)
  const afterInsertIndex = insertIndex
  const insertedIdSet = new Set(insertedMessageIds)
  const anchorMessageId = findAnchorAfterPosition(finalTargetMessages, afterInsertIndex, insertedIdSet)

  const undoAction: UndoAction = {
    id: uuidv4(),
    type: mode === 'cut' ? 'cut_paste' : 'paste',
    timestamp: Date.now(),
    targetTopicId: targetTopicId,
    insertedMessageIds,
    targetInsertPositionIndex: insertIndex - insertedMessageIds.length,
    targetAnchorMessageId: anchorMessageId,
    // source 侧：cut 模式下记录源消息信息
    sourceTopicId: mode === 'cut' && sourceTopicId ? sourceTopicId : undefined,
    sourceAnchorMessageId: mode === 'cut' && sourceTopicId ? (sourceAnchorMessageId ?? null) : undefined,
    sourceInsertPositionIndex: mode === 'cut' && sourceTopicId ? sourceMinIndex : undefined,
    sourceMessageIds: mode === 'cut' ? items.flatMap((item) => item.messages.map((m) => m.id)) : undefined,
    sourceMessagesSnapshot: mode === 'cut' ? items.flatMap((item) => item.messages) : undefined,
    sourceBlocksSnapshot: mode === 'cut' ? items.flatMap((item) => item.blocks) : undefined,
    // after 快照：粘贴后生成的新消息（新 ID）— copy 和 cut 都需要
    pastedMessagesSnapshot: allInsertedMessages,
    pastedBlocksSnapshot: allInsertedBlocks,
    fileReferenceDeltas
  }

  dispatch(pushUndoAction(undoAction))

  logger.info(`[pasteMessages] Pasted ${items.length} groups at index ${insertIndex - insertedMessageIds.length}`)
  return items.length
}

/**
 * Delete selected message groups in edit mode.
 * Returns the number of groups deleted.
 */
export async function deleteSelectedMessages(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  selectedGroupIds: string[]
): Promise<number> {
  const state = getState()
  const messages = selectMessagesForTopic(state, topicId)

  if (messages.length === 0 || selectedGroupIds.length === 0) {
    return 0
  }

  // Collect all messages and blocks to delete
  const allMessagesToDelete: Message[] = []
  const allBlocksToDelete: MessageBlock[] = []
  const allMessageIds: string[] = []
  const allBlockIds: string[] = []
  const fileReferenceDeltas: Array<{ fileId: string; delta: number }> = []

  for (const askId of selectedGroupIds) {
    const groupMessages = messages.filter((m) => m.askId === askId || m.id === askId)

    for (const msg of groupMessages) {
      allMessagesToDelete.push(structuredClone(msg))
      allMessageIds.push(msg.id)

      for (const blockId of msg.blocks || []) {
        const block = state.messageBlocks.entities[blockId]
        if (block) {
          allBlocksToDelete.push(structuredClone(block))
          allBlockIds.push(blockId)

          // Track file reference deltas
          if (block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE) {
            const file = block.file
            if (file) {
              fileReferenceDeltas.push({ fileId: file.id, delta: -1 })
            }
          }
        }
      }
    }
  }

  if (allMessageIds.length === 0) {
    return 0
  }

  // Calculate position index (minimum index of deleted messages)
  let positionIndex = messages.length
  for (const msg of allMessagesToDelete) {
    const idx = messages.findIndex((m) => m.id === msg.id)
    if (idx >= 0 && idx < positionIndex) {
      positionIndex = idx
    }
  }

  // Calculate anchor: first non-deleted message after the deleted region
  const deletedIdSet = new Set(allMessageIds)
  const anchorMessageId = findAnchorAfterPosition(messages, positionIndex, deletedIdSet)

  // Remove from Redux
  dispatch(newMessagesActions.removeMessages({ topicId, messageIds: allMessageIds }))
  if (allBlockIds.length > 0) {
    dispatch(removeManyBlocks(allBlockIds))
  }

  // Delete from DB
  await deleteMessagesFromDB(topicId, allMessageIds)

  // Update file reference counts
  for (const { fileId, delta } of fileReferenceDeltas) {
    await dbService.updateFileCount(fileId, delta, false)
  }

  // Create undo action
  const undoAction: UndoAction = {
    id: uuidv4(),
    type: 'delete',
    timestamp: Date.now(),
    targetTopicId: topicId,
    insertedMessageIds: allMessageIds,
    targetInsertPositionIndex: positionIndex,
    targetAnchorMessageId: anchorMessageId,
    // delete 操作的 source 侧就是同一个 topic
    sourceTopicId: topicId,
    sourceMessagesSnapshot: allMessagesToDelete,
    sourceBlocksSnapshot: allBlocksToDelete,
    fileReferenceDeltas
  }

  dispatch(pushUndoAction(undoAction))

  logger.info(
    `[deleteSelectedMessages] Deleted ${allMessageIds.length} messages from ${selectedGroupIds.length} groups`
  )
  return allMessageIds.length
}
