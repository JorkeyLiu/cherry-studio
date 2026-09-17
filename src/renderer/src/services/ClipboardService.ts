import { loggerService } from '@logger'
import { dbService } from '@renderer/services/db'
import type { AppDispatch, RootState } from '@renderer/store'
import { clearClipboard, setClipboard } from '@renderer/store/clipboard'
import { upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectLoadedMessagesForTopic } from '@renderer/store/newMessage'
import { executeDeleteMessagesWithDependents } from '@renderer/store/thunk/messageThunk'
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
import { convergeTopicSegmentCatalog, mapSegmentWireToTopicSegment } from '@renderer/utils/topicSegmentCatalog'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import type { InsertMessageGroupIntent, MessageBlockEntry } from '@shared/chatDb'
import { v4 as uuidv4 } from 'uuid'

const logger = loggerService.withContext('ClipboardService')

/**
 * Local-projection-only insertion index after a target message.
 * Never an authority index: used solely to splice the already-committed
 * pasted messages into the currently loaded list when the anchor is loaded.
 * Main resolves the authoritative position from the stable intent.
 */
function calculateLocalInsertIndex(messages: Message[], targetMessageId: string): number {
  const targetIndex = messages.findIndex((m) => m.id === targetMessageId || m.askId === targetMessageId)
  if (targetIndex === -1) return messages.length

  const targetMessage = messages[targetIndex]
  let insertIndex = targetIndex + 1

  // Determine the group key: user message uses its own ID, assistant uses askId
  const groupKey = targetMessage.role === 'user' ? targetMessage.id : targetMessage.askId

  if (groupKey) {
    // Match Main after-group-tail authority: scan the entire loaded
    // projection after the anchor and track the last loaded assistant with
    // the same group key (including non-contiguous members). Never stop at
    // intervening rows.
    for (let i = targetIndex + 1; i < messages.length; i++) {
      if (messages[i].role === 'assistant' && messages[i].askId === groupKey) {
        insertIndex = i + 1
      }
    }
  }

  return insertIndex
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
 * Authority-complete clipboard payload for copy/cut under windowed loading.
 *
 * Resolves the selected stable group IDs (`selectedGroupIds`, the same values
 * the edit-mode UI passes as group `askId`s) in one Main group-scoped
 * authority read (`chatdb:fetch-clipboard-groups`, never published to Redux)
 * with the canonical grouping semantics (user keys own ID, assistants join by
 * askId with an orphan-askId fallback group, system keys own ID; any other
 * role forms no selectable group). Ordering and `positionIndex` come from
 * Main authority order (first-message `sort_order`), blocks come from the
 * response-local block set (so outside-loaded members are complete), and
 * segment inclusion comes from the authority-enriched segment catalog (a
 * segment is included only when ALL its authority message IDs are selected —
 * completeness is never inferred from loaded positions).
 *
 * Returns null when no selected group resolves or any authority read fails —
 * callers publish nothing on null (no partial clipboard).
 */
async function buildAuthorityClipboardPayload(
  topicId: string,
  selectedGroupIds: string[]
): Promise<{ items: ClipboardItem[]; segmentSnapshots: ClipboardSegmentSnapshot[] } | null> {
  // Stable group IDs only (dedupe defense-in-depth; same contract as the
  // semantic delete path).
  const rootIds = [...new Set(selectedGroupIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (rootIds.length === 0) {
    return null
  }

  // Group-scoped authority read; never relies on or mutates Redux, never
  // fetches the whole topic. A selected ID absent from authority (deletion
  // race, unknown id, non-clipboard role, cross-topic id) is filtered by
  // Main and resolves to nothing here.
  let clipboard: Awaited<ReturnType<typeof dbService.fetchClipboardGroups>>
  try {
    clipboard = await dbService.fetchClipboardGroups({ topicId, groupIds: rootIds })
  } catch (error) {
    logger.error('[buildAuthorityClipboardPayload] Failed to fetch clipboard groups', error as Error)
    return null
  }

  if (clipboard.groups.length === 0 || clipboard.messages.length === 0) {
    for (const gid of rootIds) {
      if (!clipboard.groups.some((g) => g.groupId === gid)) {
        logger.warn(`[buildAuthorityClipboardPayload] Selected group ${gid} absent from authority; skipping`)
      }
    }
    return null
  }

  const messageById = new Map((clipboard.messages as unknown as Message[]).map((m) => [m.id, m]))
  const blocksByMessageId = new Map<string, MessageBlock[]>()
  for (const block of clipboard.blocks as unknown as MessageBlock[]) {
    const arr = blocksByMessageId.get(block.messageId)
    if (arr) {
      arr.push(block)
    } else {
      blocksByMessageId.set(block.messageId, [block])
    }
  }

  const items: ClipboardItem[] = []
  const allSelectedMessageIds: string[] = []

  // Main already returns groups in authority order; keep that order (paste
  // sorts by positionIndex, so document order is preserved regardless).
  for (const group of clipboard.groups) {
    const groupMessages: Message[] = []
    for (const mid of group.messageIds) {
      const msg = messageById.get(mid)
      if (msg) {
        groupMessages.push(msg)
      } else {
        logger.warn(`[buildAuthorityClipboardPayload] Message ${mid} of group ${group.groupId} absent; skipping`)
      }
    }
    if (groupMessages.length === 0) {
      continue
    }
    const clonedMessages: Message[] = structuredClone(groupMessages)
    const clonedBlocks: MessageBlock[] = []
    for (const msg of groupMessages) {
      allSelectedMessageIds.push(msg.id)
      for (const block of blocksByMessageId.get(msg.id) ?? []) {
        clonedBlocks.push(structuredClone(block))
      }
    }

    // Authority order/group position; the persisted wire shape is unchanged
    // (no clipboard format migration).
    items.push({
      originalAskId: group.groupId,
      messages: clonedMessages,
      blocks: clonedBlocks,
      positionIndex: group.positionIndex
    })
  }

  if (items.length === 0) {
    return null
  }

  // Authority-enriched segment catalog membership (caller-local read, never
  // published). A segment snapshot is captured only when every authority
  // member message is in the complete selected set.
  const segmentSnapshots: ClipboardSegmentSnapshot[] = []
  try {
    const wires = await dbService.listSegments(topicId)
    const selectedSet = new Set(allSelectedMessageIds)
    for (const wire of wires) {
      const memberIds = wire.messageIds ?? []
      if (memberIds.length > 0 && memberIds.every((id) => selectedSet.has(id))) {
        segmentSnapshots.push({
          originalSegmentId: wire.id,
          name: wire.name ?? '',
          color: wire.color || getSegmentColor(wire.id),
          originalMessageIds: [...memberIds]
        })
      }
    }
  } catch (error) {
    logger.error(
      '[buildAuthorityClipboardPayload] Failed to list authority segments; publishing nothing',
      error as Error
    )
    return null
  }

  return { items, segmentSnapshots }
}

/**
 * Copy selected message groups to clipboard.
 *
 * Authority-complete under windowed loading: a selected group straddling the
 * loaded projection is copied with its complete ordered messages and blocks.
 * Read-only apart from the clipboard publication itself — Redux message and
 * block projections are never mutated. Returns the number of messages copied.
 */
export async function copyMessages(
  dispatch: AppDispatch,
  topicId: string,
  selectedGroupIds: string[]
): Promise<number> {
  const payload = await buildAuthorityClipboardPayload(topicId, selectedGroupIds)

  if (!payload || payload.items.length === 0) {
    return 0
  }

  dispatch(
    setClipboard({
      mode: 'copy',
      items: payload.items,
      sourceTopicId: topicId,
      segmentSnapshots: payload.segmentSnapshots
    })
  )

  const totalCount = payload.items.reduce((sum, item) => sum + item.messages.length, 0)
  logger.info(
    `[copyMessages] Copied ${totalCount} messages from ${payload.items.length} groups, ${payload.segmentSnapshots.length} segment snapshots`
  )
  return totalCount
}

/**
 * Cut selected message groups to clipboard.
 *
 * Same authority-complete clipboard publication as copy (mode `cut`); the
 * source deletion itself happens at paste time through the single semantic
 * delete transaction there. Read-only apart from the clipboard publication —
 * Redux message and block projections are never mutated. Returns the number
 * of messages cut.
 */
export async function cutMessages(dispatch: AppDispatch, topicId: string, selectedGroupIds: string[]): Promise<number> {
  const payload = await buildAuthorityClipboardPayload(topicId, selectedGroupIds)

  if (!payload || payload.items.length === 0) {
    return 0
  }

  dispatch(
    setClipboard({
      mode: 'cut',
      items: payload.items,
      sourceTopicId: topicId,
      segmentSnapshots: payload.segmentSnapshots
    })
  )

  const totalCount = payload.items.reduce((sum, item) => sum + item.messages.length, 0)
  logger.info(
    `[cutMessages] Cut ${totalCount} messages from ${payload.items.length} groups, ${payload.segmentSnapshots.length} segment snapshots`
  )
  return totalCount
}

/**
 * Paste clipboard content into the target topic with a stable insertion intent.
 * Returns the number of message groups pasted.
 *
 * Authority: the renderer derives exactly one stable intent from target
 * semantics (selected target group → after-group-tail with that stable ID;
 * explicit no-target → topic-tail) and sends it to Main in ONE
 * `insertMessageGroups` call. No loaded-projection search ever produces a DB
 * index. A supplied target ID absent from the loaded projection is still
 * sent to Main unchanged (no loaded-tail fallback for persistence).
 * Local projection stays bounded: messages are spliced into the loaded list
 * only when the anchor/group is loaded (at its loaded group tail) or for a
 * topic-tail append; an outside-loaded anchor injects nothing and never
 * replaces the loaded list with an assumed whole topic.
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

  // Pre-batch ordered target loaded projection (captured BEFORE any DB or
  // Redux mutation; used ONLY for the bounded local projection commit, never
  // as an authority index).
  const targetMessages = (selectLoadedMessagesForTopic(state, targetTopicId) ?? []) as Message[]

  // Stable insertion intent for Main (authority). Never derived from loaded
  // positions: the supplied stable target ID travels unchanged even when it
  // is absent from the loaded projection.
  const stableIntent: InsertMessageGroupIntent =
    typeof targetMessageId === 'string' && targetMessageId.length > 0
      ? { kind: 'after-group-tail', messageId: targetMessageId }
      : { kind: 'topic-tail' }

  // Track file reference deltas for undo
  const fileReferenceDeltas: Array<{ fileId: string; delta: number }> = []
  const insertedMessageIds: string[] = []
  const allInsertedMessages: Message[] = []
  const allInsertedBlocks: MessageBlock[] = []

  // Cut source restoration material arrives from the single semantic delete
  // below (authority undo parts) — never from loaded-projection derivation,
  // so a straddling selection keeps its outside-loaded members for undo.
  // No pre-paste loaded read is needed: stable restore intents stay correct
  // for same-topic cut-paste because undo/redo resolve by stable anchor, not
  // by numeric position.
  let sourceGroupAnchors: GroupAnchor[] = []
  let sourceSegmentSnapshots: SegmentSnapshot[] = []

  // ID mapping: original message ID → new message ID
  const idMapping = new Map<string, string>()

  // Ordered batch entries for the ONE `pasteMessagesToTopic` call.
  const entries: Array<{ message: Message; blocks: MessageBlock[] }> = []

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

      entries.push({ message: newMessage, blocks: clonedBlocksForMsg })
      allInsertedMessages.push(newMessage)
      allInsertedBlocks.push(...clonedBlocksForMsg)
      insertedMessageIds.push(newMsgId)
    }
  }

  // Active-topic projection precondition (correctness fix): this guard is a
  // PURE renderer-state check against persistence — it runs BEFORE the DB
  // batch call so a topic-switch race cannot commit pasted rows and then fail
  // before renderer projection. Projection still occurs only after DB success
  // (DB-first unchanged).
  //
  // `pasteMessages` is only reachable from edit-mode in the ACTIVE topic
  // (useEditMode.handlePaste ← EditModeProvider topic.id in the Messages
  // view), so `targetTopicId` === `state.messages.currentTopicId` always
  // holds here. `messagesReceived` replaces `messageIdsByTopic[topicId]` with
  // the supplied ordered list AND sets `currentTopicId = topicId`; under this
  // precondition the active-topic side effect is a no-op, making the single
  // ordered projection commit safe. The assertion makes the precondition
  // mechanical: a future non-active-topic call fails loudly instead of
  // silently re-pointing the active topic.
  //
  // Bounded projection contract (same as the existing `messageGroupReorder`
  // `messagesReceived` usage): the list is a consistent pre-batch snapshot
  // spliced with the regenerated IDs only at a locally visible point, so any
  // message a NON-paste path appends to this same topic during the single
  // batch IPC round-trip is not carried into the replacement list. The paste
  // runs under the edit-mode `isProcessing` lock and targets only the active
  // topic, so the exposure window is one IPC round-trip — the identical
  // bounded contract the reorder projection already established.
  const activeTopicId = getState().messages.currentTopicId
  if (activeTopicId !== targetTopicId) {
    logger.error(
      `[pasteMessages] messagesReceived active-topic precondition failed: target ${targetTopicId}, active ${String(activeTopicId)}`
    )
    throw new Error(
      `[pasteMessages] cannot project paste into non-active topic ${targetTopicId} (active: ${String(activeTopicId)})`
    )
  }

  // DB-first (LOCK-001): ONE atomic stable insertion BEFORE any Redux commit.
  // If the batch fails, Redux is never touched and nothing is projected.
  try {
    await dbService.insertMessageGroups(targetTopicId, [
      { entries: entries as unknown as MessageBlockEntry[], intent: stableIntent }
    ])
  } catch (error) {
    logger.error('[pasteMessages] Failed to persist paste batch to DB', error as Error)
    throw new Error(`[pasteMessages] DB batch write failed for ${entries.length} entries`)
  }

  // Bounded local projection: splice only when the insertion point is locally
  // visible. Anchored intents insert at the loaded group tail when the anchor
  // is loaded; an outside-loaded anchor injects nothing. Topic-tail appends
  // to the loaded end while preserving existing loaded order (never a
  // whole-topic assumption).
  let localInsertIndex: number | null = null
  if (stableIntent.kind === 'topic-tail') {
    localInsertIndex = targetMessages.length
  } else {
    const anchorLoaded =
      targetMessages.some((m) => m.id === stableIntent.messageId) ||
      targetMessages.some((m) => m.askId === stableIntent.messageId)
    if (anchorLoaded) {
      localInsertIndex = Math.max(
        0,
        Math.min(calculateLocalInsertIndex(targetMessages, stableIntent.messageId), targetMessages.length)
      )
    }
  }
  if (localInsertIndex !== null) {
    const postBatchMessages = [...targetMessages]
    postBatchMessages.splice(localInsertIndex, 0, ...allInsertedMessages)
    dispatch(newMessagesActions.messagesReceived({ topicId: targetTopicId, messages: postBatchMessages }))
  }

  // ONE block commit for all pasted blocks (after the message projection).
  if (allInsertedBlocks.length > 0) {
    dispatch(upsertManyBlocks(allInsertedBlocks))
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

      // Create new segment with new ID in target topic.
      // DB-first: collect the Main wire mapping; Redux convergence happens
      // once below via a single list+replace so shifted siblings converge.
      const newId = uuidv4()
      const wire = await dbService.upsertSegment(newId, targetTopicId, clipSnap.name, newMessageIds, clipSnap.color)
      const newSegment = mapSegmentWireToTopicSegment(wire)
      if (wire.name == null) newSegment.name = clipSnap.name
      targetSegmentSnapshots.push(newSegment)
    }

    // Batch convergence: exactly one list+replace for the target topic.
    // No per-item stale adds. listSegments failure never rolls back the
    // successful Main upserts: keep per-wire adds so pasted segments stay visible.
    if (targetSegmentSnapshots.length > 0) {
      try {
        await convergeTopicSegmentCatalog(dispatch, targetTopicId)
      } catch (error) {
        logger.warn('[pasteMessages] segment catalog convergence failed, keeping per-wire fallback', error as Error)
        for (const seg of targetSegmentSnapshots) dispatch(addSegment(seg))
      }
    }

    logger.info(
      `[pasteMessages] Reconstructed ${targetSegmentSnapshots.length} segments from ${clipboardSegmentSnapshots.length} clipboard snapshots`
    )
  }

  // If cut mode: remove source messages through the single semantic delete
  // transaction. Stable member roots only — ALL complete clipboard member
  // message IDs (deduped, authority order), never just `originalAskId`. Main
  // expands user dependents (so outside-loaded siblings are deleted too),
  // dedupes overlapping expansions, and handles orphan-assistant roots
  // directly (a user root alone cannot expand an orphan group). The helper
  // returns the full authority undo snapshot (actual expanded deleted IDs as
  // restore groups + segment snapshots). It owns file cleanup, loaded-
  // intersection removal, authority segment convergence, and anchor transfer,
  // so no second delete protocol lives here. Multi-group cuts stay one
  // transaction. A failed source delete keeps the existing swallow semantics:
  // the successful insertion stands, the clipboard is still cleared, and the
  // undo action carries empty source anchors/roots (nothing was deleted).
  let sourceRootIds: string[] = []
  if (mode === 'cut' && sourceTopicId) {
    const stableRoots = [
      ...new Set(
        items.flatMap((item) => item.messages.map((m) => m.id)).filter((id) => typeof id === 'string' && id.length > 0)
      )
    ]

    if (stableRoots.length > 0) {
      try {
        const result = await executeDeleteMessagesWithDependents(dispatch, getState, sourceTopicId, stableRoots)
        sourceGroupAnchors = result.undoParts.groupAnchors
        sourceSegmentSnapshots = result.undoParts.segmentSnapshots
        sourceRootIds = [...stableRoots]
      } catch (error) {
        logger.error('[pasteMessages] Failed to delete source messages (semantic cut delete)', error as Error)
      }
    }

    // LOCK-P5.3-1: No separate updateFileCount for source blocks here.
    // consumeFileCleanupResult inside the helper already handled physical
    // file cleanup via FileManager.deleteFile which decrements Dexie
    // files.count.

    dispatch(clearClipboard())
  }

  // Create undo action
  // Calculate anchor: first non-pasted message after the locally visible paste
  // region when projected; otherwise after the loaded end. The stable redo
  // authority is `stableIntent` (never the numeric index).
  const finalTargetMessages = (selectLoadedMessagesForTopic(getState(), targetTopicId) ?? []) as Message[]
  const afterInsertIndex = localInsertIndex ?? finalTargetMessages.length
  const insertedIdSet = new Set(insertedMessageIds)
  const anchorMessageId = findAnchorAfterPosition(finalTargetMessages, afterInsertIndex, insertedIdSet)
  const legacyPositionIndex = localInsertIndex ?? targetMessages.length

  if (mode === 'cut' && sourceTopicId) {
    const undoAction: CutPasteUndoAction = {
      id: uuidv4(),
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: targetTopicId,
      insertedMessageIds,
      targetInsertPositionIndex: legacyPositionIndex,
      targetAnchorMessageId: anchorMessageId,
      targetInsertIntent: stableIntent,
      sourceTopicId,
      sourceRootIds,
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
      targetInsertPositionIndex: legacyPositionIndex,
      targetAnchorMessageId: anchorMessageId,
      targetInsertIntent: stableIntent,
      targetSegmentSnapshots,
      pastedMessagesSnapshot: allInsertedMessages,
      pastedBlocksSnapshot: allInsertedBlocks,
      fileReferenceDeltas
    }
    dispatch(pushUndoAction(undoAction))
  }

  logger.info(`[pasteMessages] Pasted ${items.length} groups with stable intent ${stableIntent.kind}`)
  return items.length
}

/**
 * Delete selected message groups in edit mode.
 * Returns the number of messages deleted (authority-expanded count).
 *
 * Unified semantic path: stable selected group IDs are passed as root IDs
 * ONLY — Main expands user dependents, deletes atomically, and returns the
 * full authority undo snapshot. No loaded-projection cascade derivation, no
 * window-relative anchors, no loaded block/segment snapshots as undo source.
 * DB failure leaves Redux/anchors untouched and pushes no undo.
 */
export async function deleteSelectedMessages(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  selectedGroupIds: string[]
): Promise<number> {
  // Stable root IDs only (dedupe defense-in-depth; Main rejects duplicates).
  const rootIds = [...new Set(selectedGroupIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (rootIds.length === 0) {
    return 0
  }

  // Unified semantic delete: DB-first, then one converged projection update
  // (cleanup consume, loaded-intersection removal, full segment replace,
  // authority-key anchor transfer) inside the helper.
  let result: Awaited<ReturnType<typeof executeDeleteMessagesWithDependents>>
  try {
    result = await executeDeleteMessagesWithDependents(dispatch, getState, topicId, rootIds)
  } catch (error) {
    logger.error('[deleteSelectedMessages] Failed to delete from DB', error as Error)
    return 0
  }

  // LOCK-P5.3-1: No separate updateFileCount here. consumeFileCleanupResult
  // inside the helper already handled physical file cleanup via
  // FileManager.deleteFile which decrements Dexie files.count. A second
  // dbService.updateFileCount would double-decrement the same references.

  // Undo from the authority snapshot (never loaded projection).
  const undoAction: DeleteUndoAction = {
    id: uuidv4(),
    type: 'delete',
    timestamp: Date.now(),
    targetTopicId: topicId,
    rootMessageIds: rootIds,
    insertedMessageIds: result.response.deletedMessageIds,
    pastedMessagesSnapshot: [],
    pastedBlocksSnapshot: [],
    fileReferenceDeltas: result.undoParts.fileReferenceDeltas,
    groupAnchors: result.undoParts.groupAnchors,
    segmentSnapshots: result.undoParts.segmentSnapshots
  }

  dispatch(pushUndoAction(undoAction))

  logger.info(
    `[deleteSelectedMessages] Deleted ${result.response.deletedMessageIds.length} messages from ${rootIds.length} groups`
  )
  return result.response.deletedMessageIds.length
}

/**
 * Delete a single message with undo support.
 *
 * Unified semantic path: the message ID is passed as the single stable root
 * — Main resolves dependents (user + same-askId assistants, or single
 * non-user) and returns the authority undo snapshot. The menu confirm dialog
 * and trace cleanup stay at the Menu/hook layer; this function ends at the
 * semantic command. DB failure leaves Redux/anchors untouched and pushes no
 * undo.
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

  // Unified semantic delete: DB-first, then one converged projection update
  // inside the helper (cleanup consume, loaded-intersection removal, full
  // segment replace, authority-key anchor transfer).
  let result: Awaited<ReturnType<typeof executeDeleteMessagesWithDependents>>
  try {
    result = await executeDeleteMessagesWithDependents(dispatch, getState, topicId, [message.id])
  } catch (error) {
    logger.error('[deleteSingleMessage] Failed to delete from DB', error as Error)
    return
  }

  // LOCK-P5.3-1: No separate updateFileCount here. consumeFileCleanupResult
  // inside the helper already handled physical file cleanup via
  // FileManager.deleteFile which decrements Dexie files.count. A second
  // dbService.updateFileCount would double-decrement the same references.

  // Undo from the authority snapshot (never loaded projection).
  const undoAction: DeleteUndoAction = {
    id: uuidv4(),
    type: 'delete',
    timestamp: Date.now(),
    targetTopicId: topicId,
    rootMessageIds: [message.id],
    insertedMessageIds: result.response.deletedMessageIds,
    pastedMessagesSnapshot: [],
    pastedBlocksSnapshot: [],
    fileReferenceDeltas: result.undoParts.fileReferenceDeltas,
    groupAnchors: result.undoParts.groupAnchors,
    segmentSnapshots: result.undoParts.segmentSnapshots
  }

  dispatch(pushUndoAction(undoAction))

  logger.info(
    `[deleteSingleMessage] Deleted ${result.response.deletedMessageIds.length} messages from topic ${topicId}`
  )
}
