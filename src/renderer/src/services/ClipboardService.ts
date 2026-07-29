import { loggerService } from '@logger'
import { dbService } from '@renderer/services/db'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import type { AppDispatch, RootState } from '@renderer/store'
import { clearClipboard, setClipboard } from '@renderer/store/clipboard'
import { removeManyBlocks, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import { deleteMessagesFromDB, saveMessageAndBlocksToDB } from '@renderer/store/thunk/messageThunk'
import {
  collectSegmentSnapshots,
  collectWholeSelectedSegmentsForClipboard,
  syncSegmentsAfterMessageDeletion
} from '@renderer/store/thunk/topicSegmentThunk'
import { addSegment } from '@renderer/store/topicSegment'
import { pushUndoAction } from '@renderer/store/undoStack'
import type {
  ClipboardItem,
  ClipboardSegmentSnapshot,
  CutPasteUndoAction,
  DeleteUndoAction,
  GroupAnchor,
  PasteUndoAction,
  SegmentSnapshot
} from '@renderer/types/editMode'
import type { FileMessageBlock, ImageMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { v4 as uuidv4 } from 'uuid'

import { buildGroupList, transferAnchorsAfterDeletion } from './anchorService'

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
 * Build per-group anchors for undo positioning.
 * Each group gets its own anchor so non-contiguous selections
 * can be restored to their exact original positions.
 */
function buildGroupAnchors(messages: Message[], blocks: MessageBlock[], selectedGroupIds: string[]): GroupAnchor[] {
  const anchors: GroupAnchor[] = []

  // Pre-compute all selected message IDs (for anchor exclusion)
  const selectedIdSet = new Set(
    selectedGroupIds.flatMap((gid) => messages.filter((m) => m.askId === gid || m.id === gid).map((m) => m.id))
  )

  for (const groupId of selectedGroupIds) {
    const groupMessages = messages.filter((m) => m.askId === groupId || m.id === groupId)
    if (groupMessages.length === 0) continue

    // Find position: index of the first message in this group
    const firstMsgIndex = messages.findIndex((m) => m.id === groupMessages[0].id)
    const positionIndex = firstMsgIndex >= 0 ? firstMsgIndex : messages.length

    // Find anchor: first message after the last message in this group that isn't in any selected group
    let lastGroupIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].askId === groupId || messages[i].id === groupId) {
        lastGroupIndex = i
        break
      }
    }
    const anchorMessageId =
      lastGroupIndex >= 0 ? findAnchorAfterPosition(messages, lastGroupIndex + 1, selectedIdSet) : null

    // Collect blocks for this group
    const groupBlockIds = new Set(groupMessages.flatMap((m) => m.blocks || []))
    const groupBlocks = blocks.filter((b) => groupBlockIds.has(b.id))

    anchors.push({
      messages: structuredClone(groupMessages),
      blocks: structuredClone(groupBlocks),
      positionIndex,
      anchorMessageId
    })
  }

  return anchors
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

  // Collect all selected message IDs for segment snapshot collection
  const allSelectedMessageIds: string[] = []

  for (const askId of sortedGroupIds) {
    const groupMessages = messages.filter((m) => m.askId === askId || m.id === askId)

    if (groupMessages.length === 0) continue

    // Track selected message IDs
    for (const msg of groupMessages) {
      allSelectedMessageIds.push(msg.id)
    }

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

  // Collect segment snapshots for fully-selected segments
  const segmentSnapshots: ClipboardSegmentSnapshot[] = collectWholeSelectedSegmentsForClipboard(
    getState,
    topicId,
    allSelectedMessageIds
  )

  if (items.length > 0) {
    dispatch(setClipboard({ mode: 'copy', items, sourceTopicId: topicId, segmentSnapshots }))
  }

  const totalCount = items.reduce((sum, item) => sum + item.messages.length, 0)
  logger.info(
    `[copyMessages] Copied ${totalCount} messages from ${items.length} groups, ${segmentSnapshots.length} segment snapshots`
  )
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

  // Collect all selected message IDs for segment snapshot collection
  const allSelectedMessageIds: string[] = []

  for (const askId of sortedGroupIds) {
    const groupMessages = messages.filter((m) => m.askId === askId || m.id === askId)

    if (groupMessages.length === 0) continue

    // Track selected message IDs
    for (const msg of groupMessages) {
      allSelectedMessageIds.push(msg.id)
    }

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

  // Collect segment snapshots for fully-selected segments
  const segmentSnapshots: ClipboardSegmentSnapshot[] = collectWholeSelectedSegmentsForClipboard(
    getState,
    topicId,
    allSelectedMessageIds
  )

  if (items.length > 0) {
    dispatch(setClipboard({ mode: 'cut', items, sourceTopicId: topicId, segmentSnapshots }))
  }

  const totalCount = items.reduce((sum, item) => sum + item.messages.length, 0)
  logger.info(
    `[cutMessages] Cut ${totalCount} messages from ${items.length} groups, ${segmentSnapshots.length} segment snapshots`
  )
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
  const { items: rawItems, mode, sourceTopicId, segmentSnapshots: clipboardSegmentSnapshots } = state.clipboard

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

  // C5/C6 fix: Compute source group anchors BEFORE paste loop using pre-paste state.
  // This must happen before any messages are inserted into the target topic,
  // because for same-topic cut-paste, the paste loop would contaminate sourceMessages.
  let sourceGroupAnchors: GroupAnchor[] = []
  let sourceSegmentSnapshots: SegmentSnapshot[] = []
  const sourceMessageIdsToDelete: string[] = []
  const sourceBlockIdsToDelete: string[] = []

  if (mode === 'cut' && sourceTopicId) {
    sourceGroupAnchors = buildGroupAnchors(
      selectMessagesForTopic(state, sourceTopicId),
      Object.values(state.messageBlocks.entities),
      items.map((item) => item.originalAskId)
    )

    const sourceMessages = selectMessagesForTopic(state, sourceTopicId)
    for (const item of items) {
      const groupMessages = sourceMessages.filter((m) => m.askId === item.originalAskId || m.id === item.originalAskId)
      for (const msg of groupMessages) {
        sourceMessageIdsToDelete.push(msg.id)
        sourceBlockIdsToDelete.push(...(msg.blocks || []))
      }
    }
  }

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

      // DB-first: Persist to DB before dispatching to Redux
      try {
        await saveMessageAndBlocksToDB(targetTopicId, newMessage, clonedBlocksForMsg, insertIndex)

        // Dispatch to Redux only after DB write succeeds
        dispatch(
          newMessagesActions.insertMessageAtIndex({
            topicId: targetTopicId,
            message: newMessage,
            index: insertIndex
          })
        )

        // Upsert blocks to Redux
        if (clonedBlocksForMsg.length > 0) {
          dispatch(upsertManyBlocks(clonedBlocksForMsg))
        }

        allInsertedMessages.push(newMessage)
        allInsertedBlocks.push(...clonedBlocksForMsg)
        insertedMessageIds.push(newMsgId)

        insertIndex++
      } catch (error) {
        logger.error('[pasteMessages] Failed to save message to DB', error as Error)
        throw new Error(`[pasteMessages] DB write failed for message ${newMsgId}`)
      }
    }
  }

  // Increment file reference counts for pasted content
  if (fileReferenceDeltas.length > 0) {
    for (const { fileId, delta } of fileReferenceDeltas) {
      await dbService.updateFileCount(fileId, delta, false)
    }
  }

  // Reconstruct segments from clipboard snapshots
  const targetSegmentSnapshots: TopicSegment[] = []
  if (clipboardSegmentSnapshots && clipboardSegmentSnapshots.length > 0) {
    for (const clipSnap of clipboardSegmentSnapshots) {
      // Map original message IDs to new message IDs
      const newMessageIds: string[] = []
      let allMapped = true
      for (const origId of clipSnap.originalMessageIds) {
        const mappedId = idMapping.get(origId)
        if (mappedId) {
          newMessageIds.push(mappedId)
        } else {
          allMapped = false
          break
        }
      }

      // Skip if mapping is incomplete (some original IDs were not part of the paste)
      if (!allMapped || newMessageIds.length === 0) {
        logger.warn(
          `[pasteMessages] Skipping segment "${clipSnap.name}" — incomplete ID mapping (${newMessageIds.length}/${clipSnap.originalMessageIds.length})`
        )
        continue
      }

      // Create new segment with new ID in target topic
      const newSegment: TopicSegment = {
        id: uuidv4(),
        topicId: targetTopicId,
        name: clipSnap.name,
        color: clipSnap.color,
        messageIds: newMessageIds,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }

      // Persist to DB + Redux
      await dbService.upsertSegment(
        newSegment.id,
        newSegment.topicId,
        newSegment.name,
        newSegment.messageIds,
        newSegment.color
      )
      dispatch(addSegment(newSegment))
      targetSegmentSnapshots.push(newSegment)
    }

    logger.info(
      `[pasteMessages] Reconstructed ${targetSegmentSnapshots.length} segments from ${clipboardSegmentSnapshots.length} clipboard snapshots`
    )
  }

  // If cut mode: remove source messages (DB-first)
  if (mode === 'cut' && sourceTopicId) {
    // Collect segment snapshots BEFORE deletion (needed for undo)
    sourceSegmentSnapshots = collectSegmentSnapshots(getState, sourceTopicId, sourceMessageIdsToDelete)

    // DB-first: delete from DB before dispatching to Redux (LOCK-001)
    if (sourceMessageIdsToDelete.length > 0) {
      try {
        const cleanup = await deleteMessagesFromDB(sourceTopicId, sourceMessageIdsToDelete)

        // Consume file cleanup exactly once after commit
        await consumeFileCleanupResult(cleanup)

        // Dispatch to Redux only after DB delete succeeds
        dispatch(newMessagesActions.removeMessages({ topicId: sourceTopicId, messageIds: sourceMessageIdsToDelete }))
        if (sourceBlockIdsToDelete.length > 0) {
          dispatch(removeManyBlocks(sourceBlockIdsToDelete))
        }

        // Sync segments after source message deletion
        await syncSegmentsAfterMessageDeletion(dispatch, getState, sourceTopicId, sourceMessageIdsToDelete)
      } catch (error) {
        logger.error('[pasteMessages] Failed to delete source messages from DB', error as Error)
      }
    }

    // LOCK-P5.3-1: No separate updateFileCount for source blocks here.
    // consumeFileCleanupResult above already handled physical file cleanup
    // via FileManager.deleteFile which decrements Dexie files.count.

    dispatch(clearClipboard())
  }

  // Create undo action
  // Calculate anchor: first non-pasted message after the paste region
  const finalTargetMessages = selectMessagesForTopic(getState(), targetTopicId)
  const afterInsertIndex = insertIndex
  const insertedIdSet = new Set(insertedMessageIds)
  const anchorMessageId = findAnchorAfterPosition(finalTargetMessages, afterInsertIndex, insertedIdSet)

  if (mode === 'cut' && sourceTopicId) {
    const undoAction: CutPasteUndoAction = {
      id: uuidv4(),
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: targetTopicId,
      insertedMessageIds,
      targetInsertPositionIndex: insertIndex - insertedMessageIds.length,
      targetAnchorMessageId: anchorMessageId,
      sourceTopicId,
      sourceGroupAnchors,
      sourceSegmentSnapshots,
      targetSegmentSnapshots,
      pastedMessagesSnapshot: allInsertedMessages,
      pastedBlocksSnapshot: allInsertedBlocks,
      fileReferenceDeltas
    }
    dispatch(pushUndoAction(undoAction))
  } else {
    const undoAction: PasteUndoAction = {
      id: uuidv4(),
      type: 'paste',
      timestamp: Date.now(),
      targetTopicId: targetTopicId,
      insertedMessageIds,
      targetInsertPositionIndex: insertIndex - insertedMessageIds.length,
      targetAnchorMessageId: anchorMessageId,
      targetSegmentSnapshots,
      pastedMessagesSnapshot: allInsertedMessages,
      pastedBlocksSnapshot: allInsertedBlocks,
      fileReferenceDeltas
    }
    dispatch(pushUndoAction(undoAction))
  }

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

  // Snapshot oldGroupList before deletion for anchor transfer
  const messageIdsBefore = state.messages.messageIdsByTopic[topicId] || []
  const entitiesBefore = state.messages.entities
  const oldGroupList = buildGroupList(messageIdsBefore, (id) => entitiesBefore[id])

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

  // Build per-group anchors for undo positioning
  const groupAnchors = buildGroupAnchors(messages, allBlocksToDelete, selectedGroupIds)

  // Collect segment snapshots BEFORE deletion (needed for undo)
  const segmentSnapshots = collectSegmentSnapshots(getState, topicId, allMessageIds)

  // DB-first: delete from DB before dispatching to Redux (LOCK-001)
  let cleanup
  try {
    cleanup = await deleteMessagesFromDB(topicId, allMessageIds)
  } catch (error) {
    logger.error('[deleteSelectedMessages] Failed to delete from DB', error as Error)
    return 0
  }

  // Consume file cleanup exactly once after commit, before Redux/file changes
  await consumeFileCleanupResult(cleanup)

  // Remove from Redux only after DB delete succeeds
  dispatch(newMessagesActions.removeMessages({ topicId, messageIds: allMessageIds }))
  if (allBlockIds.length > 0) {
    dispatch(removeManyBlocks(allBlockIds))
  }

  // Transfer anchors after deletion
  const newState = getState()
  const messageIdsAfter = newState.messages.messageIdsByTopic[topicId] || []
  const entitiesAfter = newState.messages.entities
  const newGroupList = buildGroupList(messageIdsAfter, (id) => entitiesAfter[id])
  transferAnchorsAfterDeletion(dispatch, getState, topicId, oldGroupList, newGroupList)

  // Sync segments after message deletion
  await syncSegmentsAfterMessageDeletion(dispatch, getState, topicId, allMessageIds)

  // LOCK-P5.3-1: No separate updateFileCount here. consumeFileCleanupResult
  // above already handled physical file cleanup via FileManager.deleteFile
  // which decrements Dexie files.count. A second dbService.updateFileCount
  // would double-decrement the same references.

  // Create undo action
  const undoAction: DeleteUndoAction = {
    id: uuidv4(),
    type: 'delete',
    timestamp: Date.now(),
    targetTopicId: topicId,
    insertedMessageIds: allMessageIds,
    pastedMessagesSnapshot: [],
    pastedBlocksSnapshot: [],
    fileReferenceDeltas,
    groupAnchors,
    segmentSnapshots
  }

  dispatch(pushUndoAction(undoAction))

  logger.info(
    `[deleteSelectedMessages] Deleted ${allMessageIds.length} messages from ${selectedGroupIds.length} groups`
  )
  return allMessageIds.length
}

/**
 * Delete a single message with undo support.
 * If deleting a user message, cascades to all assistant messages with matching askId,
 * and transfers anchors for all affected assistants.
 * If deleting an assistant message, only deletes that single message.
 */
export async function deleteSingleMessage(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  message: Message
): Promise<void> {
  const state = getState()
  const msg = state.messages.entities[message.id]
  if (!msg) return

  // Snapshot oldGroupList before deletion for anchor transfer
  const messageIdsBefore = state.messages.messageIdsByTopic[topicId] || []
  const entitiesBefore = state.messages.entities
  const oldGroupList = buildGroupList(messageIdsBefore, (id) => entitiesBefore[id])

  // Determine cascade: user messages delete their assistant children
  let allMessageIds: string[]
  let allMessages: Message[]
  if (msg.role === 'user') {
    const topicMessages = selectMessagesForTopic(state, topicId)
    const groupMessages = topicMessages.filter((m) => m.askId === message.id)
    allMessageIds = [message.id, ...groupMessages.map((m) => m.id)]
    allMessages = [msg, ...groupMessages]
  } else {
    allMessageIds = [message.id]
    allMessages = [msg]
  }

  // Collect blocks for all messages
  const allBlockIds: string[] = []
  const allBlocks: MessageBlock[] = []
  for (const m of allMessages) {
    for (const blockId of m.blocks || []) {
      const block = state.messageBlocks.entities[blockId]
      if (block) {
        allBlockIds.push(blockId)
        allBlocks.push(block)
      }
    }
  }

  // Collect file reference deltas (for undo restoration)
  const fileReferenceDeltas: Array<{ fileId: string; delta: number }> = []
  for (const block of allBlocks) {
    if (block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE) {
      const file = block.file
      if (file) {
        fileReferenceDeltas.push({ fileId: file.id, delta: -1 })
      }
    }
  }

  // Calculate position info (for undo restoration to original position)
  const topicMessages = selectMessagesForTopic(state, topicId)
  const positionIndex = topicMessages.findIndex((m) => m.id === message.id)
  const nextMessage = positionIndex >= 0 ? topicMessages[positionIndex + 1] : undefined

  // Collect segment snapshots BEFORE deletion (needed for undo)
  const segmentSnapshots = collectSegmentSnapshots(getState, topicId, allMessageIds)

  // DB-first: delete from DB before dispatching to Redux (LOCK-001)
  let cleanup
  try {
    cleanup = await deleteMessagesFromDB(topicId, allMessageIds)
  } catch (error) {
    logger.error('[deleteSingleMessage] Failed to delete from DB', error as Error)
    return
  }

  // Consume file cleanup exactly once after commit, before Redux/file changes
  await consumeFileCleanupResult(cleanup)

  // Redux: remove from state only after DB delete succeeds
  dispatch(newMessagesActions.removeMessages({ topicId, messageIds: allMessageIds }))
  if (allBlockIds.length > 0) {
    dispatch(removeManyBlocks(allBlockIds))
  }

  // Transfer anchors after deletion (only if user message was deleted)
  if (msg.role === 'user') {
    const newState = getState()
    const messageIdsAfter = newState.messages.messageIdsByTopic[topicId] || []
    const entitiesAfter = newState.messages.entities
    const newGroupList = buildGroupList(messageIdsAfter, (id) => entitiesAfter[id])
    transferAnchorsAfterDeletion(dispatch, getState, topicId, oldGroupList, newGroupList)
  }

  // Sync segments after message deletion
  await syncSegmentsAfterMessageDeletion(dispatch, getState, topicId, allMessageIds)

  // LOCK-P5.3-1: No separate updateFileCount here. consumeFileCleanupResult
  // above already handled physical file cleanup via FileManager.deleteFile
  // which decrements Dexie files.count. A second dbService.updateFileCount
  // would double-decrement the same references.

  // Build undo data
  const groupAnchor: GroupAnchor = {
    messages: allMessages.map((m) => structuredClone(m)),
    blocks: allBlocks.map((b) => structuredClone(b)),
    positionIndex: positionIndex >= 0 ? positionIndex : 0,
    anchorMessageId: nextMessage?.id ?? null
  }

  const undoAction: DeleteUndoAction = {
    id: uuidv4(),
    type: 'delete',
    timestamp: Date.now(),
    targetTopicId: topicId,
    insertedMessageIds: allMessageIds,
    pastedMessagesSnapshot: [],
    pastedBlocksSnapshot: [],
    fileReferenceDeltas,
    groupAnchors: [groupAnchor],
    segmentSnapshots
  }

  dispatch(pushUndoAction(undoAction))

  logger.info(`[deleteSingleMessage] Deleted ${allMessageIds.length} messages from topic ${topicId}`)
}
